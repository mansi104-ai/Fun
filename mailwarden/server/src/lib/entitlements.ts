import { db, now } from "../db.js";

export type Plan = "free" | "backlog" | "pro" | "founding" | "starter";

/**
 * How an allowance comes back.
 *
 *   monthly  refills on the calendar month boundary
 *   pass     a fixed bucket bought once, with an expiry; never refills
 *   never    legacy lifetime grants — no metering at all
 */
export type Refill = "monthly" | "pass" | "never";

export interface Entitlements {
  plan: Plan;
  /**
   * Messages that may be CLEANED per window — archived or trashed.
   *
   * Metered by message rather than by cleanup, because a cleanup is not a unit
   * anybody experiences. A user with 5,400 promotional messages wants that
   * number gone; charging per "batch" either gives the whole job away or walls
   * them off after one sender. Volume is the thing they actually consume, and
   * the only thing that scales with what it costs us to serve them.
   *
   * Never "deleted". Mailwarden holds `gmail.modify` and cannot permanently
   * delete anything — that scope decision is the product's core promise
   * (docs/06), so the counter that meters it does not use the word either.
   */
  monthlyMessages: number;
  /**
   * Unsubscribes per window.
   *
   * Capped for SAFETY, not for revenue. Unsubscribing is outward-facing — it
   * tells a third party something about you — and unlike archiving it cannot be
   * undone from here. The cap bounds the blast radius of a mistake, mine or the
   * user's. It is deliberately not a paywall lever: the marginal cost of an
   * unsubscribe is nil, and metering it tightly would put friction on the
   * feature people like most.
   */
  monthlyUnsubs: number;
  refill: Refill;
  /** Lifetime of a `pass` plan, in days. Ignored by the other refill modes. */
  passDays: number;
  /** Messages scanned during sync. */
  scanLimit: number;
  /** Paid tiers route classification to Anthropic instead of OpenRouter. */
  premiumClassification: boolean;
  scheduledRescan: boolean;
  maxAccounts: number;
}

/**
 * THE MODEL.
 *
 * Inbox cleanup is a job, not a habit — docs/02 §115 names this as the deepest
 * structural risk in the business, and it is the fact the pricing has to be
 * built around rather than wished away. So there are two products:
 *
 *   Backlog Pass  the job. One payment, sized to finish any real inbox in one
 *                 go. Bought once, and honestly described as such.
 *   Pro           the habit. Scheduled re-scans keep an inbox that is already
 *                 clean from filling back up. This is the only recurring
 *                 revenue that a customer would agree they are getting value
 *                 for, which is the only kind worth having.
 *
 * The free tier refills monthly at a level that comfortably covers ordinary
 * incoming mail. That is intentional: someone whose inbox is under control
 * should not be charged, and someone with a five-thousand-message backlog is
 * the person the Backlog Pass is for.
 */
const PLANS: Record<Plan, Entitlements> = {
  /**
   * 1,000 messages is not a demo allowance — it is a real, visible result on a
   * real inbox, which is the whole argument of docs/00 §2a: deliver value
   * BEFORE the paywall, or collect refunds and one-star reviews. It is also
   * roughly a month of ordinary promotional mail, so the maintenance case
   * stays free forever and only the backlog is charged for.
   */
  free: {
    plan: "free",
    monthlyMessages: 1_000,
    monthlyUnsubs: 3,
    refill: "monthly",
    passDays: 0,
    scanLimit: 25_000,
    premiumClassification: false,
    scheduledRescan: false,
    maxAccounts: 1,
  },

  /**
   * ₹299 once. Sized at 50,000 so it finishes the job for essentially anybody —
   * the validated reference inbox was 6,010 messages (docs/05), so this is
   * eight times the largest mailbox we have actually measured.
   *
   * Sized generously ON PURPOSE. A pass that runs out mid-cleanup sends the
   * user back to a payment queue that a human has to clear by hand, at the
   * exact moment their intent is highest. One payment, one confirmation, job
   * done is worth more than the few rupees a tighter cap would earn.
   *
   * 60 days rather than forever: it is a backlog pass, and an unbounded bucket
   * would quietly become the cheapest permanent plan.
   */
  backlog: {
    plan: "backlog",
    monthlyMessages: 50_000,
    monthlyUnsubs: 50,
    refill: "pass",
    passDays: 60,
    scanLimit: 1_000_000,
    premiumClassification: true,
    scheduledRescan: false,
    maxAccounts: 1,
  },

  /**
   * ₹149/month. The cap is high enough that no honest user will meet it, and
   * low enough that a runaway loop or a shared credential cannot spend the LLM
   * budget unbounded. "Unlimited" with a quiet cap behind it is a lie; this is
   * the cap, stated.
   */
  pro: {
    plan: "pro",
    monthlyMessages: 25_000,
    monthlyUnsubs: 25,
    refill: "monthly",
    passDays: 0,
    scanLimit: 1_000_000,
    premiumClassification: true,
    scheduledRescan: true,
    maxAccounts: 5,
  },

  /**
   * LEGACY, grant-only. Retired from the public catalogue when OAuth
   * verification cleared.
   *
   * The founding offer was sold on a specific, honest promise printed on the
   * pricing page: "Google caps unverified apps at 100 users while its review
   * runs... when it lifts, the lifetime deal ends." The review has cleared, so
   * the condition the scarcity rested on is gone. Continuing to sell "only 100
   * exist" would be manufactured scarcity — the exact thing the original
   * comment said it was avoiding.
   *
   * Kept here so any seat granted by hand keeps working, unmetered, forever.
   */
  founding: {
    plan: "founding",
    monthlyMessages: Number.MAX_SAFE_INTEGER,
    monthlyUnsubs: 100,
    refill: "never",
    passDays: 0,
    scanLimit: 1_000_000,
    premiumClassification: true,
    scheduledRescan: true,
    maxAccounts: 5,
  },

  /** LEGACY. Never sold; retained only so an existing row cannot fail lookup. */
  starter: {
    plan: "starter",
    monthlyMessages: 25_000,
    monthlyUnsubs: 25,
    refill: "monthly",
    passDays: 0,
    scanLimit: 250_000,
    premiumClassification: true,
    scheduledRescan: false,
    maxAccounts: 1,
  },
};

export function entitlementsFor(userId: string): Entitlements {
  const row = db.prepare(`SELECT plan FROM users WHERE id = ?`).get(userId) as
    | { plan: Plan }
    | undefined;
  return PLANS[row?.plan ?? "free"] ?? PLANS.free;
}

export function planDetails(plan: Plan): Entitlements {
  return PLANS[plan] ?? PLANS.free;
}

/** Calendar-month key, e.g. "2026-09". */
export function currentPeriod(): string {
  return periodKey();
}

function periodKey(at: number = now()): string {
  const d = new Date(at);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

export interface Quota {
  plan: Plan;
  messagesUsed: number;
  messagesLimit: number;
  messagesLeft: number;
  unsubsUsed: number;
  unsubsLimit: number;
  unsubsLeft: number;
  refill: Refill;
  /** When a `pass` plan lapses, or null. */
  expiresAt: number | null;
  /** True when this read performed a monthly refill or a lapse. */
  changed: boolean;
}

interface UserQuotaRow {
  plan: Plan;
  messages_used: number;
  unsubs_used: number;
  quota_period: string | null;
  plan_expires_at: number | null;
}

/**
 * The single source of truth on what a user has left, and the only place the
 * counters are allowed to roll over.
 *
 * Rollover happens lazily, on read, rather than from a scheduled job. A cron
 * that resets every user at midnight is a moving part that can fail silently
 * and hand somebody a free month; deriving the window from the row itself
 * cannot drift, because the stored period IS the answer to "which window is
 * this count for".
 */
export function quotaFor(userId: string): Quota {
  const row = db
    .prepare(
      `SELECT plan, messages_used, unsubs_used, quota_period, plan_expires_at
       FROM users WHERE id = ?`,
    )
    .get(userId) as UserQuotaRow | undefined;

  if (!row) {
    const free = PLANS.free;
    return {
      plan: "free",
      messagesUsed: 0,
      messagesLimit: free.monthlyMessages,
      messagesLeft: free.monthlyMessages,
      unsubsUsed: 0,
      unsubsLimit: free.monthlyUnsubs,
      unsubsLeft: free.monthlyUnsubs,
      refill: "monthly",
      expiresAt: null,
      changed: false,
    };
  }

  let plan = row.plan;
  let ent = PLANS[plan] ?? PLANS.free;
  let used = row.messages_used ?? 0;
  let unsubs = row.unsubs_used ?? 0;
  let changed = false;

  // A lapsed pass falls back to free, and the counters start over — the free
  // month they land in should not already be spent by the pass they just used.
  if (ent.refill === "pass" && row.plan_expires_at !== null && now() > row.plan_expires_at) {
    plan = "free";
    ent = PLANS.free;
    used = 0;
    unsubs = 0;
    changed = true;
    db.prepare(
      `UPDATE users SET plan = 'free', plan_expires_at = NULL, messages_used = 0,
       unsubs_used = 0, quota_period = ?, updated_at = ? WHERE id = ?`,
    ).run(periodKey(), now(), userId);
  }

  // Monthly refill. A pass never refills; a lifetime grant is never metered.
  if (ent.refill === "monthly") {
    const current = periodKey();
    if (row.quota_period !== current) {
      used = 0;
      unsubs = 0;
      changed = true;
      db.prepare(
        `UPDATE users SET messages_used = 0, unsubs_used = 0, quota_period = ?, updated_at = ?
         WHERE id = ?`,
      ).run(current, now(), userId);
    }
  }

  return {
    plan,
    messagesUsed: used,
    messagesLimit: ent.monthlyMessages,
    messagesLeft: Math.max(0, ent.monthlyMessages - used),
    unsubsUsed: unsubs,
    unsubsLimit: ent.monthlyUnsubs,
    unsubsLeft: Math.max(0, ent.monthlyUnsubs - unsubs),
    refill: ent.refill,
    expiresAt: ent.refill === "pass" ? row.plan_expires_at : null,
    changed,
  };
}

export interface Gate {
  allowed: boolean;
  reason?: string;
  upgradeRequired?: boolean;
  /** How much of the request the remaining allowance would cover. */
  allowance?: number;
}

/**
 * Server-side enforcement. The client is never trusted to know its own limits —
 * both the plan call and the execute call re-check here.
 *
 * A batch is all-or-nothing against the quota. Partially executing a cleanup
 * the user reviewed and approved would apply something different from what
 * they confirmed, and the confirm screen is the product's central safety
 * promise. Better to refuse with the number and let them narrow the selection.
 */
export function canCleanMessages(userId: string, count: number): Gate {
  const q = quotaFor(userId);
  if (q.messagesLimit === Number.MAX_SAFE_INTEGER) return { allowed: true };
  if (count <= q.messagesLeft) return { allowed: true };

  const scope = q.refill === "pass" ? "on your Backlog Pass" : "this month";
  return {
    allowed: false,
    upgradeRequired: true,
    allowance: q.messagesLeft,
    reason:
      q.messagesLeft === 0
        ? `You have used all ${q.messagesLimit.toLocaleString()} messages ${scope}. ` +
          `The Backlog Pass clears up to 50,000 in one go for ₹299.`
        : `This cleanup covers ${count.toLocaleString()} messages and you have ` +
          `${q.messagesLeft.toLocaleString()} left ${scope}. Narrow the selection, or ` +
          `take the Backlog Pass — 50,000 messages for ₹299.`,
  };
}

export function canUnsubscribe(userId: string): Gate {
  const q = quotaFor(userId);
  if (q.unsubsLeft > 0) return { allowed: true };
  return {
    allowed: false,
    upgradeRequired: true,
    allowance: 0,
    reason:
      `You have used all ${q.unsubsLimit} unsubscribes ` +
      `${q.refill === "pass" ? "on your Backlog Pass" : "this month"}. ` +
      `Pro raises this to 25 a month.`,
  };
}

/** Counts messages actually cleaned. Called after the executor reports success. */
export function recordMessagesCleaned(userId: string, count: number): void {
  if (count <= 0) return;
  db.prepare(
    `UPDATE users SET messages_used = messages_used + ?, updated_at = ? WHERE id = ?`,
  ).run(count, now(), userId);
}

/**
 * Undo returns the allowance.
 *
 * The 30-day undo is advertised without qualification, so it cannot quietly
 * cost the user their quota — charging for work that was reversed would make
 * undo something people hesitate over, which defeats the point of offering it.
 */
export function refundMessagesCleaned(userId: string, count: number): void {
  if (count <= 0) return;
  db.prepare(
    `UPDATE users SET messages_used = MAX(0, messages_used - ?), updated_at = ? WHERE id = ?`,
  ).run(count, now(), userId);
}

export function recordUnsubscribe(userId: string): void {
  db.prepare(`UPDATE users SET unsubs_used = unsubs_used + 1, updated_at = ? WHERE id = ?`).run(
    now(),
    userId,
  );
}

/**
 * Sets a plan, and starts its clock.
 *
 * A pass gets its expiry stamped here rather than by the caller, so no payment
 * path can mint an accidentally immortal one. Counters reset on every plan
 * change: somebody who just paid should not inherit the spent free allowance
 * that pushed them to pay.
 */
export function setPlan(userId: string, plan: Plan): void {
  const ent = PLANS[plan] ?? PLANS.free;
  const expires = ent.refill === "pass" ? now() + ent.passDays * 24 * 60 * 60 * 1000 : null;
  db.prepare(
    `UPDATE users SET plan = ?, plan_expires_at = ?, messages_used = 0, unsubs_used = 0,
     quota_period = ?, updated_at = ? WHERE id = ?`,
  ).run(plan, expires, periodKey(), now(), userId);
}
