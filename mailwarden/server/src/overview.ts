import { candidatesFor } from "./candidates.js";
import { db } from "./db.js";
import { isSuggestable } from "./classify/index.js";
import { DAY_MS, LIMITS } from "./safety/limits.js";
import { evaluate } from "./safety/policy.js";

/**
 * THE SAFE / REVIEW / PROTECTED MODEL.
 *
 * The product's claim is "cleans what it understands, protects what matters",
 * and until now the UI could not show the second half — it reported what was
 * cleanable and buried what was held back. This module makes protection a
 * first-class number.
 *
 * Every figure here is DERIVED FROM EXISTING STATE. Nothing is invented:
 *
 *   SAFE       cleanable AND clears the auto-suggest bar (confidence >= 0.7)
 *   REVIEW     cleanable but below that bar — the classifier is not confident
 *              enough to propose it, so the user decides
 *   PROTECTED  everything the guard layer holds back, with the guard's own
 *              reason code as the explanation
 *
 * The two thresholds are the ones the guard layer already enforces
 * (safety/limits.ts), so these three buckets are exactly the states the engine
 * already acts on. They are a new *view*, not a new classification.
 */

export interface StateBucket {
  messages: number;
  senders: number;
  bytes: number;
}

export interface ProtectionReason {
  code: string;
  label: string;
  messages: number;
}

export interface SenderCard {
  senderKey: string;
  displayName: string | null;
  category: string | null;
  messageCount: number;
  /** Messages that would actually move. 0 for a protected sender. */
  actionableCount: number;
  totalBytes: number;
  unreadCount: number;
  lastSeen: number;
  state: "safe" | "review" | "protected";
  /** Observed facts, never prose. See `evidenceFor`. */
  evidence: string[];
  /** The guard's own words, when this sender is held. */
  holdReason: string | null;
  hasUnsubscribe: boolean;
  userProtected: number;
}

export interface Overview {
  scanned: { messages: number; bytes: number; senders: number; lastScanAt: number | null };
  safe: StateBucket;
  review: StateBucket;
  protected: StateBucket & { reasons: ProtectionReason[] };
  history: { cleanups: number; messagesCleaned: number; undone: number };
}

/** Human labels for guard codes. Unknown codes fall back to the code itself. */
const REASON_LABEL: Record<string, string> = {
  TOO_RECENT: "Arrived in the last 7 days",
  PROTECTED_CATEGORY: "Receipts, codes, travel or bank mail",
  REPLIED_SENDER: "People you correspond with",
  IN_REPLIED_THREAD: "Conversations you replied to",
  USER_PINNED: "Senders you pinned",
  STARRED: "You starred these",
  HAS_ATTACHMENT: "Carrying attachments",
  GMAIL_IMPORTANT: "Gmail marked important",
  LOW_CONFIDENCE: "Not understood well enough to act on",
};

interface SenderRow {
  sender_key: string;
  display_name: string | null;
  category: string | null;
  confidence: number | null;
  message_count: number;
  unread_count: number;
  total_bytes: number;
  last_seen: number;
  has_unsubscribe: number;
  user_replied: number;
  user_protected: number;
  protected: number;
  decision_count: number | null;
  classified_by: string | null;
}

const loadSenders = (accountId: string): SenderRow[] =>
  db
    .prepare(
      `SELECT sender_key, display_name, category, confidence, message_count, unread_count,
              total_bytes, last_seen, has_unsubscribe, user_replied, user_protected,
              protected, decision_count, classified_by
       FROM senders WHERE account_id = ? AND message_count > 0
       ORDER BY message_count DESC`,
    )
    .all(accountId) as SenderRow[];

/**
 * Observed facts about a sender, phrased for a human.
 *
 * Deliberately NOT the classifier's prose. Every line here is a value already
 * in the database that the user could verify in Gmail themselves — which is the
 * point: evidence beats explanation. Nothing is generated, so nothing can be
 * hallucinated.
 */
export function evidenceFor(s: SenderRow): string[] {
  const out: string[] = [];
  const unreadRate = s.message_count > 0 ? s.unread_count / s.message_count : 0;
  const daysQuiet = s.last_seen ? Math.floor((Date.now() - s.last_seen) / DAY_MS) : 0;

  if (s.user_replied === 1) out.push("You have replied to this sender");
  if (s.has_unsubscribe) out.push("Bulk mail — carries an unsubscribe header");
  if (unreadRate >= 0.9) out.push(`You have never opened ${Math.round(unreadRate * 100)}% of it`);
  else if (unreadRate >= 0.6) out.push(`${Math.round(unreadRate * 100)}% left unread`);
  if (s.user_replied === 0 && s.has_unsubscribe) out.push("No replies from you, ever");
  if (daysQuiet > 30) out.push(`Nothing new for ${daysQuiet} days`);
  if ((s.decision_count ?? 0) > 0) {
    out.push(`You cleaned this sender ${s.decision_count} time${s.decision_count === 1 ? "" : "s"} before`);
  }
  if (s.message_count >= 100) out.push(`${s.message_count.toLocaleString()} messages in your mailbox`);
  if (s.classified_by?.startsWith("llm")) out.push("Reviewed a second time by the classifier");

  return out.slice(0, 5);
}

const isProtectedSender = (s: SenderRow): boolean =>
  s.user_protected === 1 || (s.protected === 1 && s.user_protected !== -1) || s.user_replied === 1;

/** safe | review | protected, using the same thresholds the guards enforce. */
export function stateOf(s: SenderRow): "safe" | "review" | "protected" {
  if (isProtectedSender(s)) return "protected";
  if ((s.confidence ?? 0) < LIMITS.hardConfidenceFloor) return "protected";
  return isSuggestable(s.category, s.confidence) ? "safe" : "review";
}

export function computeOverview(accountId: string): Overview {
  const senders = loadSenders(accountId);

  const totals = db
    .prepare(
      `SELECT COUNT(*) AS messages, COALESCE(SUM(size_bytes),0) AS bytes
       FROM messages_meta WHERE account_id = ? AND labels NOT LIKE '%TRASH%'`,
    )
    .get(accountId) as { messages: number; bytes: number };

  const lastScan = db.prepare(`SELECT last_sync_at FROM accounts WHERE id = ?`).get(accountId) as
    | { last_sync_at: number | null }
    | undefined;

  const bucket = (): StateBucket => ({ messages: 0, senders: 0, bytes: 0 });
  const safe = bucket();
  const review = bucket();
  const prot = bucket();

  /**
   * Actionable counts come from a real dry run of the policy, not from
   * message_count. A sender can be "safe" while most of its mail is held by a
   * per-message guard — starred, attached, or too recent — and reporting the
   * raw total would promise more than the engine will deliver.
   */
  const actionableKeys = senders.filter((s) => stateOf(s) !== "protected").map((s) => s.sender_key);
  const verdict =
    actionableKeys.length > 0
      ? evaluate({
          accountId,
          action: "archive",
          senderKeys: actionableKeys,
          candidates: candidatesFor(accountId, actionableKeys, "archive"),
          confirmed: true,
        })
      : { allowed: [], exclusions: [] as { code: string; messageCount: number }[] };

  const allowedPerSender = new Map<string, { count: number; bytes: number }>();
  for (const c of verdict.allowed) {
    const acc = allowedPerSender.get(c.sender_key) ?? { count: 0, bytes: 0 };
    acc.count += 1;
    acc.bytes += c.size_bytes;
    allowedPerSender.set(c.sender_key, acc);
  }

  for (const s of senders) {
    const state = stateOf(s);
    const hit = allowedPerSender.get(s.sender_key);

    if (state === "protected") {
      prot.messages += s.message_count;
      prot.senders += 1;
      prot.bytes += s.total_bytes;
      continue;
    }
    const target = state === "safe" ? safe : review;
    target.messages += hit?.count ?? 0;
    target.bytes += hit?.bytes ?? 0;
    if ((hit?.count ?? 0) > 0) target.senders += 1;

    // Mail from an otherwise-actionable sender that a per-message guard held.
    const held = s.message_count - (hit?.count ?? 0);
    if (held > 0) prot.messages += held;
  }

  // Per-message guard exclusions, aggregated by code across the whole mailbox.
  const byCode = new Map<string, number>();
  for (const e of verdict.exclusions) {
    byCode.set(e.code, (byCode.get(e.code) ?? 0) + e.messageCount);
  }
  // Sender-level protection is not an "exclusion" — those senders never enter
  // the batch — so it is counted separately or it would be invisible here.
  const senderLevelProtected = senders.filter(isProtectedSender);
  if (senderLevelProtected.length > 0) {
    const replied = senderLevelProtected.filter((s) => s.user_replied === 1);
    const pinned = senderLevelProtected.filter((s) => s.user_protected === 1 && s.user_replied !== 1);
    const category = senderLevelProtected.filter(
      (s) => s.user_replied !== 1 && s.user_protected !== 1,
    );
    const add = (code: string, rows: SenderRow[]): void => {
      const n = rows.reduce((sum, r) => sum + r.message_count, 0);
      if (n > 0) byCode.set(code, (byCode.get(code) ?? 0) + n);
    };
    add("REPLIED_SENDER", replied);
    add("USER_PINNED", pinned);
    add("PROTECTED_CATEGORY", category);
  }

  const reasons: ProtectionReason[] = [...byCode]
    .map(([code, messages]) => ({ code, label: REASON_LABEL[code] ?? code, messages }))
    .filter((r) => r.messages > 0)
    .sort((a, b) => b.messages - a.messages);

  const hist = db
    .prepare(
      `SELECT COUNT(*) AS cleanups,
              COALESCE(SUM(CASE WHEN status = 'done' THEN message_count ELSE 0 END),0) AS cleaned,
              COALESCE(SUM(CASE WHEN status = 'undone' THEN 1 ELSE 0 END),0) AS undone
       FROM batches WHERE account_id = ? AND status IN ('done','undone')`,
    )
    .get(accountId) as { cleanups: number; cleaned: number; undone: number };

  return {
    scanned: {
      messages: totals.messages,
      bytes: totals.bytes,
      senders: senders.length,
      lastScanAt: lastScan?.last_sync_at ?? null,
    },
    safe,
    review,
    protected: { ...prot, reasons },
    history: {
      cleanups: hist.cleanups,
      messagesCleaned: hist.cleaned,
      undone: hist.undone,
    },
  };
}

/** Sender cards for one state, largest first — the biggest win goes on top. */
export function sendersInState(
  accountId: string,
  state: "safe" | "review" | "protected",
  limit = 200,
): SenderCard[] {
  const senders = loadSenders(accountId).filter((s) => stateOf(s) === state);
  if (senders.length === 0) return [];

  const keys = senders.map((s) => s.sender_key);
  const verdict = evaluate({
    accountId,
    action: "archive",
    senderKeys: keys,
    candidates: candidatesFor(accountId, keys, "archive"),
    confirmed: true,
  });

  const allowed = new Map<string, number>();
  for (const c of verdict.allowed) allowed.set(c.sender_key, (allowed.get(c.sender_key) ?? 0) + 1);

  const holdReason = new Map<string, string>();
  for (const e of verdict.exclusions) {
    if (!holdReason.has(e.senderKey)) holdReason.set(e.senderKey, e.reason);
  }

  return senders
    .map((s) => ({
      senderKey: s.sender_key,
      displayName: s.display_name,
      category: s.category,
      messageCount: s.message_count,
      actionableCount: allowed.get(s.sender_key) ?? 0,
      totalBytes: s.total_bytes,
      unreadCount: s.unread_count,
      lastSeen: s.last_seen,
      state,
      evidence: evidenceFor(s),
      holdReason: holdReason.get(s.sender_key) ?? null,
      hasUnsubscribe: Boolean(s.has_unsubscribe),
      userProtected: s.user_protected,
    }))
    .sort((a, b) =>
      state === "protected"
        ? b.messageCount - a.messageCount
        : b.actionableCount - a.actionableCount,
    )
    .slice(0, limit);
}
