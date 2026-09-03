import type { FastifyInstance } from "fastify";

import { audit, db } from "../db.js";
import {
  billingEnabled,
  createCheckout,
  foundingSeatsSold,
  FOUNDING_SEATS,
  handleEvent,
  NotConfiguredError,
  priceCatalogue,
  requestAccess,
  SoldOutError,
  verifyWebhook,
  grantManual,
  isAdmin,
  type PriceId,
} from "../lib/billing.js";
import { currentPeriod, planDetails, type Plan } from "../lib/entitlements.js";
import { confirmOrder, createUpiOrder, pendingOrders, priceInr, upiConfigured } from "../lib/upi.js";
import { notifyOperator } from "../lib/notify.js";
import { currentUserId } from "./auth.js";

export async function billingRoutes(app: FastifyInstance): Promise<void> {
  /** Public: what is on sale, and how many founding seats are left. */
  app.get("/api/billing/prices", async () => ({
    enabled: billingEnabled(),
    prices: priceCatalogue(),
    founding: {
      total: FOUNDING_SEATS,
      sold: foundingSeatsSold(),
      remaining: Math.max(0, FOUNDING_SEATS - foundingSeatsSold()),
    },
  }));

  /**
   * Starts a purchase. Returns a Stripe-hosted URL — we never see a card
   * number, which keeps this entirely out of PCI scope.
   */
  app.post<{ Body: { price?: PriceId } }>("/api/billing/checkout", async (req, reply) => {
    const userId = currentUserId(req.cookies);
    if (!userId) return reply.code(401).send({ error: "not_authenticated" });

    const price = req.body?.price;
    if (price !== "backlog" && price !== "pro") {
      return reply.code(400).send({ error: "invalid_price" });
    }

    const user = db.prepare(`SELECT email FROM users WHERE id = ?`).get(userId) as
      | { email: string }
      | undefined;
    if (!user) return reply.code(404).send({ error: "no_user" });

    try {
      return { url: await createCheckout(userId, user.email, price) };
    } catch (err) {
      if (err instanceof SoldOutError) {
        return reply.code(409).send({ error: "sold_out", message: err.message });
      }
      if (err instanceof NotConfiguredError) {
        return reply.code(503).send({ error: "billing_unavailable", message: err.message });
      }
      throw err;
    }
  });

  /**
   * Stripe webhook. THE only path that changes a plan.
   *
   * Unauthenticated by necessity — Stripe calls it, not a browser — so the
   * signature check is the entire security boundary. It runs against the RAW
   * body: any re-serialisation changes the bytes and invalidates the signature,
   * which is why index.ts keeps this route's body as a string.
   *
   * Always answers 2xx once the signature is valid, even when the event is
   * ignored. A non-2xx makes Stripe retry, and retrying an event we understood
   * and chose not to act on achieves nothing but noise.
   */
  app.post("/api/billing/webhook", async (req, reply) => {
    const signature = req.headers["stripe-signature"];
    if (typeof signature !== "string") {
      return reply.code(400).send({ error: "missing_signature" });
    }

    let event;
    try {
      event = verifyWebhook(req.body as string, signature);
    } catch (err) {
      // Either a forgery or a misconfigured secret. Both are 400, and both are
      // worth logging loudly — a silently rejected webhook looks exactly like
      // a customer who paid and never got their plan.
      console.error("[billing] webhook signature rejected:", err);
      return reply.code(400).send({ error: "invalid_signature" });
    }

    try {
      const result = handleEvent(event);
      console.log(`[billing] ${event.type} (${event.id}): ${result.reason}`);
      return { received: true, ...result };
    } catch (err) {
      // A genuine failure to apply a paid event. 500 so Stripe retries — this
      // is the one case where a retry is exactly what we want.
      console.error(`[billing] failed to apply ${event.type} (${event.id}):`, err);
      return reply.code(500).send({ error: "apply_failed" });
    }
  });

  /**
   * Public: only whether UPI is available and what it costs. Deliberately NOT
   * the payee id — that is returned solely to a signed-in buyer with an order.
   * A UPI id on a public page gets scraped and gets used to impersonate you,
   * and it tells a passer-by nothing they need in order to decide.
   */
  app.get("/api/billing/upi", async () => ({
    available: upiConfigured(),
    // Both purchasable plans, priced server-side. The page never hard-codes an
    // amount: a figure printed in HTML that disagrees with what the QR asks
    // for is the one discrepancy a buyer is guaranteed to notice.
    plans: {
      backlog: priceInr("backlog"),
      pro: priceInr("pro"),
    },
  }));

  /**
   * Creates (or reuses) a UPI order and returns the QR and deep link.
   *
   * Requires sign-in for two reasons: the payee id must not be public, and the
   * order has to be attached to an account so confirming it grants the right
   * person.
   */
  app.post<{ Body: { plan?: string } }>("/api/billing/upi/order", async (req, reply) => {
    const userId = currentUserId(req.cookies);
    if (!userId) return reply.code(401).send({ error: "not_authenticated" });
    if (!upiConfigured()) return reply.code(503).send({ error: "upi_unavailable" });

    const plan = (req.body?.plan ?? "backlog") as Plan;
    // Retired tiers are not orderable. An old order already in the queue still
    // prices and still confirms — this only stops a NEW one being created.
    if (!["backlog", "pro"].includes(plan)) {
      return reply.code(400).send({ error: "invalid_plan" });
    }

    const user = db.prepare(`SELECT email FROM users WHERE id = ?`).get(userId) as
      | { email: string }
      | undefined;
    if (!user) return reply.code(404).send({ error: "no_user" });

    try {
      const order = await createUpiOrder(userId, user.email, plan);
      notifyOperator(
        "upi_order",
        "UPI payment started",
        `${user.email} — ${order.reference} for Rs ${order.amountInr}. Watch for it, then confirm.`,
      );
      return order;
    } catch (err) {
      return reply
        .code(409)
        .send({ error: "order_failed", message: err instanceof Error ? err.message : "Failed." });
    }
  });

  /** The operator's reconciliation queue: who has paid what, and against which reference. */
  app.get("/api/billing/upi/orders", async (req, reply) => {
    const userId = currentUserId(req.cookies);
    if (!userId) return reply.code(401).send({ error: "not_authenticated" });
    const me = db.prepare(`SELECT email FROM users WHERE id = ?`).get(userId) as
      | { email: string }
      | undefined;
    if (!isAdmin(me?.email)) return reply.code(403).send({ error: "forbidden" });
    return { orders: pendingOrders() };
  });

  /** Confirms one order after the money has been seen in the bank. */
  app.post<{ Body: { reference?: string; utr?: string } }>(
    "/api/billing/upi/confirm",
    async (req, reply) => {
      const userId = currentUserId(req.cookies);
      if (!userId) return reply.code(401).send({ error: "not_authenticated" });
      const me = db.prepare(`SELECT email FROM users WHERE id = ?`).get(userId) as
        | { email: string }
        | undefined;
      if (!isAdmin(me?.email)) return reply.code(403).send({ error: "forbidden" });

      const { reference, utr = "" } = req.body ?? {};
      if (typeof reference !== "string" || !reference.trim()) {
        return reply.code(400).send({ error: "missing_reference" });
      }

      const result = confirmOrder(userId, reference, String(utr));
      if (!result.ok) {
        return reply.code(409).send({ error: "confirm_failed", message: result.reason });
      }
      return result;
    },
  );

  /**
   * Grant a plan by hand, after confirming payment arrived.
   *
   * Restricted to ADMIN_EMAIL. This is the only path where access is granted by
   * a human decision rather than a processor's webhook, so it is audited on
   * both sides — who granted it, and what the payment reference was.
   */
  app.post<{ Body: { email?: string; plan?: string; reference?: string } }>(
    "/api/billing/grant",
    async (req, reply) => {
      const userId = currentUserId(req.cookies);
      if (!userId) return reply.code(401).send({ error: "not_authenticated" });

      const me = db.prepare(`SELECT email FROM users WHERE id = ?`).get(userId) as
        | { email: string }
        | undefined;
      if (!isAdmin(me?.email)) return reply.code(403).send({ error: "forbidden" });

      const { email, plan = "founding", reference = "" } = req.body ?? {};
      if (typeof email !== "string" || !email.includes("@")) {
        return reply.code(400).send({ error: "invalid_email" });
      }
      if (!["founding", "starter", "pro", "free"].includes(plan)) {
        return reply.code(400).send({ error: "invalid_plan" });
      }

      const result = grantManual(userId, email, plan as Plan, String(reference).slice(0, 200));
      if (!result.ok) return reply.code(409).send({ error: "grant_failed", message: result.reason });
      return result;
    },
  );

  /**
   * Access requests, captured while Google's 100-user Testing cap binds.
   *
   * Public and unauthenticated on purpose: the entire point is to hear from
   * people who cannot sign in yet.
   */
  app.post<{ Body: { email?: string; note?: string } }>(
    "/api/access-request",
    async (req, reply) => {
      const { email, note } = req.body ?? {};
      if (typeof email !== "string" || !requestAccess(email, note ?? null, "landing")) {
        return reply.code(400).send({ error: "invalid_email" });
      }
      const waiting = (
        db.prepare(`SELECT COUNT(*) c FROM access_requests WHERE invited_at IS NULL`).get() as {
          c: number;
        }
      ).c;
      // The address goes in the title, not just the detail: the title becomes
      // the email subject, and the subject is often all that gets read.
      notifyOperator(
        "access_request",
        `${email} wants access`,
        `${waiting} waiting. Add them at console.cloud.google.com -> OAuth consent screen -> Test users.`,
      );
      return { ok: true, waiting };
    },
  );

  /**
   * The operator queue: who is waiting, so seats can be added to the Google
   * Test users list by hand.
   *
   * Gated on ADMIN_EMAIL, not on holding a paid plan. The operator is normally
   * on the free plan themselves, so a plan-based gate locks them out of their
   * own queue — and would hand it to every paying customer instead.
   */
  app.get("/api/access-request/list", async (req, reply) => {
    const userId = currentUserId(req.cookies);
    if (!userId) return reply.code(401).send({ error: "not_authenticated" });
    const me = db.prepare(`SELECT email FROM users WHERE id = ?`).get(userId) as
      | { email: string }
      | undefined;
    if (!isAdmin(me?.email)) return reply.code(403).send({ error: "forbidden" });

    audit(userId, "access_request.listed");
    return {
      requests: db
        .prepare(
          `SELECT email, note, source, invited_at, created_at FROM access_requests
           ORDER BY created_at ASC LIMIT 500`,
        )
        .all(),
    };
  });

  /**
   * Who is actually using this.
   *
   * Reads the quota columns directly rather than calling quotaFor() per row:
   * quotaFor performs the lazy monthly refill, and refilling five hundred
   * users as a side effect of the operator opening a page would be a write
   * storm triggered by a read. The stored period is returned alongside the
   * count so a stale row is visible as stale rather than silently shown as
   * spent.
   */
  app.get("/api/admin/users", async (req, reply) => {
    const userId = currentUserId(req.cookies);
    if (!userId) return reply.code(401).send({ error: "not_authenticated" });
    const me = db.prepare(`SELECT email FROM users WHERE id = ?`).get(userId) as
      | { email: string }
      | undefined;
    if (!isAdmin(me?.email)) return reply.code(403).send({ error: "forbidden" });

    const rows = db
      .prepare(
        `SELECT u.id, u.email, u.plan, u.created_at, u.plan_expires_at,
                u.messages_used, u.unsubs_used, u.quota_period,
                a.last_sync_at, a.sync_state,
                (SELECT COUNT(*) FROM batches b
                   JOIN accounts a2 ON a2.id = b.account_id
                  WHERE a2.user_id = u.id AND b.status = 'done') AS cleanups
           FROM users u
           LEFT JOIN accounts a ON a.user_id = u.id
          ORDER BY u.created_at DESC
          LIMIT 500`,
      )
      .all() as Record<string, unknown>[];

    audit(userId, "admin.users_listed", { count: rows.length });

    return {
      period: currentPeriod(),
      users: rows.map((r) => {
        const ent = planDetails(String(r.plan) as Plan);
        return {
          email: r.email,
          plan: r.plan,
          createdAt: r.created_at,
          expiresAt: r.plan_expires_at,
          lastSyncAt: r.last_sync_at,
          syncState: r.sync_state,
          cleanups: r.cleanups,
          quotaPeriod: r.quota_period,
          messagesUsed: r.messages_used ?? 0,
          messagesLimit: ent.monthlyMessages,
          unsubsUsed: r.unsubs_used ?? 0,
          unsubsLimit: ent.monthlyUnsubs,
        };
      }),
    };
  });
}
