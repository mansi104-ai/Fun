import { audit, db, now } from "../db.js";
import { candidatesFor, labelsAfter } from "../candidates.js";
import { forgetUserDecisions, recordUserDecisions } from "../classify/index.js";
import { newId } from "../lib/crypto.js";
import { withRetry } from "../lib/retry.js";
import { LIMITS } from "../safety/limits.js";
import {
  assertExecutable,
  evaluate,
  GuardError,
  type CandidateMessage,
  type Exclusion,
  type GuardVerdict,
  type Violation,
} from "../safety/policy.js";
import { gmailFor } from "./client.js";
import { aggregateSenders, type Gmail } from "./sync.js";

export type BatchAction = "archive" | "trash";

export interface BatchPlan {
  batchId: string | null;
  action: BatchAction;
  messageCount: number;
  bytesFreed: number;
  senders: { senderKey: string; count: number }[];
  exclusions: Exclusion[];
  violations: Violation[];
  requiresConfirmation: boolean;
  ok: boolean;
}

/**
 * Stages a batch WITHOUT touching Gmail.
 *
 * Planning and executing are separate on purpose: the plan is what the consent
 * screen renders, and `batch_items` captures every message's prior labels so
 * the action can be reversed exactly. Nothing here is destructive.
 *
 * The guard layer runs here to shape the batch and to tell the user what was
 * excluded and why — but a clean plan is NOT an authorisation to execute.
 * `executeBatch` re-runs every block guard from scratch.
 */
export function planBatch(
  accountId: string,
  action: BatchAction,
  senderKeys: string[],
  confirmed = false,
): BatchPlan {
  if (senderKeys.length === 0) throw new Error("No senders selected.");

  const candidates = candidatesFor(accountId, senderKeys, action);
  const verdict = evaluate({ accountId, action, senderKeys, candidates, confirmed });

  const perSender = new Map<string, number>();
  for (const c of verdict.allowed) perSender.set(c.sender_key, (perSender.get(c.sender_key) ?? 0) + 1);

  const base = {
    action,
    messageCount: verdict.allowed.length,
    bytesFreed: verdict.allowed.reduce((sum, c) => sum + c.size_bytes, 0),
    senders: [...perSender].map(([senderKey, count]) => ({ senderKey, count })),
    exclusions: verdict.exclusions,
    violations: verdict.violations,
    requiresConfirmation: verdict.requiresConfirmation,
    ok: verdict.ok,
  };

  // A blocked or unconfirmed batch is never persisted — there must be no
  // half-authorised batch row lying around for a later call to pick up.
  if (!verdict.ok || verdict.allowed.length === 0) {
    return { ...base, batchId: null };
  }

  const batchId = newId("bat");
  db.transaction(() => {
    db.prepare(
      `INSERT INTO batches
         (id, account_id, status, action, message_count, bytes_freed, created_at,
          guard_report, excluded_count)
       VALUES (?, ?, 'pending', ?, ?, ?, ?, ?, ?)`,
    ).run(
      batchId,
      accountId,
      action,
      base.messageCount,
      base.bytesFreed,
      now(),
      JSON.stringify({ exclusions: verdict.exclusions, violations: verdict.violations }),
      verdict.exclusions.reduce((sum, e) => sum + e.messageCount, 0),
    );

    const insert = db.prepare(
      `INSERT INTO batch_items (batch_id, message_id, sender_key, prior_labels)
       VALUES (?, ?, ?, ?)`,
    );
    for (const c of verdict.allowed) insert.run(batchId, c.message_id, c.sender_key, c.labels);
  })();

  return { ...base, batchId };
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * Executes a previously-planned batch.
 *
 * Guard re-validation happens here, not just at plan time. A sender can be
 * reclassified, pinned, or replied to between planning and execution; acting on
 * a stale verdict is precisely the bug that loses someone a boarding pass. If
 * re-validation narrows the batch, the removed messages are dropped from
 * batch_items so undo stays exact.
 *
 * Idempotent per message: `applied` is set per chunk, so a crash mid-run
 * resumes without re-touching completed messages.
 *
 * "archive" removes INBOX. "trash" adds TRASH, which Gmail auto-purges after
 * 30 days. We never call messages.delete — gmail.modify does not grant it, and
 * that limitation is the product's core safety promise.
 */
export async function executeBatch(
  accountId: string,
  batchId: string,
  userId?: string,
): Promise<GuardVerdict> {
  const batch = db
    .prepare(`SELECT id, action, status FROM batches WHERE id = ? AND account_id = ?`)
    .get(batchId, accountId) as { id: string; action: BatchAction; status: string } | undefined;

  if (!batch) throw new Error("Batch not found.");
  if (batch.status === "done") throw new Error("Batch already executed.");
  if (batch.status === "undone") throw new Error("Batch was undone and cannot be re-run.");

  const items = db
    .prepare(`SELECT message_id, sender_key, prior_labels FROM batch_items WHERE batch_id = ?`)
    .all(batchId) as { message_id: string; sender_key: string; prior_labels: string }[];

  // ── Re-validate against current state ────────────────────────────────
  //
  // Read straight from messages_meta rather than reconstructing from
  // batch_items. The per-message guards need thread_id and has_attachment, and
  // a re-validation missing those fields would be weaker than the plan-time
  // check it exists to double — the exact shape of hole this step prevents.
  // (It also replaces an N+1 query with one.)
  const metaById = new Map(
    (
      db
        .prepare(
          `SELECT message_id, sender_key, labels, size_bytes, internal_date,
                  thread_id, has_attachment
           FROM messages_meta WHERE account_id = ?`,
        )
        .all(accountId) as CandidateMessage[]
    ).map((m) => [m.message_id, m]),
  );

  const candidates: CandidateMessage[] = items.map(
    (i) =>
      metaById.get(i.message_id) ?? {
        // A message we no longer hold metadata for cannot be vouched for.
        // internal_date 0 makes it look ancient, so the recency guard will not
        // save it — but every other guard still applies, and UNKNOWN_SENDER
        // will fire if its sender is gone too.
        message_id: i.message_id,
        sender_key: i.sender_key,
        labels: i.prior_labels,
        size_bytes: 0,
        internal_date: 0,
        thread_id: null,
        has_attachment: 0,
      },
  );

  let verdict: GuardVerdict;
  try {
    verdict = assertExecutable({
      accountId,
      action: batch.action,
      senderKeys: [...new Set(items.map((i) => i.sender_key))],
      candidates,
    });
  } catch (err) {
    if (err instanceof GuardError) {
      db.prepare(`UPDATE batches SET status = 'failed', error = ? WHERE id = ?`).run(
        `Blocked by safety policy: ${err.message}`,
        batchId,
      );
      if (userId) audit(userId, "batch.blocked", { batchId, violations: err.violations });
    }
    throw err;
  }

  // Drop anything re-validation removed, so undo mirrors reality exactly.
  const stillAllowed = new Set(verdict.allowed.map((c) => c.message_id));
  const revoked = items.filter((i) => !stillAllowed.has(i.message_id));
  if (revoked.length > 0) {
    db.transaction(() => {
      const del = db.prepare(`DELETE FROM batch_items WHERE batch_id = ? AND message_id = ?`);
      for (const r of revoked) del.run(batchId, r.message_id);
      db.prepare(`UPDATE batches SET message_count = ? WHERE id = ?`).run(
        stillAllowed.size,
        batchId,
      );
    })();
    if (userId) {
      audit(userId, "batch.narrowed_on_execute", { batchId, removed: revoked.length });
    }
  }

  /**
   * Refresh prior_labels to the state immediately BEFORE we act.
   *
   * They were captured at plan time, which can be minutes earlier. If the user
   * starred a message, or Gmail re-categorised it, in the gap, undo would
   * restore the stale plan-time labels and silently discard that change. The
   * guarantee is "back to how it was before the action", not "before the plan".
   */
  db.transaction(() => {
    const refresh = db.prepare(
      `UPDATE batch_items SET prior_labels = ? WHERE batch_id = ? AND message_id = ?`,
    );
    for (const i of items) {
      const current = metaById.get(i.message_id);
      if (current && current.labels !== i.prior_labels) {
        refresh.run(current.labels, batchId, i.message_id);
        i.prior_labels = current.labels;
      }
    }
  })();

  // ── Execute ──────────────────────────────────────────────────────────
  db.prepare(`UPDATE batches SET status = 'running' WHERE id = ?`).run(batchId);

  try {
    const gmail = await gmailFor(accountId);
    const pending = (
      db
        .prepare(`SELECT message_id FROM batch_items WHERE batch_id = ? AND applied = 0`)
        .all(batchId) as { message_id: string }[]
    ).map((r) => r.message_id);

    const mod =
      batch.action === "archive"
        ? { removeLabelIds: ["INBOX"] }
        : { addLabelIds: ["TRASH"], removeLabelIds: ["INBOX"] };

    const priorById = new Map(items.map((i) => [i.message_id, i.prior_labels]));

    for (const ids of chunk(pending, LIMITS.gmailBatchModifyLimit)) {
      await withRetry(
        () => gmail.users.messages.batchModify({ userId: "me", requestBody: { ids, ...mod } }),
        { label: `batchModify(${ids.length})` },
      );

      db.transaction(() => {
        const mark = db.prepare(
          `UPDATE batch_items SET applied = 1 WHERE batch_id = ? AND message_id = ?`,
        );
        // Mirror the change into our own copy of the mailbox.
        //
        // Without this the app tells Gmail to move 2,400 messages, Gmail does
        // it, and every count in the UI is then recomputed from metadata that
        // still says they are sitting in the inbox — so nothing appears to
        // happen, and the same messages get offered for the same action again.
        // Observed in production. The write is inside the same transaction as
        // the `applied` flag so the two can never disagree.
        const relabel = db.prepare(
          `UPDATE messages_meta SET labels = ? WHERE account_id = ? AND message_id = ?`,
        );
        for (const id of ids) {
          mark.run(batchId, id);
          const prior = priorById.get(id);
          if (prior !== undefined) {
            relabel.run(labelsAfter(prior, batch.action), accountId, id);
          }
        }
      })();
    }

    // Sender rows are derived from messages_meta, so they need recomputing
    // before the next read or the per-sender counts stay stale too.
    aggregateSenders(accountId);

    db.prepare(`UPDATE batches SET status = 'done', completed_at = ? WHERE id = ?`).run(
      now(),
      batchId,
    );

    // Feed the outcome back into classification. The user just told us, by
    // acting, what they want done with these senders — that is better evidence
    // than anything a classifier can infer, and it costs nothing to keep.
    recordUserDecisions(
      accountId,
      [...new Set(items.map((i) => i.sender_key))],
      batch.action,
    );

    return verdict;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Stays 'failed' with applied flags intact — re-running resumes rather
    // than repeating.
    db.prepare(`UPDATE batches SET status = 'failed', error = ? WHERE id = ?`).run(message, batchId);
    throw err;
  }
}

export interface UndoResult {
  /** Messages Gmail confirmed are back exactly as they were. */
  restored: number;
  /** Messages we could not restore; surfaced rather than silently dropped. */
  failed: number;
  /** Gmail read back a state that does not match. Not restored. */
  mismatched: number;
  /**
   * Gmail no longer has these at all — trashed mail purged after its 30 days.
   * Reported separately because it is the one outcome nothing can reverse.
   */
  missing: number;
  /** False when verification could not run; `restored` is then unproven. */
  verified: boolean;
}

/** Labels Mailwarden itself changes, and therefore the ones it must restore. */
const OWNED_LABELS = ["INBOX", "TRASH"] as const;

/**
 * Pages an id-only search. Listing returns 500 ids per call and no message
 * bodies, which makes reading back the state of a 2,400-message undo a handful
 * of requests instead of 2,400 individual fetches.
 */
async function idsMatching(gmail: Gmail, q: string): Promise<Set<string>> {
  const out = new Set<string>();
  let pageToken: string | undefined;
  do {
    const res = await withRetry(
      () => gmail.users.messages.list({ userId: "me", q, maxResults: 500, pageToken }),
      { label: `list(${q})` },
    );
    for (const m of res.data.messages ?? []) if (m.id) out.add(m.id);
    pageToken = res.data.nextPageToken ?? undefined;
  } while (pageToken);
  return out;
}

/**
 * Restores every message in a batch to the labels it carried beforehand.
 *
 * This is a primary product feature, not an error path — it is the reason a
 * user can click "Archive 2,341" without hesitating, and it is why the receipt
 * screen keeps an Undo button rather than burying one in a menu.
 *
 * Undo is deliberately NOT guarded: restoring mail to where it was can never
 * harm the user, and a guard that blocked a restore would be strictly worse
 * than one that didn't exist.
 */
export async function undoBatch(accountId: string, batchId: string): Promise<UndoResult> {
  const batch = db
    .prepare(`SELECT id, action, status FROM batches WHERE id = ? AND account_id = ?`)
    .get(batchId, accountId) as { id: string; action: BatchAction; status: string } | undefined;

  if (!batch) throw new Error("Batch not found.");
  // Already fully reversed and verified — nothing left to do, and re-running
  // would report a second "restore" of messages that never moved.
  if (batch.status === "undone") {
    return { restored: 0, failed: 0, mismatched: 0, missing: 0, verified: true };
  }
  if (batch.status === "pending") throw new Error("Batch was never executed — nothing to undo.");

  const gmail = await gmailFor(accountId);
  const items = db
    .prepare(
      `SELECT message_id, sender_key, prior_labels FROM batch_items
       WHERE batch_id = ? AND applied = 1`,
    )
    .all(batchId) as { message_id: string; sender_key: string; prior_labels: string }[];

  // Group by the label set to restore so each distinct prior state is one call.
  const groups = new Map<string, string[]>();
  for (const item of items) {
    let ids = groups.get(item.prior_labels);
    if (!ids) groups.set(item.prior_labels, (ids = []));
    ids.push(item.message_id);
  }

  let failed = 0;
  const markRestored = db.prepare(
    `UPDATE batch_items SET restored = 1 WHERE batch_id = ? AND message_id = ?`,
  );

  // ── Phase 1: ask Gmail to put everything back ────────────────────────
  for (const [priorLabels, allIds] of groups) {
    const prior = new Set(priorLabels.split(",").filter(Boolean));
    // Derived from the recorded prior state rather than assumed from the
    // action, so a message that was already out of the inbox stays out.
    const add = OWNED_LABELS.filter((l) => prior.has(l));
    const remove = OWNED_LABELS.filter((l) => !prior.has(l));

    for (const ids of chunk(allIds, LIMITS.gmailBatchModifyLimit)) {
      try {
        await withRetry(
          () =>
            gmail.users.messages.batchModify({
              userId: "me",
              requestBody: { ids, addLabelIds: add, removeLabelIds: remove },
            }),
          { label: `undo batchModify(${ids.length})` },
        );
        db.transaction(() => {
          for (const id of ids) markRestored.run(batchId, id);
        })();
      } catch (err) {
        // Partial undo is better than none. Report the shortfall rather than
        // failing the whole restore.
        console.error("[undo] chunk failed:", err);
        failed += ids.length;
      }
    }
  }

  /**
   * ── Phase 2: read Gmail back and prove it ──────────────────────────────
   *
   * A 200 from batchModify means the request was accepted, not that the
   * mailbox now matches. batchModify also succeeds silently for ids Gmail no
   * longer has — so mail permanently purged from Trash after its 30 days would
   * otherwise be reported as restored. The guarantee is only worth stating if
   * something checks it.
   *
   * Verification compares only INBOX and TRASH: those are the labels
   * Mailwarden changes, so they are the ones it is responsible for restoring.
   * If the user starred a message after the action, undo must not strip that.
   */
  let verified = false;
  let mismatched = 0;
  let missing = 0;

  try {
    const [inInbox, inTrash] = await Promise.all([
      idsMatching(gmail, "in:inbox"),
      idsMatching(gmail, "in:trash"),
    ]);
    verified = true;

    const setVerify = db.prepare(
      `UPDATE batch_items SET verify_state = ? WHERE batch_id = ? AND message_id = ?`,
    );
    const relabel = db.prepare(
      `UPDATE messages_meta SET labels = ? WHERE account_id = ? AND message_id = ?`,
    );

    db.transaction(() => {
      for (const item of items) {
        const prior = new Set(item.prior_labels.split(",").filter(Boolean));
        const wantInbox = prior.has("INBOX");
        const wantTrash = prior.has("TRASH");
        const hasInbox = inInbox.has(item.message_id);
        const hasTrash = inTrash.has(item.message_id);

        if (hasInbox === wantInbox && hasTrash === wantTrash) {
          setVerify.run("verified", batchId, item.message_id);
          // Only now is the local copy known to match the mailbox.
          relabel.run(item.prior_labels, accountId, item.message_id);
        } else if (!hasInbox && !hasTrash && wantInbox) {
          // Expected in the inbox, present in neither list. Either purged, or
          // archived by someone else. Distinguished below.
          setVerify.run("missing", batchId, item.message_id);
          missing++;
        } else {
          setVerify.run("mismatch", batchId, item.message_id);
          mismatched++;
        }
      }
    })();
  } catch (err) {
    // Verification failing does not undo the undo — Phase 1 already ran. It
    // means we cannot *prove* the result, which is reported rather than hidden.
    console.error("[undo] verification pass failed:", err);
  }

  const restored = (
    db
      .prepare(
        `SELECT COUNT(*) c FROM batch_items
         WHERE batch_id = ? AND restored = 1 AND (verify_state = 'verified' OR verify_state IS NULL)`,
      )
      .get(batchId) as { c: number }
  ).c;

  const clean = failed === 0 && mismatched === 0 && missing === 0;

  if (clean) {
    db.prepare(`UPDATE batches SET status = 'undone', undone_at = ?, error = NULL WHERE id = ?`)
      .run(now(), batchId);
    aggregateSenders(accountId);
    // The user reversed this, so unlearn it — see forgetUserDecisions.
    forgetUserDecisions(accountId, [...new Set(items.map((i) => i.sender_key))]);
  } else {
    // Left as 'done', not 'undone': the batch is not fully reversed, and
    // re-running undo is safe — restoring a label twice is a no-op.
    db.prepare(`UPDATE batches SET error = ? WHERE id = ?`).run(
      `Undo incomplete — ${failed} failed, ${mismatched} did not match, ${missing} no longer in Gmail.`,
      batchId,
    );
    aggregateSenders(accountId);
  }

  console.log(
    `[undo] ${batchId}: restored ${restored}, failed ${failed}, ` +
      `mismatched ${mismatched}, missing ${missing}, verified=${verified}`,
  );

  return { restored, failed, mismatched, missing, verified };
}
