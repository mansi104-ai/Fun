import { audit, db, now } from "../db.js";
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

function candidatesFor(accountId: string, senderKeys: string[]): CandidateMessage[] {
  if (senderKeys.length === 0) return [];
  const placeholders = senderKeys.map(() => "?").join(",");
  return db
    .prepare(
      `SELECT message_id, sender_key, labels, size_bytes, internal_date
       FROM messages_meta
       WHERE account_id = ? AND sender_key IN (${placeholders})
         AND labels NOT LIKE '%TRASH%'`,
    )
    .all(accountId, ...senderKeys) as CandidateMessage[];
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

  const candidates = candidatesFor(accountId, senderKeys);
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
  const candidates: CandidateMessage[] = items.map((i) => ({
    message_id: i.message_id,
    sender_key: i.sender_key,
    labels: i.prior_labels,
    size_bytes: 0,
    internal_date:
      (
        db
          .prepare(`SELECT internal_date FROM messages_meta WHERE account_id = ? AND message_id = ?`)
          .get(accountId, i.message_id) as { internal_date: number } | undefined
      )?.internal_date ?? 0,
  }));

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

    for (const ids of chunk(pending, LIMITS.gmailBatchModifyLimit)) {
      await withRetry(
        () => gmail.users.messages.batchModify({ userId: "me", requestBody: { ids, ...mod } }),
        { label: `batchModify(${ids.length})` },
      );

      db.transaction(() => {
        const mark = db.prepare(
          `UPDATE batch_items SET applied = 1 WHERE batch_id = ? AND message_id = ?`,
        );
        for (const id of ids) mark.run(batchId, id);
      })();
    }

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
  restored: number;
  /** Messages we could not restore; surfaced rather than silently dropped. */
  failed: number;
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
  if (batch.status === "undone") return { restored: 0, failed: 0 };
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

  let restored = 0;
  let failed = 0;

  for (const [priorLabels, allIds] of groups) {
    const hadInbox = priorLabels.split(",").includes("INBOX");
    const add = hadInbox ? ["INBOX"] : [];
    const remove = batch.action === "trash" ? ["TRASH"] : [];
    if (add.length === 0 && remove.length === 0) continue;

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
        restored += ids.length;
      } catch (err) {
        // Partial undo is better than none. Report the shortfall rather than
        // failing the whole restore.
        console.error("[undo] chunk failed:", err);
        failed += ids.length;
      }
    }
  }

  if (failed === 0) {
    db.prepare(`UPDATE batches SET status = 'undone', undone_at = ? WHERE id = ?`).run(
      now(),
      batchId,
    );
    // The user reversed this, so unlearn it — see forgetUserDecisions.
    forgetUserDecisions(accountId, [...new Set(items.map((i) => i.sender_key))]);
  } else {
    db.prepare(`UPDATE batches SET error = ? WHERE id = ?`).run(
      `Undo partially failed: ${failed} message(s) not restored.`,
      batchId,
    );
  }

  return { restored, failed };
}
