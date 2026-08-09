import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { audit, db } from "../db.js";
import { classifyAccount, isSuggestable } from "../classify/index.js";
import { ReconnectRequired } from "../gmail/client.js";
import { executeBatch, planBatch, undoBatch, type BatchAction } from "../gmail/executor.js";
import { listSenderMessages, readMessage } from "../gmail/reader.js";
import { runSync, syncProgress } from "../gmail/sync.js";
import { unsubscribeFromSender } from "../gmail/unsubscribe.js";
import {
  canExecuteBatch,
  entitlementsFor,
  recordFreeBatchUse,
} from "../lib/entitlements.js";
import { computeCategories, senderKeysForCategory } from "../categories.js";
import { computeRecipes, recipeById } from "../recipes.js";
import { LIMITS } from "../safety/limits.js";
import { GuardError } from "../safety/policy.js";
import { currentUserId } from "./auth.js";
import { demoEnabled } from "./demo.js";

interface Ctx {
  userId: string;
  accountId: string;
}

function requireAccount(req: FastifyRequest, reply: FastifyReply): Ctx | null {
  const userId = currentUserId(req.cookies);
  if (!userId) {
    reply.code(401).send({ error: "not_authenticated" });
    return null;
  }
  const account = db.prepare(`SELECT id FROM accounts WHERE user_id = ? LIMIT 1`).get(userId) as
    | { id: string }
    | undefined;
  if (!account) {
    reply.code(404).send({ error: "no_account_connected" });
    return null;
  }
  return { userId, accountId: account.id };
}

export async function apiRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/me", async (req, reply) => {
    const userId = currentUserId(req.cookies);
    if (!userId) return reply.code(401).send({ error: "not_authenticated" });

    const user = db.prepare(`SELECT id, email, plan, free_batch_used FROM users WHERE id = ?`).get(
      userId,
    ) as { id: string; email: string; plan: string; free_batch_used: number };

    const account = db
      .prepare(`SELECT id, email, sync_state, last_sync_at FROM accounts WHERE user_id = ? LIMIT 1`)
      .get(userId) as
      | { id: string; email: string; sync_state: string; last_sync_at: number | null }
      | undefined;

    return {
      user,
      account: account ?? null,
      entitlements: entitlementsFor(userId),
      // Lets the UI show a demo banner and disable actions that would need a
      // real Gmail token.
      demo: demoEnabled() && user.email.endsWith("@mailwarden.local"),
    };
  });

  // ── Scan ───────────────────────────────────────────────────────────────

  app.post<{ Body: { force?: boolean } }>("/api/scan", async (req, reply) => {
    const ctx = requireAccount(req, reply);
    if (!ctx) return;

    // A scan already in flight must not be started twice — two concurrent
    // syncs on the same account interleave writes and corrupt the history
    // cursor, which would silently break every later incremental pass.
    const state = db.prepare(`SELECT sync_state FROM accounts WHERE id = ?`).get(ctx.accountId) as {
      sync_state: string;
    };
    if (state.sync_state === "running") return { started: false, alreadyRunning: true };

    const ent = entitlementsFor(ctx.userId);
    const force = req.body?.force === true;

    // Fire and forget; the client polls /api/scan/progress.
    void runSync(ctx.accountId, ent.scanLimit, { force })
      .then(() => classifyAccount(ctx.accountId, ent.premiumClassification))
      .then((report) => audit(ctx.userId, "scan.completed", report))
      .catch((err: unknown) => {
        console.error("[scan] failed:", err);
        audit(ctx.userId, "scan.failed", { message: String(err) });
      });

    return { started: true };
  });

  app.get("/api/scan/progress", async (req, reply) => {
    const ctx = requireAccount(req, reply);
    if (!ctx) return;
    const state = db.prepare(`SELECT sync_state FROM accounts WHERE id = ?`).get(ctx.accountId) as {
      sync_state: string;
    };
    return {
      ...(syncProgress(ctx.accountId) ?? { scanned: 0, senders: 0, bytes: 0, done: false, mode: "full" as const }),
      state: state.sync_state,
    };
  });

  /**
   * Iteration 7 — live scan progress over SSE.
   *
   * The first scan is a 2–6 minute wait and it is where users abandon. A
   * stream that shows counts climbing reads as work being done; a spinner
   * reads as a hang. The polling endpoint above stays as a fallback for
   * clients without EventSource.
   */
  app.get("/api/scan/stream", (req, reply) => {
    const ctx = requireAccount(req, reply);
    if (!ctx) return;

    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no", // stop nginx buffering the stream
    });

    const send = (data: unknown): void => {
      reply.raw.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    const tick = setInterval(() => {
      const state = db.prepare(`SELECT sync_state FROM accounts WHERE id = ?`).get(ctx.accountId) as
        | { sync_state: string }
        | undefined;
      const progress = syncProgress(ctx.accountId) ?? {
        scanned: 0, senders: 0, bytes: 0, done: false, mode: "full" as const,
      };
      send({ ...progress, state: state?.sync_state ?? "idle" });

      if (progress.done && state?.sync_state !== "running") {
        clearInterval(tick);
        reply.raw.end();
      }
    }, 800);

    // Without this, an abandoned tab leaks an interval per reload.
    req.raw.on("close", () => clearInterval(tick));
  });

  // ── Review ─────────────────────────────────────────────────────────────

  app.get("/api/senders", async (req, reply) => {
    const ctx = requireAccount(req, reply);
    if (!ctx) return;

    const rows = db
      .prepare(
        `SELECT sender_key, display_name, domain, message_count, unread_count, total_bytes,
                first_seen, last_seen, has_unsubscribe, category, confidence, reason,
                protected, user_protected, user_decision, classified_by,
                unsubscribed_at, unsubscribe_status, unsubscribe_method
         FROM senders WHERE account_id = ? AND message_count > 0
         ORDER BY message_count DESC`,
      )
      .all(ctx.accountId) as Record<string, unknown>[];

    return {
      senders: rows.map((r) => ({
        senderKey: r.sender_key,
        displayName: r.display_name,
        domain: r.domain,
        messageCount: r.message_count,
        unreadCount: r.unread_count,
        totalBytes: r.total_bytes,
        firstSeen: r.first_seen,
        lastSeen: r.last_seen,
        hasUnsubscribe: Boolean(r.has_unsubscribe),
        category: r.category,
        confidence: r.confidence,
        reason: r.reason,
        // Effective protection, as the guard layer will actually evaluate it.
        protected: r.user_protected === 1 || (Boolean(r.protected) && r.user_protected !== -1),
        userProtected: r.user_protected as number,
        classifiedBy: r.classified_by,
        userDecision: r.user_decision,
        unsubscribedAt: r.unsubscribed_at,
        unsubscribeStatus: r.unsubscribe_status,
        unsubscribeMethod: r.unsubscribe_method,
        suggested: isSuggestable(r.category as string | null, r.confidence as number | null),
      })),
    };
  });

  // ── Reading mail ───────────────────────────────────────────────────────

  /**
   * Recent messages from one sender, with real subjects.
   *
   * Subjects come from Gmail, not from our database, which stores only a salted
   * hash of each. Nothing fetched here is persisted.
   */
  app.get<{ Params: { key: string }; Querystring: { limit?: string } }>(
    "/api/senders/:key/messages",
    async (req, reply) => {
      const ctx = requireAccount(req, reply);
      if (!ctx) return;

      const senderKey = decodeURIComponent(req.params.key);
      const known = db
        .prepare(`SELECT 1 AS ok FROM senders WHERE account_id = ? AND sender_key = ?`)
        .get(ctx.accountId, senderKey);
      if (!known) return reply.code(404).send({ error: "unknown_sender" });

      try {
        const messages = await listSenderMessages(
          ctx.accountId,
          senderKey,
          Number(req.query.limit ?? 20),
        );
        return { senderKey, messages };
      } catch (err) {
        if (err instanceof ReconnectRequired) {
          return reply.code(409).send({ error: "reconnect_required" });
        }
        throw err;
      }
    },
  );

  /**
   * One message's content, fetched live and never stored.
   *
   * Audited: reading someone's mail is exactly the kind of access that should
   * leave a trail the user can inspect, and the audit log is user-visible at
   * /api/audit. The message id is recorded; the content is not.
   */
  app.get<{ Params: { id: string } }>("/api/messages/:id", async (req, reply) => {
    const ctx = requireAccount(req, reply);
    if (!ctx) return;

    try {
      const message = await readMessage(ctx.accountId, req.params.id);
      // Null means the id is not one of this account's messages. 404, not 403 —
      // confirming existence would leak whether an id is real.
      if (!message) return reply.code(404).send({ error: "message_not_found" });

      audit(ctx.userId, "message.read", { messageId: req.params.id });
      return message;
    } catch (err) {
      if (err instanceof ReconnectRequired) {
        return reply.code(409).send({ error: "reconnect_required" });
      }
      throw err;
    }
  });

  /**
   * Unsubscribe from a sender (roadmap 44).
   *
   * Never bulk. Unsubscribing is an outward-facing act — it tells a third party
   * something about you — so it stays one deliberate click per sender.
   */
  app.post<{ Params: { key: string } }>(
    "/api/senders/:key/unsubscribe",
    async (req, reply) => {
      const ctx = requireAccount(req, reply);
      if (!ctx) return;

      const senderKey = decodeURIComponent(req.params.key);
      const known = db
        .prepare(`SELECT 1 AS ok FROM senders WHERE account_id = ? AND sender_key = ?`)
        .get(ctx.accountId, senderKey);
      if (!known) return reply.code(404).send({ error: "unknown_sender" });

      try {
        const result = await unsubscribeFromSender(ctx.accountId, senderKey);
        audit(ctx.userId, "sender.unsubscribe", {
          senderKey, method: result.method, status: result.status,
        });
        return result;
      } catch (err) {
        if (err instanceof ReconnectRequired) {
          return reply.code(409).send({ error: "reconnect_required" });
        }
        throw err;
      }
    },
  );

  // ── Categories: the browse-by-kind layer ───────────────────────────────

  /**
   * Every category, always — including the protected ones at zero cleanable.
   * A category the user cannot see is a category they assume we missed.
   */
  app.get("/api/categories", async (req, reply) => {
    const ctx = requireAccount(req, reply);
    if (!ctx) return;

    const categories = computeCategories(ctx.accountId);
    const totals = db
      .prepare(
        `SELECT COUNT(*) AS messages, COALESCE(SUM(size_bytes),0) AS bytes
         FROM messages_meta WHERE account_id = ?`,
      )
      .get(ctx.accountId) as { messages: number; bytes: number };

    return {
      categories,
      inbox: totals,
      cleanableTotal: categories.reduce((s, c) => s + c.cleanableMessages, 0),
    };
  });

  /**
   * Plans a whole category, optionally narrowed to a subset of its senders.
   *
   * `senderKeys` from the client can only ever *remove* senders: the server
   * recomputes the category's membership and intersects. A tampered payload
   * therefore cannot smuggle a protected sender into a promotional batch.
   */
  app.post<{
    Params: { id: string };
    Body: { action?: BatchAction; senderKeys?: string[]; confirmed?: boolean };
  }>("/api/categories/:id/plan", async (req, reply) => {
    const ctx = requireAccount(req, reply);
    if (!ctx) return;

    const action = req.body?.action ?? "archive";
    if (action !== "archive" && action !== "trash") {
      return reply.code(400).send({ error: "invalid_action" });
    }

    const keys = senderKeysForCategory(ctx.accountId, req.params.id, req.body?.senderKeys);
    if (keys === null) return reply.code(404).send({ error: "unknown_category" });
    if (keys.length === 0) {
      return reply.code(409).send({
        error: "category_empty",
        message:
          "Nothing here can be cleaned right now — every sender in this category is " +
          "protected, too recent, or you unticked them all.",
      });
    }

    const gate = canExecuteBatch(ctx.userId);
    if (!gate.allowed) {
      return reply.code(402).send({ error: "upgrade_required", message: gate.reason });
    }

    const plan = planBatch(ctx.accountId, action, keys, req.body?.confirmed === true);
    audit(ctx.userId, "category.planned", {
      category: req.params.id,
      batchId: plan.batchId,
      count: plan.messageCount,
      senders: keys.length,
    });

    const payload = { ...plan, category: req.params.id };
    if (!plan.ok) return reply.code(409).send(payload);
    return payload;
  });

  // ── Recipes: the one-click layer ───────────────────────────────────────

  app.get("/api/recipes", async (req, reply) => {
    const ctx = requireAccount(req, reply);
    if (!ctx) return;
    const recipes = computeRecipes(ctx.accountId);
    const totals = db
      .prepare(
        `SELECT COUNT(*) AS messages, COALESCE(SUM(size_bytes),0) AS bytes
         FROM messages_meta WHERE account_id = ?`,
      )
      .get(ctx.accountId) as { messages: number; bytes: number };

    // senderKeys are intentionally withheld — the client never supplies them
    // back, so a tampered payload cannot widen a recipe's scope.
    return {
      recipes: recipes.map(({ senderKeys: _keys, ...rest }) => rest),
      inbox: totals,
    };
  });

  /**
   * Plans a recipe. The sender list is recomputed server-side from the recipe
   * id, so the only thing the client controls is *which* recipe — never its
   * contents.
   */
  app.post<{ Params: { id: string }; Body: { confirmed?: boolean } }>(
    "/api/recipes/:id/plan",
    async (req, reply) => {
      const ctx = requireAccount(req, reply);
      if (!ctx) return;

      const recipe = recipeById(ctx.accountId, req.params.id);
      if (!recipe) return reply.code(404).send({ error: "unknown_recipe" });
      if (recipe.senderKeys.length === 0) {
        return reply.code(409).send({ error: "recipe_empty", message: "Nothing to clean here." });
      }

      const gate = canExecuteBatch(ctx.userId);
      if (!gate.allowed) {
        return reply.code(402).send({ error: "upgrade_required", message: gate.reason });
      }

      const plan = planBatch(
        ctx.accountId,
        recipe.action,
        recipe.senderKeys,
        req.body?.confirmed === true,
      );
      audit(ctx.userId, "recipe.planned", {
        recipe: recipe.id, batchId: plan.batchId, count: plan.messageCount,
      });

      const payload = { ...plan, recipe: { id: recipe.id, title: recipe.title, icon: recipe.icon } };
      if (!plan.ok) return reply.code(409).send(payload);
      return payload;
    },
  );

  // ── Consent loop: plan -> confirm -> execute -> receipt ─────────────────

  app.post<{ Body: { action: BatchAction; senderKeys: string[]; confirmed?: boolean } }>(
    "/api/batches/plan",
    async (req, reply) => {
      const ctx = requireAccount(req, reply);
      if (!ctx) return;

      const { action, senderKeys, confirmed } = req.body ?? {};
      if (action !== "archive" && action !== "trash") {
        return reply.code(400).send({ error: "invalid_action" });
      }
      if (!Array.isArray(senderKeys) || senderKeys.length === 0) {
        return reply.code(400).send({ error: "no_senders" });
      }

      const gate = canExecuteBatch(ctx.userId);
      if (!gate.allowed) {
        return reply.code(402).send({ error: "upgrade_required", message: gate.reason });
      }

      const plan = planBatch(ctx.accountId, action, senderKeys, confirmed === true);
      audit(ctx.userId, "batch.planned", {
        batchId: plan.batchId,
        action,
        count: plan.messageCount,
        excluded: plan.exclusions.length,
        violations: plan.violations.map((v) => v.code),
      });

      // A batch the policy blocked, or one needing a second confirmation, is
      // returned with batchId: null — there is deliberately nothing to execute.
      if (!plan.ok) return reply.code(409).send(plan);
      return plan;
    },
  );

  /** The only endpoint that mutates the user's mailbox. */
  app.post<{ Params: { id: string } }>("/api/batches/:id/execute", async (req, reply) => {
    const ctx = requireAccount(req, reply);
    if (!ctx) return;

    const batch = db
      .prepare(`SELECT id, status FROM batches WHERE id = ? AND account_id = ?`)
      .get(req.params.id, ctx.accountId) as { id: string; status: string } | undefined;
    if (!batch) return reply.code(404).send({ error: "batch_not_found" });
    if (batch.status !== "pending") {
      return reply.code(409).send({ error: "batch_not_pending", status: batch.status });
    }

    const senderCount = (
      db
        .prepare(`SELECT COUNT(DISTINCT sender_key) c FROM batch_items WHERE batch_id = ?`)
        .get(batch.id) as { c: number }
    ).c;

    // Re-check server-side: the plan call is not a durable authorisation.
    const gate = canExecuteBatch(ctx.userId);
    if (!gate.allowed) {
      return reply.code(402).send({ error: "upgrade_required", message: gate.reason });
    }

    try {
      await executeBatch(ctx.accountId, batch.id, ctx.userId);
    } catch (err) {
      // A guard rejection at execute time is a 409, not a 500 — the request was
      // well-formed, the policy declined it.
      if (err instanceof GuardError) {
        return reply
          .code(409)
          .send({ error: "blocked_by_policy", message: err.message, violations: err.violations });
      }
      // An expired, revoked, or undecryptable token is a reconnect prompt, not
      // a server error. Nothing was touched.
      if (err instanceof ReconnectRequired) {
        return reply.code(409).send({
          error: "reconnect_required",
          message:
            "Your Gmail connection needs to be renewed. Nothing was changed — reconnect and run this again.",
        });
      }
      throw err;
    }

    if (entitlementsFor(ctx.userId).plan === "free") recordFreeBatchUse(ctx.userId);

    const result = db.prepare(`SELECT * FROM batches WHERE id = ?`).get(batch.id) as Record<
      string,
      unknown
    >;
    audit(ctx.userId, "batch.executed", { batchId: batch.id });

    return {
      batchId: batch.id,
      action: result.action,
      messageCount: result.message_count,
      bytesFreed: result.bytes_freed,
      status: result.status,
      undoable: true,
    };
  });

  app.post<{ Params: { id: string } }>("/api/batches/:id/undo", async (req, reply) => {
    const ctx = requireAccount(req, reply);
    if (!ctx) return;
    const result = await undoBatch(ctx.accountId, req.params.id);
    audit(ctx.userId, "batch.undone", { batchId: req.params.id, ...result });
    return result;
  });

  /**
   * Iteration 12 — manual protection overrides.
   *
   * Pinning is permanent and outranks every classifier. Releasing a protection
   * we applied is allowed, but it can never override the replied-to rule —
   * that check lives in the guard layer, not here.
   */
  app.post<{ Body: { senderKey: string; state: "pin" | "release" | "auto" } }>(
    "/api/senders/protection",
    async (req, reply) => {
      const ctx = requireAccount(req, reply);
      if (!ctx) return;

      const { senderKey, state } = req.body ?? {};
      const value = state === "pin" ? 1 : state === "release" ? -1 : 0;
      if (!senderKey || ![1, -1, 0].includes(value)) {
        return reply.code(400).send({ error: "invalid_request" });
      }

      const res = db
        .prepare(`UPDATE senders SET user_protected = ? WHERE account_id = ? AND sender_key = ?`)
        .run(value, ctx.accountId, senderKey);
      if (res.changes === 0) return reply.code(404).send({ error: "sender_not_found" });

      audit(ctx.userId, "sender.protection_changed", { senderKey, state });
      return { senderKey, userProtected: value };
    },
  );

  /** The active safety policy, so the UI can explain limits rather than guess. */
  app.get("/api/safety/limits", async () => ({ limits: LIMITS }));

  app.get("/api/batches", async (req, reply) => {
    const ctx = requireAccount(req, reply);
    if (!ctx) return;
    return {
      batches: db
        .prepare(`SELECT * FROM batches WHERE account_id = ? ORDER BY created_at DESC LIMIT 50`)
        .all(ctx.accountId),
    };
  });

  /** User-visible audit trail. Required for verification; also builds trust. */
  app.get("/api/audit", async (req, reply) => {
    const userId = currentUserId(req.cookies);
    if (!userId) return reply.code(401).send({ error: "not_authenticated" });
    return {
      events: db
        .prepare(`SELECT action, detail, created_at FROM audit_log WHERE user_id = ?
                  ORDER BY created_at DESC LIMIT 200`)
        .all(userId),
    };
  });
}
