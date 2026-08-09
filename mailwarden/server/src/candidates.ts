import { db } from "./db.js";
import type { CandidateMessage } from "./safety/policy.js";

export type BatchAction = "archive" | "trash";

/**
 * Selects the messages an action could actually affect.
 *
 * This is action-aware for a reason that cost a real user 2,421 messages of
 * confusion: an "archive" of a message already out of the inbox, or a "trash"
 * of something already in the trash, is a no-op that still gets counted,
 * charged against the batch quota, and shown as work done. Filtering here means
 * every count the UI displays is a count of mail that will genuinely move.
 *
 *   archive  only mail currently in the inbox
 *   trash    anything not already in the trash
 *
 * Shared by the executor, the category view, and the recipe tiles so all three
 * agree. They previously each kept their own copy of this query, which is how
 * they could disagree.
 */
export function candidatesFor(
  accountId: string,
  senderKeys: string[],
  action: BatchAction,
): CandidateMessage[] {
  if (senderKeys.length === 0) return [];
  const placeholders = senderKeys.map(() => "?").join(",");
  const stateFilter =
    action === "archive" ? `labels LIKE '%INBOX%'` : `labels NOT LIKE '%TRASH%'`;

  return db
    .prepare(
      `SELECT message_id, sender_key, labels, size_bytes, internal_date
       FROM messages_meta
       WHERE account_id = ? AND sender_key IN (${placeholders})
         AND ${stateFilter}`,
    )
    .all(accountId, ...senderKeys) as CandidateMessage[];
}

/**
 * The label set a message ends up with after an action, derived from the set it
 * had before.
 *
 * Mirrors exactly what we ask Gmail to do in executor.ts — archive removes
 * INBOX, trash removes INBOX and adds TRASH — so the local copy stays a true
 * reflection of the mailbox rather than drifting from it.
 */
export function labelsAfter(priorLabels: string, action: BatchAction): string {
  const set = new Set(priorLabels.split(",").filter(Boolean));
  set.delete("INBOX");
  if (action === "trash") set.add("TRASH");
  return [...set].join(",");
}
