import { randomInt } from "node:crypto";
import QRCode from "qrcode";

import { config } from "../config.js";
import { audit, db, now } from "../db.js";
import { newId } from "./crypto.js";
import { FOUNDING_SEATS, foundingSeatsSold } from "./billing.js";
import { setPlan, type Plan } from "./entitlements.js";

/**
 * UPI PAYMENT ORDERS.
 *
 * UPI carries no merchant discount rate in India, so this collects 100% of the
 * price where a card processor takes ~3.5%. The cost is that nothing confirms
 * the payment automatically — which is acceptable here only because the
 * operator must already add every buyer to Google's Test users list by hand.
 *
 * Two rules shape the design:
 *
 *  1. **The payee id is never public.** It is returned only to a signed-in user
 *     who has created an order. A UPI id on a public page gets scraped, gets
 *     used to impersonate you, and tells a passer-by nothing they need.
 *
 *  2. **Every order carries a unique reference**, placed in the UPI transaction
 *     note. That reference is what turns a bank statement into a reconciliation
 *     queue — ten people paying the same amount on the same evening are
 *     otherwise indistinguishable.
 *
 * This does NOT work for international buyers. UPI settles through Indian banks
 * only; a foreign card or bank cannot pay a UPI id at all. International sales
 * need a card processor or they need to not happen.
 */

/**
 * Human-transcribable reference. No vowels (so no accidental words), and no
 * 0/O/1/I/5/S — these get read off a phone screen and typed into a note field,
 * and a misread character costs a manual investigation.
 */
const ALPHABET = "BCDFGHJKMNPQRTVWXYZ2346789";

function makeReference(): string {
  let out = "";
  for (let i = 0; i < 6; i++) out += ALPHABET[randomInt(ALPHABET.length)];
  return `MW-${out.slice(0, 3)}${out.slice(3)}`;
}

export interface UpiOrder {
  reference: string;
  amountInr: number;
  plan: Plan;
  /** Deep link; opens a UPI app directly on a phone. */
  upiUri: string;
  /** PNG data URI. Rendered inline — the CSP allows `img-src 'self' data:`. */
  qrDataUri: string;
  payeeName: string;
  expiresInMinutes: number;
}

export const upiConfigured = (): boolean => Boolean(config.direct.upiId);

/** Orders older than this are stale; the buyer should start a fresh one. */
const ORDER_TTL_MINUTES = 60;

export async function createUpiOrder(
  userId: string,
  email: string,
  plan: Plan,
): Promise<UpiOrder> {
  if (!upiConfigured()) throw new Error("UPI is not configured.");
  if (plan === "founding" && foundingSeatsSold() >= FOUNDING_SEATS) {
    throw new Error("All founding seats are taken.");
  }

  const amountInr = priceInr(plan);

  // Reuse a recent pending order rather than minting a new reference on every
  // page load — otherwise a buyer who reloads ends up with several references
  // and the operator cannot tell which one they actually paid against.
  const existing = db
    .prepare(
      `SELECT reference, amount_inr FROM payment_orders
       WHERE user_id = ? AND plan = ? AND status = 'pending' AND created_at > ?
       ORDER BY created_at DESC LIMIT 1`,
    )
    .get(userId, plan, now() - ORDER_TTL_MINUTES * 60_000) as
    | { reference: string; amount_inr: number }
    | undefined;

  const reference = existing?.reference ?? makeReference();

  if (!existing) {
    db.prepare(
      `INSERT INTO payment_orders (id, reference, user_id, email, plan, amount_inr, created_at)
       VALUES (?,?,?,?,?,?,?)`,
    ).run(newId("ord"), reference, userId, email, plan, amountInr, now());
    audit(userId, "billing.upi_order_created", { reference, plan, amountInr });
  }

  const params = new URLSearchParams({
    pa: config.direct.upiId,
    pn: config.direct.payeeName,
    am: String(amountInr),
    cu: "INR",
    tn: reference, // the note the operator reconciles against
  });
  const upiUri = `upi://pay?${params}`;

  return {
    reference,
    amountInr,
    plan,
    upiUri,
    qrDataUri: await QRCode.toDataURL(upiUri, { margin: 1, width: 320 }),
    payeeName: config.direct.payeeName,
    expiresInMinutes: ORDER_TTL_MINUTES,
  };
}

/** Rupee price per plan. Set via env so pricing can move without a deploy. */
export function priceInr(plan: Plan): number {
  switch (plan) {
    case "founding":
      return Number(process.env.PRICE_INR_FOUNDING ?? "799");
    case "pro":
      return Number(process.env.PRICE_INR_PRO ?? "1499");
    case "starter":
      return Number(process.env.PRICE_INR_STARTER ?? "799");
    default:
      return 0;
  }
}

export interface PendingOrder {
  reference: string;
  email: string;
  plan: string;
  amount_inr: number;
  created_at: number;
  status: string;
}

export function pendingOrders(limit = 100): PendingOrder[] {
  return db
    .prepare(
      `SELECT reference, email, plan, amount_inr, created_at, status
       FROM payment_orders ORDER BY created_at DESC LIMIT ?`,
    )
    .all(limit) as PendingOrder[];
}

/**
 * Confirms an order after the money has been seen in the bank.
 *
 * Grants the plan and records the UTR, both sides audited. This is the point
 * where a human decision becomes paid access, so it is deliberately explicit:
 * there is no "auto-confirm" and no inference from amount alone.
 */
export function confirmOrder(
  adminUserId: string,
  reference: string,
  utr: string,
): { ok: boolean; reason: string } {
  const order = db
    .prepare(`SELECT * FROM payment_orders WHERE reference = ?`)
    .get(reference.trim().toUpperCase()) as
    | { id: string; user_id: string; email: string; plan: Plan; status: string }
    | undefined;

  if (!order) return { ok: false, reason: `No order with reference ${reference}.` };
  if (order.status === "confirmed") {
    return { ok: false, reason: "That order was already confirmed." };
  }

  if (order.plan === "founding") {
    const sold = foundingSeatsSold();
    if (sold >= FOUNDING_SEATS) return { ok: false, reason: "All founding seats are taken." };
    db.prepare(`UPDATE users SET founding_seat = ? WHERE id = ?`).run(sold + 1, order.user_id);
  }

  db.prepare(
    `UPDATE payment_orders SET status = 'confirmed', utr = ?, confirmed_at = ?, confirmed_by = ?
     WHERE id = ?`,
  ).run(utr.slice(0, 100), now(), adminUserId, order.id);

  setPlan(order.user_id, order.plan);
  audit(adminUserId, "billing.upi_confirmed", { reference, utr, email: order.email });
  audit(order.user_id, "billing.purchased", { plan: order.plan, method: "upi", reference });

  return { ok: true, reason: `Confirmed ${reference} — ${order.email} is now ${order.plan}.` };
}
