import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

import { db, now } from "../db.js";
import { gmailFor } from "./client.js";

/**
 * UNSUBSCRIBE ENGINE (roadmap 44).
 *
 * Three mechanisms, tried in descending order of reliability:
 *
 *   1. RFC 8058 one-click — the sender advertises `List-Unsubscribe-Post:
 *      List-Unsubscribe=One-Click` and an HTTPS endpoint. We POST to it and the
 *      job is done, with no user interaction and no page to navigate.
 *   2. HTTPS link — an unsubscribe URL with no one-click declaration. We do NOT
 *      auto-POST these: without the RFC 8058 opt-in a bare GET/POST may be a
 *      confirmation page, a preference centre, or a tracking link that proves
 *      the address is live. We hand the URL to the user instead.
 *   3. mailto — requires sending an email, which needs the gmail.send scope.
 *      We deliberately do not request that scope, so this is surfaced for the
 *      user to action. Requesting send access to cancel newsletters would be a
 *      poor trade against the CASA argument in docs/03.
 *
 * The honest framing throughout: we do what can be done safely and tell the
 * user plainly about the rest, rather than claiming a success we did not have.
 */

export type UnsubMethod = "one-click" | "link" | "mailto";
export type UnsubStatus = "sent" | "needs_user" | "failed";

export interface UnsubResult {
  senderKey: string;
  method: UnsubMethod | null;
  status: UnsubStatus;
  /** Shown verbatim to the user. */
  message: string;
  /** Present when the user has to finish the job themselves. */
  url?: string;
}

/** Parses the angle-bracket list form: `<https://…>, <mailto:…>`. */
export function parseTargets(header: string): { https: string[]; mailto: string[] } {
  const https: string[] = [];
  const mailto: string[] = [];
  for (const m of header.matchAll(/<([^>]+)>/g)) {
    const v = m[1]!.trim();
    if (/^https:\/\//i.test(v)) https.push(v);
    else if (/^mailto:/i.test(v)) mailto.push(v);
  }
  return { https, mailto };
}

const PRIVATE_V4 =
  /^(0\.|10\.|127\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/;

/**
 * Blocks server-side requests to internal addresses.
 *
 * This endpoint takes a URL from an email header — attacker-controlled input —
 * and asks our server to POST to it. Without this check that is a textbook SSRF
 * into the Fly private network, including the metadata endpoints. HTTPS-only,
 * public addresses only, and the DNS result is checked rather than the
 * hostname, so `evil.com → 127.0.0.1` does not slip through.
 */
export async function isPubliclyRoutable(rawUrl: string): Promise<boolean> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return false;
  }
  if (url.protocol !== "https:") return false;

  const host = url.hostname.replace(/^\[|\]$/g, "");
  const addresses = isIP(host)
    ? [{ address: host, family: isIP(host) }]
    : await lookup(host, { all: true }).catch(() => []);

  if (addresses.length === 0) return false;

  return addresses.every(({ address, family }) => {
    if (family === 6) {
      const a = address.toLowerCase();
      // loopback, link-local, unique-local, and v4-mapped
      if (a === "::1" || a.startsWith("fe80:") || a.startsWith("fc") || a.startsWith("fd")) return false;
      if (a.startsWith("::ffff:")) return !PRIVATE_V4.test(a.slice(7));
      return true;
    }
    return !PRIVATE_V4.test(address);
  });
}

/** Most recent message from this sender — the freshest unsubscribe target. */
function latestMessageId(accountId: string, senderKey: string): string | null {
  const row = db
    .prepare(
      `SELECT message_id FROM messages_meta
       WHERE account_id = ? AND sender_key = ?
       ORDER BY internal_date DESC LIMIT 1`,
    )
    .get(accountId, senderKey) as { message_id: string } | undefined;
  return row?.message_id ?? null;
}

function record(
  accountId: string,
  senderKey: string,
  method: UnsubMethod | null,
  status: UnsubStatus,
  detail: string,
): void {
  db.prepare(
    `UPDATE senders
     SET unsubscribed_at = ?, unsubscribe_method = ?, unsubscribe_status = ?, unsubscribe_detail = ?
     WHERE account_id = ? AND sender_key = ?`,
  ).run(now(), method, status, detail.slice(0, 500), accountId, senderKey);
}

export async function unsubscribeFromSender(
  accountId: string,
  senderKey: string,
): Promise<UnsubResult> {
  const messageId = latestMessageId(accountId, senderKey);
  if (!messageId) {
    return { senderKey, method: null, status: "failed", message: "No messages from this sender to read an unsubscribe link from." };
  }

  const gmail = await gmailFor(accountId);
  const res = await gmail.users.messages.get({
    userId: "me",
    id: messageId,
    format: "metadata",
    metadataHeaders: ["List-Unsubscribe", "List-Unsubscribe-Post"],
  });

  const headers = res.data.payload?.headers ?? [];
  const get = (n: string): string =>
    headers.find((h) => h.name?.toLowerCase() === n.toLowerCase())?.value ?? "";

  const listUnsub = get("List-Unsubscribe");
  if (!listUnsub) {
    const detail = "This sender does not advertise an unsubscribe method.";
    record(accountId, senderKey, null, "failed", detail);
    return {
      senderKey, method: null, status: "failed",
      message: `${detail} Archiving or trashing them is the remaining option.`,
    };
  }

  const { https, mailto } = parseTargets(listUnsub);
  const oneClick = /one-?click/i.test(get("List-Unsubscribe-Post"));

  // ── 1. RFC 8058 one-click ────────────────────────────────────────────
  if (oneClick && https.length > 0) {
    const target = https[0]!;
    if (!(await isPubliclyRoutable(target))) {
      const detail = "The unsubscribe URL did not resolve to a public address; refused.";
      record(accountId, senderKey, "one-click", "failed", detail);
      return { senderKey, method: "one-click", status: "failed", message: detail };
    }
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 10_000);
      const r = await fetch(target, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "List-Unsubscribe=One-Click",
        redirect: "manual", // a redirect could land somewhere unvetted
        signal: controller.signal,
      }).finally(() => clearTimeout(timer));

      // 2xx and 3xx both indicate the request was accepted; many senders
      // answer a one-click POST with a redirect to a confirmation page.
      if (r.status >= 200 && r.status < 400) {
        record(accountId, senderKey, "one-click", "sent", `HTTP ${r.status}`);
        return {
          senderKey, method: "one-click", status: "sent",
          message: "Unsubscribe request sent. We will check in 14 days whether they honoured it.",
        };
      }
      record(accountId, senderKey, "one-click", "failed", `HTTP ${r.status}`);
      return {
        senderKey, method: "link", status: "needs_user", url: target,
        message: `Their one-click endpoint returned HTTP ${r.status}. Open the link to finish it manually.`,
      };
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      record(accountId, senderKey, "one-click", "failed", detail);
      return {
        senderKey, method: "link", status: "needs_user", url: target,
        message: "Their unsubscribe endpoint did not respond. Open the link to finish it manually.",
      };
    }
  }

  // ── 2. Plain HTTPS link ──────────────────────────────────────────────
  if (https.length > 0) {
    const target = https[0]!;
    record(accountId, senderKey, "link", "needs_user", target);
    return {
      senderKey, method: "link", status: "needs_user", url: target,
      message:
        "This sender offers an unsubscribe page rather than one-click. " +
        "Opening it is one step you have to take — we do not click it for you, " +
        "because an unconfirmed click can simply confirm your address is live.",
    };
  }

  // ── 3. mailto ────────────────────────────────────────────────────────
  if (mailto.length > 0) {
    const target = mailto[0]!;
    record(accountId, senderKey, "mailto", "needs_user", target);
    return {
      senderKey, method: "mailto", status: "needs_user", url: target,
      message:
        "This sender only accepts unsubscribes by email. Mailwarden cannot send mail " +
        "on your behalf — it deliberately does not ask for permission to send — so " +
        "this one opens in your mail client.",
    };
  }

  const detail = "Unsubscribe header present but unusable.";
  record(accountId, senderKey, null, "failed", detail);
  return { senderKey, method: null, status: "failed", message: detail };
}
