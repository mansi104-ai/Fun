import { db } from "../db.js";
import { DAY_MS, LIMITS } from "./limits.js";

/**
 * THE GUARDRAIL LAYER.
 *
 * Every mutation of a user's mailbox passes through this module. Nothing in
 * gmail/executor.ts touches Gmail without an `assertExecutable` verdict, and
 * `assertExecutable` re-runs from scratch at execute time rather than trusting
 * the plan — because a sender's classification can change between the two, and
 * a stale authorisation is not an authorisation.
 *
 * Two severities:
 *   block    the batch cannot proceed. Fail closed, no partial execution.
 *   confirm  the batch may proceed only with explicit second confirmation.
 *
 * Exclusions are different from violations: an exclusion silently drops
 * individual messages or senders from a batch (and reports why), while the rest
 * proceeds. Protection should narrow a batch, not cancel it.
 */

export type Severity = "block" | "confirm";

export interface Violation {
  code: string;
  severity: Severity;
  message: string;
  senderKeys?: string[];
}

export interface Exclusion {
  code: string;
  senderKey: string;
  messageCount: number;
  reason: string;
}

export interface CandidateMessage {
  message_id: string;
  sender_key: string;
  labels: string;
  size_bytes: number;
  internal_date: number;
  thread_id?: string | null;
  has_attachment?: number;
}

export interface GuardVerdict {
  allowed: CandidateMessage[];
  exclusions: Exclusion[];
  violations: Violation[];
  /** True when only `confirm`-severity violations remain. */
  requiresConfirmation: boolean;
  /** True when the batch may execute (given confirmation, if required). */
  ok: boolean;
}

interface SenderRow {
  sender_key: string;
  protected: number;
  user_protected: number;
  user_replied: number;
  category: string | null;
  confidence: number | null;
  message_count: number;
}

export interface GuardInput {
  accountId: string;
  action: string;
  senderKeys: string[];
  candidates: CandidateMessage[];
  /** Set when the user has explicitly confirmed a `confirm`-severity warning. */
  confirmed?: boolean;
}

// ── Individual guards ────────────────────────────────────────────────────

/**
 * G1 — the product's foundational promise. `gmail.modify` cannot permanently
 * delete, so this is belt-and-braces against a future code change that adds a
 * broader scope without anyone re-reading docs/03.
 */
function guardAction(action: string, violations: Violation[]): void {
  if (action !== "archive" && action !== "trash") {
    violations.push({
      code: "NEVER_DELETE",
      severity: "block",
      message:
        `Refusing action "${action}". Mailwarden only archives or trashes. ` +
        `Permanent deletion is not a capability this app has or will have.`,
    });
  }
}

/** G2/G7/G8 — protected, user-pinned, and replied-to senders are never bulk-actioned. */
function guardProtectedSenders(
  senders: Map<string, SenderRow>,
  candidates: CandidateMessage[],
  exclusions: Exclusion[],
): Set<string> {
  const blocked = new Set<string>();
  const counts = new Map<string, number>();
  for (const c of candidates) counts.set(c.sender_key, (counts.get(c.sender_key) ?? 0) + 1);

  for (const [key, s] of senders) {
    // An explicit user release (-1) overrides automatic protection, but never
    // overrides a reply — the user writing back is not something we second-guess.
    const released = s.user_protected === -1;

    if (s.user_replied === 1) {
      blocked.add(key);
      exclusions.push({
        code: "REPLIED_SENDER",
        senderKey: key,
        messageCount: counts.get(key) ?? 0,
        reason: "You have replied to this sender — Mailwarden never bulk-actions those.",
      });
      continue;
    }
    if (s.user_protected === 1) {
      blocked.add(key);
      exclusions.push({
        code: "USER_PINNED",
        senderKey: key,
        messageCount: counts.get(key) ?? 0,
        reason: "You pinned this sender as protected.",
      });
      continue;
    }
    if (s.protected === 1 && !released) {
      blocked.add(key);
      exclusions.push({
        code: "PROTECTED_CATEGORY",
        senderKey: key,
        messageCount: counts.get(key) ?? 0,
        reason: `Protected as ${s.category ?? "unclassified"} — may contain receipts, codes, or travel documents.`,
      });
    }
  }
  return blocked;
}

/**
 * G3 — if we do not understand a sender, we decline to touch it in bulk.
 * Below the hard floor the honest answer is "open this one in Gmail".
 */
function guardConfidence(
  senders: Map<string, SenderRow>,
  candidates: CandidateMessage[],
  exclusions: Exclusion[],
): Set<string> {
  const blocked = new Set<string>();
  const counts = new Map<string, number>();
  for (const c of candidates) counts.set(c.sender_key, (counts.get(c.sender_key) ?? 0) + 1);

  for (const [key, s] of senders) {
    const confidence = s.confidence ?? 0;
    if (confidence < LIMITS.hardConfidenceFloor) {
      blocked.add(key);
      exclusions.push({
        code: "LOW_CONFIDENCE",
        senderKey: key,
        messageCount: counts.get(key) ?? 0,
        reason: `Not confident enough to act (${Math.round(confidence * 100)}%). Left untouched.`,
      });
    }
  }
  return blocked;
}

/**
 * G4 — recency shield. No classifier can know that the shipping notice from
 * Tuesday still matters, so time does that job instead.
 */
function guardRecency(candidates: CandidateMessage[], exclusions: Exclusion[]): Set<string> {
  const cutoff = Date.now() - LIMITS.recencyProtectionDays * DAY_MS;
  const excluded = new Set<string>();
  const perSender = new Map<string, number>();

  for (const c of candidates) {
    if (c.internal_date >= cutoff) {
      excluded.add(c.message_id);
      perSender.set(c.sender_key, (perSender.get(c.sender_key) ?? 0) + 1);
    }
  }
  for (const [senderKey, messageCount] of perSender) {
    exclusions.push({
      code: "TOO_RECENT",
      senderKey,
      messageCount,
      reason: `${messageCount} message(s) from the last ${LIMITS.recencyProtectionDays} days kept — recent mail is more likely to still matter.`,
    });
  }
  return excluded;
}

/**
 * G9–G12 — PER-MESSAGE protection.
 *
 * Every other guard here works at sender level, which leaves a real hole: once
 * a sender is judged actionable, every message they ever sent is actionable
 * with it. That is fine for the 400th identical newsletter and badly wrong for
 * the one message in that pile you starred, the one carrying an invoice PDF,
 * and the one sitting in a thread you replied to.
 *
 * These four look at individual messages instead. Two are absolute; two apply
 * only to `trash`, because archiving is fully reversible — archived mail stays
 * in All Mail forever — while trash starts a 30-day clock that ends in real,
 * unrecoverable deletion by Gmail itself.
 */
function guardMessageLevel(
  accountId: string,
  action: string,
  candidates: CandidateMessage[],
  exclusions: Exclusion[],
): Set<string> {
  const excluded = new Set<string>();
  const tally = new Map<string, { code: string; count: number; reason: string }>();

  const drop = (c: CandidateMessage, code: string, reason: string): void => {
    excluded.add(c.message_id);
    const key = `${code}:${c.sender_key}`;
    const row = tally.get(key) ?? { code, count: 0, reason };
    row.count += 1;
    tally.set(key, row);
  };

  /**
   * Threads the user has written in. Sender-level reply detection is a ratio
   * (see sync.ts), which correctly refuses to lock a whole newsletter over one
   * stray reply — but the thread you actually replied in should still never be
   * touched. This closes that gap without reopening the other one.
   */
  const repliedThreads = new Set(
    (
      db
        .prepare(
          `SELECT DISTINCT thread_id FROM messages_meta
           WHERE account_id = ? AND thread_id IS NOT NULL AND labels LIKE '%SENT%'`,
        )
        .all(accountId) as { thread_id: string }[]
    ).map((r) => r.thread_id),
  );

  for (const c of candidates) {
    const labels = c.labels.split(",");

    // G9 — an explicit user signal. Nothing outranks the user's own star.
    if (labels.includes("STARRED")) {
      drop(c, "STARRED", "You starred these — Mailwarden never touches starred mail.");
      continue;
    }

    // G10 — you wrote in this conversation.
    if (c.thread_id && repliedThreads.has(c.thread_id)) {
      drop(c, "IN_REPLIED_THREAD", "Part of a conversation you replied to.");
      continue;
    }

    // Below here: archive is permitted, trash is not. Archived mail is
    // recoverable forever; trashed mail is gone in 30 days.
    if (action !== "trash") continue;

    // G11 — attachments are the things users cannot reproduce.
    if (c.has_attachment === 1) {
      drop(c, "HAS_ATTACHMENT", "These carry attachments — archived instead of trashed.");
      continue;
    }

    // G12 — Gmail's own importance signal. Noisy enough that it should not
    // block archiving, strong enough that it should block deletion.
    if (labels.includes("IMPORTANT")) {
      drop(c, "GMAIL_IMPORTANT", "Gmail marked these important — archived instead of trashed.");
    }
  }

  for (const [key, row] of tally) {
    exclusions.push({
      code: row.code,
      senderKey: key.slice(row.code.length + 1),
      messageCount: row.count,
      reason: row.reason,
    });
  }
  return excluded;
}

/** G5 — volume ceilings, per batch and per rolling day. */
function guardVelocity(accountId: string, allowed: number, senderCount: number, violations: Violation[]): void {
  if (allowed > LIMITS.maxMessagesPerBatch) {
    violations.push({
      code: "BATCH_TOO_LARGE",
      severity: "block",
      message: `${allowed.toLocaleString()} messages exceeds the ${LIMITS.maxMessagesPerBatch.toLocaleString()} per-batch limit. Split this into smaller batches.`,
    });
  }
  if (senderCount > LIMITS.maxSendersPerBatch) {
    violations.push({
      code: "TOO_MANY_SENDERS",
      severity: "block",
      message: `${senderCount} senders exceeds the ${LIMITS.maxSendersPerBatch} per-batch limit.`,
    });
  }

  const since = Date.now() - DAY_MS;
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(message_count), 0) AS total FROM batches
       WHERE account_id = ? AND created_at > ? AND status IN ('running','done')`,
    )
    .get(accountId, since) as { total: number };

  if (row.total + allowed > LIMITS.maxMessagesPerDay) {
    violations.push({
      code: "DAILY_LIMIT",
      severity: "block",
      message: `This would put you over the ${LIMITS.maxMessagesPerDay.toLocaleString()} messages/day safety limit (${row.total.toLocaleString()} already actioned today).`,
    });
  }
}

/** G6 — a batch spanning most of the mailbox gets a second look, not a refusal. */
function guardScaleAnomaly(
  accountId: string,
  allowed: number,
  confirmed: boolean,
  violations: Violation[],
): void {
  const row = db
    .prepare(`SELECT COUNT(*) AS total FROM messages_meta WHERE account_id = ?`)
    .get(accountId) as { total: number };
  if (row.total === 0) return;

  const ratio = allowed / row.total;
  if (ratio >= LIMITS.scaleAnomalyRatio && !confirmed) {
    violations.push({
      code: "SCALE_ANOMALY",
      severity: "confirm",
      message: `This affects ${Math.round(ratio * 100)}% of your mailbox (${allowed.toLocaleString()} of ${row.total.toLocaleString()} messages). Confirm you meant to do this — it is reversible for 30 days either way.`,
    });
  }
}

// ── Evaluation ───────────────────────────────────────────────────────────

function loadSenders(accountId: string, senderKeys: string[]): Map<string, SenderRow> {
  if (senderKeys.length === 0) return new Map();
  const placeholders = senderKeys.map(() => "?").join(",");
  const rows = db
    .prepare(
      `SELECT sender_key, protected, user_protected, user_replied, category, confidence, message_count
       FROM senders WHERE account_id = ? AND sender_key IN (${placeholders})`,
    )
    .all(accountId, ...senderKeys) as SenderRow[];
  return new Map(rows.map((r) => [r.sender_key, r]));
}

/**
 * Runs the full policy. Pure with respect to the mailbox — it reads state and
 * returns a verdict, never mutates anything.
 */
export function evaluate(input: GuardInput): GuardVerdict {
  const violations: Violation[] = [];
  const exclusions: Exclusion[] = [];

  guardAction(input.action, violations);

  const senders = loadSenders(input.accountId, input.senderKeys);

  // A requested sender that no longer exists is a stale client. Fail closed.
  const missing = input.senderKeys.filter((k) => !senders.has(k));
  if (missing.length > 0) {
    violations.push({
      code: "UNKNOWN_SENDER",
      severity: "block",
      message: `${missing.length} sender(s) are no longer in your account. Re-scan and try again.`,
      senderKeys: missing,
    });
  }

  const blockedSenders = new Set<string>([
    ...guardProtectedSenders(senders, input.candidates, exclusions),
    ...guardConfidence(senders, input.candidates, exclusions),
  ]);
  const excludedMessages = new Set<string>([
    ...guardRecency(input.candidates, exclusions),
    ...guardMessageLevel(input.accountId, input.action, input.candidates, exclusions),
  ]);

  const allowed = input.candidates.filter(
    (c) => !blockedSenders.has(c.sender_key) && !excludedMessages.has(c.message_id),
  );
  const allowedSenders = new Set(allowed.map((c) => c.sender_key));

  guardVelocity(input.accountId, allowed.length, allowedSenders.size, violations);
  guardScaleAnomaly(input.accountId, allowed.length, input.confirmed === true, violations);

  const blocking = violations.filter((v) => v.severity === "block");
  const confirming = violations.filter((v) => v.severity === "confirm");

  return {
    allowed,
    exclusions,
    violations,
    requiresConfirmation: blocking.length === 0 && confirming.length > 0,
    ok: blocking.length === 0 && confirming.length === 0,
  };
}

export class GuardError extends Error {
  constructor(
    message: string,
    public violations: Violation[],
  ) {
    super(message);
    this.name = "GuardError";
  }
}

/**
 * The execute-time gate. Throws unless every block guard passes.
 *
 * This deliberately re-derives everything rather than trusting the plan: a
 * sender can be reclassified, pinned, or replied to between planning and
 * execution, and acting on a stale verdict is exactly the bug that loses
 * someone's boarding pass.
 */
export function assertExecutable(input: GuardInput): GuardVerdict {
  const verdict = evaluate({ ...input, confirmed: true });
  const blocking = verdict.violations.filter((v) => v.severity === "block");
  if (blocking.length > 0) {
    throw new GuardError(blocking.map((v) => v.message).join(" "), blocking);
  }
  return verdict;
}
