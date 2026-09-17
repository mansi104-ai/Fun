import { hashSubject } from "../lib/crypto.js";
import { HEADERS, REPLY_RATIO_THRESHOLD, UNREPLIABLE } from "../gmail/sync.js";
import {
  classifyHeuristically,
  fallbackClassify,
  worthEscalating,
  type SenderFacts,
  type Verdict,
} from "../classify/heuristics.js";
import { DAY_MS, LIMITS } from "../safety/limits.js";
import {
  evaluate,
  type CandidateMessage,
  type GuardContext,
  type SenderRow,
} from "../safety/policy.js";
import type { InboxMessage } from "./catalog.js";

/**
 * THE SANDBOX PIPELINE — the real thing, over a made-up inbox.
 *
 * Everything that decides an outcome here is imported, not reimplemented:
 * `hashSubject` from the sync path, `classifyHeuristically` and
 * `fallbackClassify` from the classifier, and `evaluate` — the single guardrail
 * chokepoint — from safety/policy.ts. This file only shapes input and records
 * what came back.
 *
 * That constraint is the entire point of the feature. A demo that narrates the
 * safety model in its own words is marketing; a demo that runs the code and
 * prints what it returned is evidence. If a guard is ever weakened, this page
 * starts showing the weakened behaviour on its own, with nobody remembering to
 * update it. Smoke §22 asserts the imports, so a future "just mock it out here"
 * fails the build.
 *
 * What it does NOT do: call the LLM tier. This endpoint is unauthenticated, and
 * an anonymous request that spends model budget is a bill anyone on the
 * internet can run up. Senders the heuristics decline are therefore shown
 * taking the model-unavailable path (fallbackClassify), which is real
 * behaviour — it is what a visitor's own account would do during a provider
 * outage — and the trace says so rather than implying a model ran.
 */

/** The sandbox mailbox owner. Only ever the sender of the synthetic SENT rows. */
const OWNER = "you@example.com";

const ACCOUNT_ID = "sandbox";

// ── Stage 1: ingest ──────────────────────────────────────────────────────

export interface IngestedRow {
  id: string;
  senderKey: string;
  senderName: string;
  /** Echoed back only so the UI can show it next to what we kept of it. */
  subject: string;
  /** What actually gets stored. The plaintext above is discarded here. */
  subjectHash: string;
  internalDate: number;
  sizeBytes: number;
  /** Comma-joined, exactly the shape messages_meta holds. */
  labels: string;
  threadId: string;
  hasUnsubscribe: boolean;
}

/**
 * Turns picked messages into the rows sync.ts would have written.
 *
 * A message flagged `youRepliedInThread` also produces a SENT row in the same
 * thread, because that is how a reply is visible to us: we never see "the user
 * replied", we see a message of theirs sitting in the thread.
 */
function ingest(picked: InboxMessage[], now: number): IngestedRow[] {
  const rows: IngestedRow[] = [];

  for (const m of picked) {
    const threadId = `thr_${m.id}`;
    const labels = [
      ...m.labels,
      "INBOX",
      ...(m.unread ? ["UNREAD"] : []),
      ...(m.starred ? ["STARRED"] : []),
      ...(m.important ? ["IMPORTANT"] : []),
    ];

    rows.push({
      id: m.id,
      senderKey: m.senderKey,
      senderName: m.senderName,
      subject: m.subject,
      subjectHash: hashSubject(m.subject),
      internalDate: now - m.ageDays * DAY_MS,
      sizeBytes: m.sizeKb * 1024,
      labels: labels.join(","),
      threadId,
      hasUnsubscribe: m.hasUnsubscribe,
    });

    if (m.youRepliedInThread) {
      rows.push({
        id: `${m.id}-sent`,
        senderKey: OWNER,
        senderName: "You",
        subject: `Re: ${m.subject}`,
        subjectHash: hashSubject(`Re: ${m.subject}`),
        internalDate: now - m.ageDays * DAY_MS + 3_600_000,
        sizeBytes: 4 * 1024,
        labels: "SENT",
        threadId,
        hasUnsubscribe: false,
      });
    }
  }
  return rows;
}

// ── Stage 2: aggregate to sender facts ───────────────────────────────────

/**
 * Mirrors the aggregation in sync.ts: per-sender counts, the distinct
 * subject-hash count that detects template reuse, and reply detection as a
 * RATIO rather than a boolean, using the same threshold constant.
 *
 * SENT rows are excluded from the sender list — they are the user's own mail,
 * not a sender in their inbox — but they still drive reply detection, which is
 * the only reason they exist.
 */
function aggregate(rows: IngestedRow[]): SenderFacts[] {
  const inbound = rows.filter((r) => !r.labels.split(",").includes("SENT"));

  const repliedThreads = new Set(
    rows.filter((r) => r.labels.split(",").includes("SENT")).map((r) => r.threadId),
  );

  const bySender = new Map<string, IngestedRow[]>();
  for (const r of inbound) {
    const list = bySender.get(r.senderKey) ?? [];
    list.push(r);
    bySender.set(r.senderKey, list);
  }

  const facts: SenderFacts[] = [];
  for (const [senderKey, msgs] of bySender) {
    const inRepliedThreads = msgs.filter((m) => repliedThreads.has(m.threadId)).length;
    const unrepliable = UNREPLIABLE.test(`${senderKey.split("@")[0]}@`);
    const userReplied =
      !unrepliable && inRepliedThreads > 0 && inRepliedThreads / msgs.length >= REPLY_RATIO_THRESHOLD;

    const labels = new Set<string>();
    for (const m of msgs) for (const l of m.labels.split(",")) labels.add(l);

    facts.push({
      senderKey,
      displayName: msgs[0]!.senderName,
      domain: senderKey.split("@")[1] ?? "unknown",
      messageCount: msgs.length,
      unreadCount: msgs.filter((m) => m.labels.split(",").includes("UNREAD")).length,
      totalBytes: msgs.reduce((sum, m) => sum + m.sizeBytes, 0),
      firstSeen: Math.min(...msgs.map((m) => m.internalDate)),
      lastSeen: Math.max(...msgs.map((m) => m.internalDate)),
      hasUnsubscribe: msgs.some((m) => m.hasUnsubscribe),
      userReplied,
      labels: [...labels],
      distinctSubjectHashes: new Set(msgs.map((m) => m.subjectHash)).size,
    });
  }
  return facts;
}

// ── Stage 3: classify ────────────────────────────────────────────────────

/** Which tier settled this sender — the honest answer, including "nobody did". */
export type ClassifyTier = "heuristic" | "model-unavailable" | "too-small";

export interface SenderTrace {
  /**
   * The complete set of facts the classifier saw. Shown verbatim because it is
   * also the answer to "what would you send a third-party model?" — this
   * object, and nothing else. No subject, no body, no recipient.
   */
  facts: SenderFacts;
  tier: ClassifyTier;
  /** True when the heuristics declined and the sender was big enough to escalate. */
  wouldEscalate: boolean;
  verdict: Verdict;
  /** Set when the verdict came from a rule rather than a default. */
  ruleFired: boolean;
}

const UNDECIDED: Omit<Verdict, "reason"> = {
  category: "unknown",
  confidence: 0.3,
  protectedSender: true,
  source: "heuristic",
};

function classify(facts: SenderFacts[]): SenderTrace[] {
  return facts.map((f) => {
    const heuristic = classifyHeuristically(f);
    if (heuristic) {
      return { facts: f, tier: "heuristic", wouldEscalate: false, verdict: heuristic, ruleFired: true };
    }

    // The heuristics declined. In a real account this sender goes to the model
    // tier; here it takes the same path an account takes when the model cannot
    // be reached, which is the conservative one.
    if (worthEscalating(f)) {
      const fallback = fallbackClassify(f);
      return {
        facts: f,
        tier: "model-unavailable",
        wouldEscalate: true,
        verdict:
          fallback ??
          { ...UNDECIDED, reason: "Could not classify confidently — left untouched." },
        ruleFired: fallback !== null,
      };
    }

    return {
      facts: f,
      tier: "too-small",
      wouldEscalate: false,
      verdict: { ...UNDECIDED, reason: "Not enough signal to classify — left untouched." },
      ruleFired: false,
    };
  });
}

// ── Stage 4: the guard layer ─────────────────────────────────────────────

/**
 * Every guard in docs/06 §3, listed whether or not it fires.
 *
 * Showing only the guards that triggered would let a visitor conclude the
 * others do not exist. A roster that reports "checked, did not apply" is the
 * difference between a result and an audit.
 */
interface GuardSpec {
  id: string;
  title: string;
  severity: "block" | "confirm" | "exclude";
  scope: "batch" | "sender" | "message";
}

export const GUARDS: Record<string, GuardSpec> = {
  NEVER_DELETE: { id: "G1", title: "Never permanently delete", severity: "block", scope: "batch" },
  UNKNOWN_SENDER: { id: "—", title: "Unrecognised sender fails closed", severity: "block", scope: "batch" },
  PROTECTED_CATEGORY: { id: "G2", title: "Protected category", severity: "exclude", scope: "sender" },
  LOW_CONFIDENCE: { id: "G3", title: "Confidence floor", severity: "exclude", scope: "sender" },
  TOO_RECENT: { id: "G4", title: "Recency shield", severity: "exclude", scope: "message" },
  BATCH_TOO_LARGE: { id: "G5", title: "Batch size ceiling", severity: "block", scope: "batch" },
  TOO_MANY_SENDERS: { id: "G5", title: "Sender count ceiling", severity: "block", scope: "batch" },
  DAILY_LIMIT: { id: "G5", title: "Rolling 24h ceiling", severity: "block", scope: "batch" },
  SCALE_ANOMALY: { id: "G6", title: "Mailbox-scale anomaly", severity: "confirm", scope: "batch" },
  USER_PINNED: { id: "G7", title: "Sender you pinned", severity: "exclude", scope: "sender" },
  REPLIED_SENDER: { id: "G8", title: "Sender you have written to", severity: "exclude", scope: "sender" },
  STARRED: { id: "G9", title: "Starred message", severity: "exclude", scope: "message" },
  IN_REPLIED_THREAD: { id: "G10", title: "Thread you replied in", severity: "exclude", scope: "message" },
  HAS_ATTACHMENT: { id: "G11", title: "Carries an attachment", severity: "exclude", scope: "message" },
  GMAIL_IMPORTANT: { id: "G12", title: "Gmail marked it important", severity: "exclude", scope: "message" },
};

export interface GuardTrace extends GuardSpec {
  code: string;
  fired: boolean;
  /** Per-sender detail for a guard that fired. Empty for batch-level guards. */
  hits: { senderKey: string; messageCount: number; reason: string }[];
  /** Set for batch-level guards that fired. */
  message: string | null;
}

// ── Assembly ─────────────────────────────────────────────────────────────

export interface HeldMessage {
  id: string;
  senderKey: string;
  /** Every guard that objected to this specific message, in the order they ran. */
  by: { id: string; code: string; reason: string }[];
}

/**
 * What the Gmail read is allowed to see, sent so the page can show the real
 * allowlist rather than a hand-copied one that is free to go stale.
 *
 * Note what is NOT in `SandboxTrace`: any message body. The catalogue endpoint
 * serves bodies so the sample cards can display them, and this response — the
 * one that represents a sync — never carries one. That asymmetry is checkable
 * from a visitor's own network tab, which is the point of shipping it.
 */
export interface RedactionFacts {
  /** The exact header allowlist sync.ts passes to Gmail. */
  headersRequested: string[];
  /** The Gmail `format` parameter. "metadata" cannot return a body. */
  fetchFormat: string;
  /** Header values read, used, and then dropped rather than stored. */
  discarded: string[];
}

export interface SandboxTrace {
  action: string;
  confirmed: boolean;
  now: number;
  limits: typeof LIMITS;
  redaction: RedactionFacts;
  ingest: {
    rows: IngestedRow[];
    /** Messages actually eligible for this action, after the state filter. */
    candidateCount: number;
    mailboxSize: number;
  };
  senders: SenderTrace[];
  guards: GuardTrace[];
  outcome: {
    moving: { id: string; senderKey: string }[];
    held: HeldMessage[];
    requiresConfirmation: boolean;
    ok: boolean;
    /** Null when the batch cannot run at all. */
    reversal: string | null;
  };
}

/**
 * The state filter from candidates.ts, restated for rows that live in memory
 * rather than SQLite. An unrecognised action keeps every message so that the
 * guard layer — not this function — is what refuses it.
 */
function eligible(rows: IngestedRow[], action: string): IngestedRow[] {
  const inbound = rows.filter((r) => !r.labels.split(",").includes("SENT"));
  if (action === "archive") return inbound.filter((r) => r.labels.split(",").includes("INBOX"));
  if (action === "trash") return inbound.filter((r) => !r.labels.split(",").includes("TRASH"));
  return inbound;
}

const toCandidate = (r: IngestedRow, picked: Map<string, InboxMessage>): CandidateMessage => ({
  message_id: r.id,
  sender_key: r.senderKey,
  labels: r.labels,
  size_bytes: r.sizeBytes,
  internal_date: r.internalDate,
  thread_id: r.threadId,
  has_attachment: picked.get(r.id)?.hasAttachment ? 1 : 0,
});

export function runSandbox(
  picked: InboxMessage[],
  action: string,
  confirmed: boolean,
): SandboxTrace {
  const now = Date.now();
  const byId = new Map(picked.map((m) => [m.id, m]));

  const rows = ingest(picked, now);
  const senders = classify(aggregate(rows));

  const senderRows = new Map<string, SenderRow>(
    senders.map((s) => [
      s.facts.senderKey,
      {
        sender_key: s.facts.senderKey,
        protected: s.verdict.protectedSender ? 1 : 0,
        // Nothing is pinned in the sandbox: pinning is a per-account action and
        // a visitor has no account. G7 is listed as checked-and-not-applicable
        // rather than quietly dropped from the roster.
        user_protected: 0,
        user_replied: s.facts.userReplied ? 1 : 0,
        category: s.verdict.category,
        confidence: s.verdict.confidence,
        message_count: s.facts.messageCount,
      },
    ]),
  );

  const repliedThreadIds = new Set(
    rows.filter((r) => r.labels.split(",").includes("SENT")).map((r) => r.threadId),
  );
  const mailboxSize = rows.filter((r) => !r.labels.split(",").includes("SENT")).length;

  /** Mirrors loadSenders: a context carries only the senders in its own batch. */
  const contextFor = (keys: string[]): GuardContext => ({
    senders: new Map([...senderRows].filter(([k]) => keys.includes(k))),
    repliedThreadIds,
    // A visitor has no batch history, so the rolling-24h counter starts at zero
    // and G5's daily ceiling is reported as checked rather than exercised.
    messagesActionedToday: 0,
    mailboxSize,
  });

  const candidates = eligible(rows, action).map((r) => toCandidate(r, byId));
  const senderKeys = [...new Set(candidates.map((c) => c.sender_key))];

  const verdict = evaluate({
    accountId: ACCOUNT_ID,
    action,
    senderKeys,
    candidates,
    confirmed,
    context: contextFor(senderKeys),
  });

  // ── Guard roster ───────────────────────────────────────────────────────

  const hitsByCode = new Map<string, GuardTrace["hits"]>();
  for (const e of verdict.exclusions) {
    const list = hitsByCode.get(e.code) ?? [];
    list.push({ senderKey: e.senderKey, messageCount: e.messageCount, reason: e.reason });
    hitsByCode.set(e.code, list);
  }
  const violationByCode = new Map(verdict.violations.map((v) => [v.code, v.message]));

  const guards: GuardTrace[] = Object.entries(GUARDS).map(([code, spec]) => ({
    ...spec,
    code,
    fired: hitsByCode.has(code) || violationByCode.has(code),
    hits: hitsByCode.get(code) ?? [],
    message: violationByCode.get(code) ?? null,
  }));

  // ── Per-message attribution ────────────────────────────────────────────

  /**
   * Which guard kept THIS message is the question a sceptical visitor actually
   * has, and `evaluate` reports exclusions aggregated per sender rather than
   * per message. Rather than re-deriving the answer — which would be a second
   * copy of the rules, free to drift from the first — each held message is put
   * back through the same `evaluate` on its own and the exclusions are read off.
   *
   * Bounded by the catalogue size, and the batch-level guards are ignored here:
   * a single message is never a scale anomaly, and only the per-message and
   * per-sender exclusions are attributable to one id.
   */
  const allowedIds = new Set(verdict.allowed.map((c) => c.message_id));
  const held: HeldMessage[] = candidates
    .filter((c) => !allowedIds.has(c.message_id))
    .map((c) => {
      const probe = evaluate({
        accountId: ACCOUNT_ID,
        action,
        senderKeys: [c.sender_key],
        candidates: [c],
        confirmed: true,
        context: contextFor([c.sender_key]),
      });
      return {
        id: c.message_id,
        senderKey: c.sender_key,
        by: probe.exclusions
          .filter((e) => e.senderKey === c.sender_key)
          .map((e) => ({ id: GUARDS[e.code]?.id ?? "—", code: e.code, reason: e.reason })),
      };
    });

  const blocked = verdict.violations.some((v) => v.severity === "block");

  return {
    action,
    confirmed,
    now,
    limits: LIMITS,
    redaction: {
      headersRequested: [...HEADERS],
      fetchFormat: "metadata",
      discarded: ["Subject"],
    },
    ingest: { rows, candidateCount: candidates.length, mailboxSize },
    senders,
    guards,
    outcome: {
      moving: blocked
        ? []
        : verdict.allowed.map((c) => ({ id: c.message_id, senderKey: c.sender_key })),
      held,
      requiresConfirmation: verdict.requiresConfirmation,
      ok: verdict.ok,
      reversal: blocked
        ? null
        : action === "trash"
          ? "Moved to Gmail's Trash. Recoverable there for 30 days, and one click of Undo puts every message back where it was."
          : "Removed from the inbox only. Archived mail stays in All Mail permanently, and Undo restores the INBOX label.",
    },
  };
}
