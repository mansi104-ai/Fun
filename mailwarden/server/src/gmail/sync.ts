import type { gmail_v1 } from "googleapis";
import { config } from "../config.js";
import { db, now } from "../db.js";
import { hashSubject, newId } from "../lib/crypto.js";
import { domainOf, gmailFor, parseFrom } from "./client.js";

export interface SyncProgress {
  scanned: number;
  senders: number;
  bytes: number;
  done: boolean;
  /**
   * "full" is the multi-minute first scan; "incremental" is a few seconds.
   * The UI needs to know which so it can set the right expectation rather than
   * showing a progress bar that finishes before it renders.
   */
  mode: "full" | "incremental";
  /** Set on an incremental pass: what actually changed since last time. */
  added?: number;
  removed?: number;
  updated?: number;
  error?: string;
}

const progress = new Map<string, SyncProgress>();
export const syncProgress = (accountId: string): SyncProgress | undefined => progress.get(accountId);

/** Headers we request. Anything not listed here never reaches our process. */
const HEADERS = ["From", "Subject", "List-Unsubscribe", "Precedence"];

async function mapLimited<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const i = cursor++;
      out[i] = await fn(items[i]!);
    }
  });
  await Promise.all(workers);
  return out;
}

const insertMeta = db.prepare(`
  INSERT INTO messages_meta
    (account_id, message_id, thread_id, sender_key, subject_hash, internal_date,
     size_bytes, labels, is_unread, has_unsubscribe)
  VALUES (@account_id, @message_id, @thread_id, @sender_key, @subject_hash, @internal_date,
          @size_bytes, @labels, @is_unread, @has_unsubscribe)
  ON CONFLICT(account_id, message_id) DO UPDATE SET
    labels = excluded.labels, is_unread = excluded.is_unread
`);

export type Gmail = Awaited<ReturnType<typeof gmailFor>>;

/** Turns raw Gmail message metadata into a messages_meta row. */
function toRow(accountId: string, msg: gmail_v1.Schema$Message) {
  const headers = msg.payload?.headers ?? [];
  const header = (name: string): string | undefined =>
    headers.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value ?? undefined;

  const from = parseFrom(header("From"));
  if (!from) return null;

  const labels = msg.labelIds ?? [];
  const subject = header("Subject");

  return {
    account_id: accountId,
    message_id: msg.id!,
    thread_id: msg.threadId ?? null,
    sender_key: from.key,
    subject_hash: subject ? hashSubject(subject) : null,
    internal_date: Number(msg.internalDate ?? 0),
    size_bytes: msg.sizeEstimate ?? 0,
    labels: labels.join(","),
    is_unread: labels.includes("UNREAD") ? 1 : 0,
    has_unsubscribe:
      header("List-Unsubscribe") || header("Precedence")?.toLowerCase() === "bulk" ? 1 : 0,
    _name: from.name,
  };
}

/** Fetches metadata for a set of ids. Missing/deleted ids yield null, not an error. */
async function fetchMetadata(gmail: Gmail, ids: string[]): Promise<gmail_v1.Schema$Message[]> {
  const details = await mapLimited(ids, config.sync.metadataConcurrency, async (id) => {
    try {
      const res = await gmail.users.messages.get({
        userId: "me",
        id,
        format: "metadata",
        metadataHeaders: HEADERS,
      });
      return res.data;
    } catch {
      return null;
    }
  });
  return details.filter((d): d is gmail_v1.Schema$Message => Boolean(d?.id));
}

/** Writes metadata rows idempotently and returns the bytes they account for. */
function persistRows(acct: string, rows: NonNullable<ReturnType<typeof toRow>>[]): number {
  let bytes = 0;
  const setName = db.prepare(
    `UPDATE senders SET display_name = COALESCE(display_name, ?)
     WHERE account_id = ? AND sender_key = ?`,
  );
  db.transaction(() => {
    for (const r of rows) {
      const { _name, ...cols } = r;
      insertMeta.run(cols);
      bytes += cols.size_bytes;
      if (_name) setName.run(_name, acct, cols.sender_key);
    }
  })();
  return bytes;
}

/**
 * Sync entry point. Chooses the cheapest correct strategy.
 *
 * The first scan of a 6,000-message mailbox takes about three minutes. Paying
 * that again on every visit is the single worst thing about the agent, and it
 * also blocks scheduled re-scans (roadmap 41) from ever being viable. Gmail's
 * history API exists precisely for this: given the `historyId` we stored last
 * time, it returns only what changed.
 *
 * Falls back to a full sync whenever incremental cannot be trusted — no stored
 * cursor, a cursor Gmail has aged out (it keeps roughly a week), or an explicit
 * `force`. Falling back is always safe; skipping a full sync when one was
 * needed is not.
 */
export async function runSync(
  accountId: string,
  maxMessages?: number,
  opts: { force?: boolean } = {},
): Promise<void> {
  const stored = db
    .prepare(`SELECT history_id FROM accounts WHERE id = ?`)
    .get(accountId) as { history_id: string | null } | undefined;

  const hasHistory = Boolean(stored?.history_id);
  const hasMessages =
    (db.prepare(`SELECT COUNT(*) c FROM messages_meta WHERE account_id = ?`).get(accountId) as {
      c: number;
    }).c > 0;

  if (!opts.force && hasHistory && hasMessages) {
    const ok = await tryIncrementalSync(accountId, stored!.history_id!);
    if (ok) return;
    console.log(`[sync] incremental not possible for ${accountId}; falling back to full scan`);
  }
  await fullSync(accountId, maxMessages);
}

/**
 * Applies only what changed since `startHistoryId`.
 *
 * Returns false — rather than throwing — when Gmail rejects the cursor as too
 * old (HTTP 404), so the caller can fall back to a full scan. That is a normal
 * outcome for an account left alone for a week, not an error.
 */
async function tryIncrementalSync(accountId: string, startHistoryId: string): Promise<boolean> {
  const state: SyncProgress = {
    scanned: 0, senders: 0, bytes: 0, done: false,
    mode: "incremental", added: 0, removed: 0, updated: 0,
  };
  progress.set(accountId, state);
  db.prepare(`UPDATE accounts SET sync_state = 'running' WHERE id = ?`).run(accountId);

  try {
    const gmail = await gmailFor(accountId);

    // Ids that need their metadata (re)read, and ids that are gone. A message
    // can appear in both — deletion wins, which is why they are separate sets
    // and the delete is applied last.
    const touched = new Set<string>();
    const removed = new Set<string>();
    let pageToken: string | undefined;
    let latestHistoryId = startHistoryId;

    do {
      let page;
      try {
        page = await gmail.users.history.list({
          userId: "me",
          startHistoryId,
          pageToken,
          maxResults: 500,
          historyTypes: ["messageAdded", "messageDeleted", "labelAdded", "labelRemoved"],
        });
      } catch (err) {
        // 404 = the cursor has aged out of Gmail's ~7-day history window.
        const status = (err as { code?: number; status?: number })?.code ??
          (err as { status?: number })?.status;
        if (status === 404) {
          db.prepare(`UPDATE accounts SET sync_state = 'idle' WHERE id = ?`).run(accountId);
          return false;
        }
        throw err;
      }

      for (const h of page.data.history ?? []) {
        for (const a of h.messagesAdded ?? []) if (a.message?.id) touched.add(a.message.id);
        for (const d of h.messagesDeleted ?? []) if (d.message?.id) removed.add(d.message.id);
        for (const l of [...(h.labelsAdded ?? []), ...(h.labelsRemoved ?? [])]) {
          if (l.message?.id) touched.add(l.message.id);
        }
      }
      if (page.data.historyId) latestHistoryId = page.data.historyId;
      pageToken = page.data.nextPageToken ?? undefined;
    } while (pageToken);

    for (const id of removed) touched.delete(id);

    // A label change on a message we already hold is the common case, so
    // re-reading metadata is both correct and cheap — these sets are tens of
    // ids, not thousands. Correctness beats cleverness here: reconstructing
    // label state from history deltas alone drifts on any missed page.
    const fetched = await fetchMetadata(gmail, [...touched]);
    const rows = fetched
      .map((m) => toRow(accountId, m))
      .filter((r): r is NonNullable<typeof r> => r !== null);

    const knownBefore = new Set(
      (
        db
          .prepare(`SELECT message_id FROM messages_meta WHERE account_id = ?`)
          .all(accountId) as { message_id: string }[]
      ).map((r) => r.message_id),
    );

    state.bytes = persistRows(accountId, rows);
    state.added = rows.filter((r) => !knownBefore.has(r.message_id)).length;
    state.updated = rows.length - state.added;

    if (removed.size > 0) {
      db.transaction(() => {
        const del = db.prepare(`DELETE FROM messages_meta WHERE account_id = ? AND message_id = ?`);
        for (const id of removed) del.run(accountId, id);
      })();
    }
    state.removed = removed.size;
    state.scanned = rows.length + removed.size;

    aggregateSenders(accountId);
    pruneEmptySenders(accountId);
    state.senders = senderCount(accountId);
    state.done = true;

    db.prepare(
      `UPDATE accounts SET sync_state = 'idle', last_sync_at = ?, history_id = ? WHERE id = ?`,
    ).run(now(), latestHistoryId, accountId);

    console.log(
      `[sync] incremental ${accountId}: +${state.added} ~${state.updated} -${state.removed}`,
    );
    return true;
  } catch (err) {
    state.done = true;
    state.error = err instanceof Error ? err.message : String(err);
    db.prepare(`UPDATE accounts SET sync_state = 'error' WHERE id = ?`).run(accountId);
    throw err;
  }
}

/**
 * Flags every message carrying an attachment, using Gmail's own search.
 *
 * Done as a separate id-only listing rather than inferred from message size:
 * size is a bad proxy, because image-heavy marketing mail is large and
 * worthless while a 40 KB PDF invoice is small and irreplaceable. Listing ids
 * is cheap — 500 per page, no per-message fetch — so this costs a handful of
 * calls against a scan that already makes thousands.
 *
 * Failure here is deliberately non-fatal but loud: a scan that succeeded is
 * more useful than none, and the guard layer treats "unknown" as "no
 * attachment", so the only cost is losing one protective signal.
 */
async function markAttachments(accountId: string, gmail: Gmail): Promise<void> {
  try {
    let pageToken: string | undefined;
    let flagged = 0;
    const stmt = db.prepare(
      `UPDATE messages_meta SET has_attachment = 1 WHERE account_id = ? AND message_id = ?`,
    );

    do {
      const list = await gmail.users.messages.list({
        userId: "me",
        maxResults: 500,
        pageToken,
        q: "has:attachment -in:chats -in:draft",
      });
      const ids = (list.data.messages ?? []).map((m) => m.id!).filter(Boolean);
      db.transaction(() => {
        for (const id of ids) stmt.run(accountId, id);
      })();
      flagged += ids.length;
      pageToken = list.data.nextPageToken ?? undefined;
    } while (pageToken);

    console.log(`[sync] flagged ${flagged} messages with attachments`);
  } catch (err) {
    console.error("[sync] attachment pass failed; attachments will not be protected:", err);
  }
}

const senderCount = (accountId: string): number =>
  (db.prepare(`SELECT COUNT(*) c FROM senders WHERE account_id = ?`).get(accountId) as { c: number })
    .c;

/**
 * Drops sender rows whose last message is gone. Without this, a sender the user
 * fully cleaned out lingers forever with a stale count, and the guard layer's
 * UNKNOWN_SENDER check starts firing on ghosts.
 */
function pruneEmptySenders(accountId: string): void {
  db.prepare(
    `DELETE FROM senders
     WHERE account_id = ?
       AND user_protected = 0
       AND sender_key NOT IN (SELECT DISTINCT sender_key FROM messages_meta WHERE account_id = ?)`,
  ).run(accountId, accountId);
}

/**
 * Full metadata sync.
 *
 * `format: "metadata"` with an explicit header allowlist is the narrowest read
 * the Gmail API offers — bodies and attachments are never transferred, which is
 * what lets us claim (and prove) that we cannot read message content.
 */
async function fullSync(accountId: string, maxMessages?: number): Promise<void> {
  const state: SyncProgress = { scanned: 0, senders: 0, bytes: 0, done: false, mode: "full" };
  progress.set(accountId, state);
  db.prepare(`UPDATE accounts SET sync_state = 'running' WHERE id = ?`).run(accountId);

  try {
    const gmail = await gmailFor(accountId);
    const cap = maxMessages ?? config.sync.maxMessagesFreeTier;
    let pageToken: string | undefined;

    /**
     * Read the cursor BEFORE listing, not after.
     *
     * A full scan takes minutes, and mail arriving during it would be invisible
     * to every future incremental pass if we captured the cursor at the end.
     * Taking it first means the next pass re-reads a little we already have,
     * which is harmless — the upsert is idempotent.
     */
    const startHistoryId = (await gmail.users.getProfile({ userId: "me" })).data.historyId ?? null;

    outer: while (state.scanned < cap) {
      const list = await gmail.users.messages.list({
        userId: "me",
        maxResults: config.sync.pageSize,
        pageToken,
        // Exclude what we can never action anyway — keeps quota on useful mail.
        q: "-in:chats -in:draft",
      });

      const ids = (list.data.messages ?? []).map((m) => m.id!).filter(Boolean);
      if (ids.length === 0) break;

      const rows = (await fetchMetadata(gmail, ids))
        .map((msg) => toRow(accountId, msg))
        .filter((r): r is NonNullable<typeof r> => r !== null);

      state.bytes += persistRows(accountId, rows);
      state.scanned += rows.length;
      pageToken = list.data.nextPageToken ?? undefined;
      if (!pageToken) break outer;
    }

    await markAttachments(accountId, gmail);
    aggregateSenders(accountId);
    state.senders = senderCount(accountId);
    state.done = true;

    db.prepare(
      `UPDATE accounts SET sync_state = 'idle', last_sync_at = ?, history_id = ? WHERE id = ?`,
    ).run(now(), startHistoryId, accountId);
  } catch (err) {
    state.done = true;
    state.error = err instanceof Error ? err.message : String(err);
    db.prepare(`UPDATE accounts SET sync_state = 'error' WHERE id = ?`).run(accountId);
    throw err;
  }
}

/**
 * Minimum share of a sender's mail that must sit in threads you replied to
 * before we treat them as a correspondent.
 *
 * Measured against a real 6,000-message mailbox: genuine correspondents score
 * 100%, while bulk senders that picked up one stray reply score 0–9%. A binary
 * "any reply at all" test wrongly locked 15 bulk senders covering 1,964
 * messages — a third of the mailbox — because one auto-reply or forward is
 * enough to trip it.
 */
const REPLY_RATIO_THRESHOLD = 0.25;

/**
 * Addresses that cannot receive a reply by construction. A thread that appears
 * to contain a reply to one of these is a forward or a Gmail threading
 * artifact, never a conversation.
 */
const UNREPLIABLE = /^(no-?reply|do-?not-?reply|donotreply|noreply|notifications?|mailer-daemon)[.+@-]/i;

/**
 * Collapses messages_meta into one row per sender. This is the step that turns
 * a 40,000-decision problem into a 300-decision one, and it is what makes both
 * the UX and the inference budget work.
 */
export function aggregateSenders(accountId: string): void {
  const rows = db
    .prepare(
      `SELECT sender_key,
              COUNT(*)                              AS message_count,
              SUM(is_unread)                        AS unread_count,
              SUM(size_bytes)                       AS total_bytes,
              MIN(internal_date)                    AS first_seen,
              MAX(internal_date)                    AS last_seen,
              MAX(has_unsubscribe)                  AS has_unsubscribe,
              COUNT(DISTINCT subject_hash)          AS distinct_subjects,
              MAX(CASE WHEN labels LIKE '%SENT%' THEN 1 ELSE 0 END) AS replied
       FROM messages_meta
       WHERE account_id = ?
         -- Trashed mail is on its way out of the mailbox; counting it keeps
         -- every total in the UI at its pre-cleanup value, so a successful
         -- cleanup looks like it did nothing. Archived mail still counts: it
         -- remains in All Mail and still occupies the storage quota.
         AND labels NOT LIKE '%TRASH%'
       GROUP BY sender_key`,
    )
    .all(accountId) as {
    sender_key: string;
    message_count: number;
    unread_count: number;
    total_bytes: number;
    first_seen: number;
    last_seen: number;
    has_unsubscribe: number;
    distinct_subjects: number;
    replied: number;
  }[];

  // The user's own address appears in messages_meta because sent mail is
  // synced (we need it to detect replies) — but it is not a sender they can
  // act on, so it must never become a sender row.
  const self = (
    db.prepare(`SELECT email FROM accounts WHERE id = ?`).get(accountId) as
      | { email: string }
      | undefined
  )?.email.toLowerCase();

  /**
   * Reply detection, measured as a RATIO rather than a boolean.
   *
   * "Has the user ever replied?" is the intuitive test and it is wrong: one
   * stray reply to a marketing blast permanently locks every message that
   * sender ever sends. "What share of their mail is conversational?" separates
   * a colleague (≈100%) from a newsletter that caught one reply (≈1%).
   */
  const replyCounts = new Map<string, number>(
    (
      db
        .prepare(
          `SELECT m.sender_key, COUNT(*) AS c FROM messages_meta m
           WHERE m.account_id = ? AND m.thread_id IN (
             SELECT thread_id FROM messages_meta
             WHERE account_id = ? AND labels LIKE '%SENT%'
           )
           GROUP BY m.sender_key`,
        )
        .all(accountId, accountId) as { sender_key: string; c: number }[]
    ).map((r) => [r.sender_key, r.c]),
  );

  const isCorrespondent = (senderKey: string, total: number): boolean => {
    if (UNREPLIABLE.test(senderKey.split("@")[0] + "@")) return false;
    const replied = replyCounts.get(senderKey) ?? 0;
    if (replied === 0) return false;
    return replied / total >= REPLY_RATIO_THRESHOLD;
  };

  const upsert = db.prepare(`
    INSERT INTO senders
      (id, account_id, sender_key, domain, message_count, unread_count, total_bytes,
       first_seen, last_seen, has_unsubscribe, user_replied)
    VALUES (@id, @account_id, @sender_key, @domain, @message_count, @unread_count, @total_bytes,
            @first_seen, @last_seen, @has_unsubscribe, @user_replied)
    ON CONFLICT(account_id, sender_key) DO UPDATE SET
      message_count = excluded.message_count,
      unread_count = excluded.unread_count,
      total_bytes = excluded.total_bytes,
      first_seen = excluded.first_seen,
      last_seen = excluded.last_seen,
      has_unsubscribe = excluded.has_unsubscribe,
      user_replied = excluded.user_replied
  `);

  db.transaction(() => {
    // Zero everything first.
    //
    // The aggregation query returns no row at all for a sender whose mail has
    // been entirely trashed, so an upsert-only pass leaves its previous count
    // untouched — the sender the user just cleaned out keeps showing its old
    // total forever. Resetting inside the same transaction means a reader can
    // never observe the zeroed intermediate state.
    db.prepare(
      `UPDATE senders SET message_count = 0, unread_count = 0, total_bytes = 0
       WHERE account_id = ?`,
    ).run(accountId);

    for (const r of rows) {
      if (self && r.sender_key === self) continue; // never act on your own sent mail
      upsert.run({
        id: newId("snd"),
        account_id: accountId,
        sender_key: r.sender_key,
        domain: domainOf(r.sender_key),
        message_count: r.message_count,
        unread_count: r.unread_count ?? 0,
        total_bytes: r.total_bytes ?? 0,
        first_seen: r.first_seen,
        last_seen: r.last_seen,
        has_unsubscribe: r.has_unsubscribe ?? 0,
        user_replied: isCorrespondent(r.sender_key, r.message_count) ? 1 : 0,
      });
    }
  })();
}

/** Distinct subject-template count, used by the bulk-mail heuristic. */
export function distinctSubjectCounts(accountId: string): Map<string, number> {
  const rows = db
    .prepare(
      `SELECT sender_key, COUNT(DISTINCT subject_hash) c
       FROM messages_meta WHERE account_id = ? GROUP BY sender_key`,
    )
    .all(accountId) as { sender_key: string; c: number }[];
  return new Map(rows.map((r) => [r.sender_key, r.c]));
}

export function labelsPerSender(accountId: string): Map<string, string[]> {
  const rows = db
    .prepare(`SELECT sender_key, labels FROM messages_meta WHERE account_id = ?`)
    .all(accountId) as { sender_key: string; labels: string }[];
  const map = new Map<string, Set<string>>();
  for (const r of rows) {
    let set = map.get(r.sender_key);
    if (!set) map.set(r.sender_key, (set = new Set()));
    for (const l of r.labels.split(",")) if (l) set.add(l);
  }
  return new Map([...map].map(([k, v]) => [k, [...v]]));
}
