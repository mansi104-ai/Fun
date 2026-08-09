import { db } from "../db.js";

export type Plan = "free" | "starter" | "pro";

export interface Entitlements {
  plan: Plan;
  /**
   * Completed cleanups allowed. Counted in BATCHES, not senders — one free
   * batch may cover any number of senders.
   *
   * This is load-bearing. Metering the free tier by sender would make every
   * one-click recipe unusable for free users, which is precisely the
   * paywall-before-value failure documented in docs/00 §2a. The free tier must
   * finish a real job; the paywall belongs on the *second* job.
   */
  freeBatches: number;
  /** Messages scanned during sync. */
  scanLimit: number;
  /** Paid tier routes classification to Anthropic instead of OpenRouter. */
  premiumClassification: boolean;
  scheduledRescan: boolean;
  maxAccounts: number;
}

/**
 * The free tier deliberately allows ONE complete cleanup — the user picks their
 * worst sender and we execute it end to end, real archives, real numbers.
 *
 * This is the direct answer to the dominant complaint about our competitors
 * (docs/00 §2a): a paywall that appears after value is demonstrated but before
 * it is delivered produces refunds and 1-star reviews. Paywalling *after* the
 * first cleanup produces a screenshot instead.
 */
const PLANS: Record<Plan, Entitlements> = {
  free: {
    plan: "free",
    /**
     * TEMPORARILY UNLIMITED — pre-launch, single operator, no billing wired.
     *
     * The intended value is 1: one complete cleanup free, then the paywall.
     * That number is the whole monetisation model (docs/02 §3), so this is a
     * setting to restore, not a decision that was reversed.
     *
     * RESTORE TO 1 before the first paying user, and note that with Stripe
     * unbuilt there is currently no upgrade path at all — shipping `1` while
     * checkout does not exist would hard-block every user after one cleanup.
     * Order matters: Stripe first (iterations 24–27), then this back to 1.
     */
    freeBatches: Number.MAX_SAFE_INTEGER,
    scanLimit: 25_000,
    premiumClassification: false,
    scheduledRescan: false,
    maxAccounts: 1,
  },
  starter: {
    plan: "starter",
    freeBatches: Number.MAX_SAFE_INTEGER,
    scanLimit: 250_000,
    premiumClassification: true,
    scheduledRescan: false,
    maxAccounts: 1,
  },
  pro: {
    plan: "pro",
    freeBatches: Number.MAX_SAFE_INTEGER,
    scanLimit: 1_000_000,
    premiumClassification: true,
    scheduledRescan: true,
    maxAccounts: 5,
  },
};

export function entitlementsFor(userId: string): Entitlements {
  const row = db.prepare(`SELECT plan FROM users WHERE id = ?`).get(userId) as
    | { plan: Plan }
    | undefined;
  return PLANS[row?.plan ?? "free"] ?? PLANS.free;
}

export interface Gate {
  allowed: boolean;
  reason?: string;
  upgradeRequired?: boolean;
}

/**
 * Server-side enforcement. The client is never trusted to know its own limits —
 * every execute call re-checks here.
 *
 * Note there is no sender-count check: a free batch may be as large as the
 * guardrails permit. The free tier is limited in *how many times* you can
 * clean, never in how much one cleanup accomplishes.
 */
export function canExecuteBatch(userId: string): Gate {
  const ent = entitlementsFor(userId);
  if (ent.plan !== "free") return { allowed: true };

  const used =
    (
      db.prepare(`SELECT free_batch_used FROM users WHERE id = ?`).get(userId) as
        | { free_batch_used: number }
        | undefined
    )?.free_batch_used ?? 0;

  if (used >= ent.freeBatches) {
    return {
      allowed: false,
      upgradeRequired: true,
      reason:
        "That was your free cleanup — and it was a real one, nothing held back. " +
        "Upgrade to keep going and to keep your inbox clean automatically.",
    };
  }
  return { allowed: true };
}

/** Counts one completed cleanup, whatever its size. */
export function recordFreeBatchUse(userId: string): void {
  db.prepare(
    `UPDATE users SET free_batch_used = free_batch_used + 1, updated_at = ? WHERE id = ?`,
  ).run(Date.now(), userId);
}

export function setPlan(userId: string, plan: Plan): void {
  db.prepare(`UPDATE users SET plan = ?, updated_at = ? WHERE id = ?`).run(plan, Date.now(), userId);
}
