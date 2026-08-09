/**
 * Every tunable safety threshold in one place.
 *
 * These are deliberately conservative. The cost of a limit being too tight is
 * that a user runs two batches instead of one. The cost of a limit being too
 * loose is an irreversible-feeling mistake across someone's entire mail
 * history, which is the single failure that ends this business
 * (docs/02-business-strategy.md §6).
 */
export const LIMITS = {
  /**
   * Mail newer than this is never touched in bulk, whatever its category.
   *
   * Recency is a proxy for "still needed". A shipping notice from three days
   * ago is live; the same notice from 2019 is not. This catches the receipt
   * that arrived while the user was mid-cleanup, which no classifier can see
   * coming.
   */
  recencyProtectionDays: 7,

  /** Hard ceiling on one batch. Above this, split — a partial failure is easier to reason about. */
  maxMessagesPerBatch: 25_000,

  /** Rolling 24h ceiling across all batches for one account. */
  maxMessagesPerDay: 50_000,

  /** Hard ceiling on senders in one batch. */
  maxSendersPerBatch: 500,

  /**
   * A batch touching more than this share of the mailbox needs a second,
   * explicit confirmation. It is almost always intentional — and occasionally
   * it is a misclick that would otherwise be a support ticket.
   */
  scaleAnomalyRatio: 0.4,

  /** Below this confidence a sender is never *suggested*. Users may still choose it. */
  suggestConfidenceFloor: 0.7,

  /**
   * Below this confidence a sender cannot be actioned at all, even on request.
   * If we do not understand a sender, we decline to touch it in bulk and point
   * the user at Gmail instead.
   */
  hardConfidenceFloor: 0.4,

  /** Gmail's own cap on batchModify ids per call. Not ours to raise. */
  gmailBatchModifyLimit: 1000,
} as const;

export const DAY_MS = 86_400_000;
