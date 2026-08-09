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
  directPayInfo,
  grantManual,
  isAdmin,
  type PriceId,
} from "../lib/billing.js";
import type { Plan } from "../lib/entitlements.js";
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
    if (price !== "founding" && price !== "starter" && price !== "pro") {
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
   * Direct payment details — UPI or bank transfer, which carry no processor
   * fee. Public, because the whole point is that a buyer can see it before
   * signing in.
   *
   * The INR figure is a display convenience, not an exchange rate: keep
   * DIRECT_PAY_INR in step with the dollar price, or charge in INR outright.
   */
  app.get("/api/billing/direct", async () => {
    const inr = Number(process.env.DIRECT_PAY_INR ?? "4200");
    return { ...directPayInfo(inr), amountInr: inr };
  });

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
      return { ok: true, waiting };
    },
  );

  /**
   * The founder's queue: who is waiting, so seats can be added to the Google
   * Test users list by hand. Gated to users who already hold a paid plan —
   * in practice, the operator.
   */
  app.get("/api/access-request/list", async (req, reply) => {
    const userId = currentUserId(req.cookies);
    if (!userId) return reply.code(401).send({ error: "not_authenticated" });
    const me = db.prepare(`SELECT plan FROM users WHERE id = ?`).get(userId) as
      | { plan: string }
      | undefined;
    if (!me || me.plan === "free") return reply.code(403).send({ error: "forbidden" });

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
}
