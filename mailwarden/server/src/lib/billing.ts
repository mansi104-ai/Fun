import Stripe from "stripe";

import { config } from "../config.js";
import { audit, db, now } from "../db.js";
import { newId } from "./crypto.js";
import { setPlan, type Plan } from "./entitlements.js";

/**
 * BILLING.
 *
 * Two shapes of purchase, deliberately different:
 *
 *   Founding 100   $49 one-time, lifetime Pro. Capped at 100 seats because
 *                  Google's Testing mode caps the app at 100 users — the
 *                  scarcity is real, not manufactured, which is the rare case
 *                  where you can say "only 100 exist" without embarrassment.
 *   Starter / Pro  recurring annual subscriptions, for after verification.
 *
 * The founding tier exists to fund CASA Tier 2 ($540–$1,800) from customers
 * rather than out of pocket. That takes 11–37 sales, not 100.
 *
 * Nothing here trusts the client. A plan changes only when Stripe tells us it
 * changed, over a signature-verified webhook.
 */

export const FOUNDING_SEATS = 100;

export type PriceId = "founding" | "starter" | "pro";

export interface PriceInfo {
  id: PriceId;
  label: string;
  blurb: string;
  /** Minor units, for display only — Stripe is the source of truth on charge. */
  amount: number;
  currency: string;
  mode: "payment" | "subscription";
  plan: Plan;
  configured: boolean;
}

function stripePriceFor(id: PriceId): string {
  switch (id) {
    case "founding":
      return config.stripe.priceFounding;
    case "starter":
      return config.stripe.priceStarter;
    case "pro":
      return config.stripe.pricePro;
  }
}

export function billingEnabled(): boolean {
  return Boolean(config.stripe.secretKey);
}

/** Seats already sold. Counted, never cached — the cap is a public promise. */
export function foundingSeatsSold(): number {
  return (
    db.prepare(`SELECT COUNT(*) c FROM users WHERE plan = 'founding'`).get() as { c: number }
  ).c;
}

export function priceCatalogue(): PriceInfo[] {
  return [
    {
      id: "founding",
      label: "Founding 100",
      blurb: "Everything in Pro, forever. One payment. Only 100 exist.",
      amount: 4900,
      currency: "usd",
      mode: "payment",
      plan: "founding",
      configured: Boolean(config.stripe.priceFounding),
    },
    {
      id: "starter",
      label: "Starter",
      blurb: "Unlimited cleanups and higher-accuracy sorting.",
      amount: 1900,
      currency: "usd",
      mode: "subscription",
      plan: "starter",
      configured: Boolean(config.stripe.priceStarter),
    },
    {
      id: "pro",
      label: "Pro",
      blurb: "Scheduled re-scans, unsubscribe verification, up to 5 accounts.",
      amount: 3900,
      currency: "usd",
      mode: "subscription",
      plan: "pro",
      configured: Boolean(config.stripe.pricePro),
    },
  ];
}

let client: Stripe | null = null;
function stripe(): Stripe {
  if (!client) {
    if (!config.stripe.secretKey) throw new Error("Stripe is not configured.");
    client = new Stripe(config.stripe.secretKey);
  }
  return client;
}

export class SoldOutError extends Error {}
export class NotConfiguredError extends Error {}

/**
 * Creates a Checkout Session.
 *
 * We never handle a card number — Stripe Checkout is a hosted page, which keeps
 * this out of PCI scope entirely. The user id travels in `client_reference_id`
 * so the webhook can attribute the payment without trusting anything the
 * browser sends back.
 */
export async function createCheckout(
  userId: string,
  email: string,
  price: PriceId,
): Promise<string> {
  const priceId = stripePriceFor(price);
  if (!billingEnabled() || !priceId) {
    throw new NotConfiguredError(
      `Billing is not configured yet (missing ${price} price id).`,
    );
  }
  if (price === "founding" && foundingSeatsSold() >= FOUNDING_SEATS) {
    throw new SoldOutError("All 100 founding seats are gone.");
  }

  const info = priceCatalogue().find((p) => p.id === price)!;

  const session = await stripe().checkout.sessions.create({
    mode: info.mode,
    line_items: [{ price: priceId, quantity: 1 }],
    client_reference_id: userId,
    customer_email: email,
    success_url: `${config.appUrl}/app?purchase=success`,
    cancel_url: `${config.appUrl}/pricing.html?cancelled=1`,
    // Lets the webhook resolve the plan without a second lookup, and keeps the
    // mapping in one place rather than duplicated across price ids.
    metadata: { userId, price, plan: info.plan },
    allow_promotion_codes: true,
  });

  if (!session.url) throw new Error("Stripe returned a session without a URL.");
  audit(userId, "billing.checkout_started", { price, sessionId: session.id });
  return session.url;
}

/** Verifies the signature and returns the event. Throws if it is not genuine. */
export function verifyWebhook(rawBody: string, signature: string): Stripe.Event {
  if (!config.stripe.webhookSecret) {
    throw new NotConfiguredError("STRIPE_WEBHOOK_SECRET is not set.");
  }
  return stripe().webhooks.constructEvent(rawBody, signature, config.stripe.webhookSecret);
}

/**
 * Applies an event exactly once.
 *
 * Stripe does not guarantee exactly-once delivery and retries on any non-2xx,
 * so a duplicate is normal traffic, not an attack. Recording the event id first
 * means a replay cannot grant a second founding seat.
 */
export function handleEvent(event: Stripe.Event): { applied: boolean; reason: string } {
  const seen = db.prepare(`SELECT 1 AS ok FROM stripe_events WHERE id = ?`).get(event.id);
  if (seen) return { applied: false, reason: "duplicate" };

  db.prepare(`INSERT INTO stripe_events (id, type, created_at) VALUES (?, ?, ?)`).run(
    event.id,
    event.type,
    now(),
  );

  switch (event.type) {
    case "checkout.session.completed": {
      const s = event.data.object as Stripe.Checkout.Session;
      // `paid` is the only status that means money moved. Async payment methods
      // complete later via checkout.session.async_payment_succeeded.
      if (s.payment_status !== "paid") return { applied: false, reason: "not paid yet" };
      return grant(s);
    }

    case "checkout.session.async_payment_succeeded":
      return grant(event.data.object as Stripe.Checkout.Session);

    case "customer.subscription.deleted": {
      const sub = event.data.object as Stripe.Subscription;
      const user = userForSubscription(sub.id);
      if (!user) return { applied: false, reason: "unknown subscription" };
      // A founding seat is a one-time purchase and is never revoked by a
      // subscription ending — it has no subscription in the first place.
      if (user.plan === "founding") return { applied: false, reason: "founding seat, not revoked" };
      setPlan(user.id, "free");
      audit(user.id, "billing.subscription_ended", { subscription: sub.id });
      return { applied: true, reason: "downgraded to free" };
    }

    case "customer.subscription.updated": {
      const sub = event.data.object as Stripe.Subscription;
      const user = userForSubscription(sub.id);
      if (!user) return { applied: false, reason: "unknown subscription" };
      const active = sub.status === "active" || sub.status === "trialing";
      if (!active && user.plan !== "founding") {
        setPlan(user.id, "free");
        audit(user.id, "billing.subscription_inactive", { subscription: sub.id, status: sub.status });
        return { applied: true, reason: `status ${sub.status} -> free` };
      }
      return { applied: false, reason: `status ${sub.status}, no change` };
    }

    default:
      return { applied: false, reason: `ignored ${event.type}` };
  }
}

function userForSubscription(subscriptionId: string): { id: string; plan: Plan } | undefined {
  return db
    .prepare(`SELECT id, plan FROM users WHERE stripe_subscription = ?`)
    .get(subscriptionId) as { id: string; plan: Plan } | undefined;
}

function grant(s: Stripe.Checkout.Session): { applied: boolean; reason: string } {
  const userId = s.client_reference_id ?? s.metadata?.userId;
  if (!userId) return { applied: false, reason: "no user reference on session" };

  const user = db.prepare(`SELECT id, plan FROM users WHERE id = ?`).get(userId) as
    | { id: string; plan: Plan }
    | undefined;
  if (!user) return { applied: false, reason: "unknown user" };

  const plan = (s.metadata?.plan ?? "pro") as Plan;

  if (plan === "founding") {
    // Re-check the cap at grant time, not just at checkout: two people can be
    // on the payment page simultaneously when one seat remains.
    const sold = foundingSeatsSold();
    if (user.plan !== "founding" && sold >= FOUNDING_SEATS) {
      // Honour the payment with Pro rather than taking money for nothing. The
      // difference is refundable by hand; silently dropping it is not.
      setPlan(user.id, "pro");
      audit(user.id, "billing.founding_oversold", { sold, session: s.id });
      return { applied: true, reason: "seats gone — granted pro, refund the difference" };
    }
    db.prepare(`UPDATE users SET founding_seat = ? WHERE id = ?`).run(sold + 1, user.id);
  }

  if (typeof s.subscription === "string") {
    db.prepare(`UPDATE users SET stripe_subscription = ? WHERE id = ?`).run(s.subscription, user.id);
  }
  if (typeof s.customer === "string") {
    db.prepare(`UPDATE users SET stripe_customer = ? WHERE id = ?`).run(s.customer, user.id);
  }

  setPlan(user.id, plan);
  audit(user.id, "billing.purchased", {
    plan, session: s.id, amount: s.amount_total, currency: s.currency,
  });
  return { applied: true, reason: `granted ${plan}` };
}

// ── Access requests ──────────────────────────────────────────────────────

/**
 * Captures demand while the Google 100-user cap binds.
 *
 * Every seat has to be added to the OAuth Test users list by hand, so this is
 * the queue you work through — and the evidence that demand exists before you
 * spend anything on compliance.
 */
export function requestAccess(email: string, note: string | null, source: string): boolean {
  const clean = email.trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(clean)) return false;
  db.prepare(
    `INSERT INTO access_requests (id, email, note, source, created_at) VALUES (?,?,?,?,?)
     ON CONFLICT(email) DO UPDATE SET note = COALESCE(excluded.note, note)`,
  ).run(newId("req"), clean, note?.slice(0, 500) ?? null, source, now());
  return true;
}
