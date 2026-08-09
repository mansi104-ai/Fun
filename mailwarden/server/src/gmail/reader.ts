import type { gmail_v1 } from "googleapis";
import { db } from "../db.js";
import { gmailFor } from "./client.js";

/**
 * ON-DEMAND MESSAGE READING.
 *
 * Everything else in this app is built on the promise that we do not handle
 * message content: sync requests `format: "metadata"` with a header allowlist,
 * and the database stores a salted subject hash rather than a subject.
 *
 * Reading a message necessarily relaxes that. The rule that keeps the promise
 * meaningful is narrow and absolute:
 *
 *   Content is fetched only for a message the user explicitly opened, it is
 *   returned straight to that user, and it is NEVER written to the database,
 *   never logged, and never sent to a model.
 *
 * So the claim changes from "we never read your mail" to "we never store your
 * mail, and we only read the one you asked to see". That is still a real and
 * unusual guarantee, and it is one the code enforces rather than merely states:
 * there is no INSERT anywhere in this file.
 *
 * Classification never calls in here. It runs on aggregate sender statistics,
 * exactly as before — see classify/llm.ts, which transmits no content at all.
 */

export interface MessageSummary {
  messageId: string;
  subject: string;
  from: string;
  date: number;
  sizeBytes: number;
  unread: boolean;
  snippet: string;
}

export interface MessageBody extends MessageSummary {
  /**
   * Plain text. HTML-only mail is converted server-side rather than rendered.
   *
   * Rendering third-party HTML is the single largest attack surface a mail
   * client has — scripts, tracking pixels, CSS exfiltration. Converting to text
   * removes that surface entirely instead of trying to filter it. The page CSP
   * (`default-src 'self'`) would already block remote loads, but defence that
   * relies on one header is not defence.
   */
  text: string;
  /** True when we down-converted from HTML, so the UI can say so. */
  convertedFromHtml: boolean;
}

/**
 * Ownership check. A message id is guessable, so every read is scoped to a
 * message we already synced for THIS account. Without it, any signed-in user
 * could read any message id they cared to try.
 */
function ownsMessage(accountId: string, messageId: string): boolean {
  const row = db
    .prepare(`SELECT 1 AS ok FROM messages_meta WHERE account_id = ? AND message_id = ?`)
    .get(accountId, messageId) as { ok: number } | undefined;
  return row !== undefined;
}

const decode = (data: string): string =>
  Buffer.from(data.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");

/** Depth-first search for the first part matching a mime type. */
function findPart(
  part: gmail_v1.Schema$MessagePart | undefined,
  mime: string,
): gmail_v1.Schema$MessagePart | null {
  if (!part) return null;
  if (part.mimeType === mime && part.body?.data) return part;
  for (const child of part.parts ?? []) {
    const hit = findPart(child, mime);
    if (hit) return hit;
  }
  return null;
}

const ENTITIES: Record<string, string> = {
  "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'",
  "&apos;": "'", "&nbsp;": " ", "&mdash;": "—", "&ndash;": "–", "&hellip;": "…",
};

/**
 * HTML to readable text.
 *
 * Deliberately not a sanitiser — it does not try to decide which tags are safe,
 * it removes all of them. Script and style contents are dropped wholesale
 * first, because stripping their tags alone would leave the code as visible
 * text.
 */
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|h[1-6]|li)>/gi, "\n")
    .replace(/<li[^>]*>/gi, "  • ")
    // Keep the destination of a link; an unlabelled "click here" is useless
    // when you are deciding whether a sender is worth keeping.
    .replace(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_m, href, label) => {
      const text = String(label).replace(/<[^>]+>/g, "").trim();
      return text && !/^https?:/i.test(text) ? `${text} <${href}>` : String(href);
    })
    .replace(/<[^>]+>/g, "")
    .replace(/&#(\d+);/g, (_m, n) => String.fromCharCode(Number(n)))
    .replace(/&[a-z]+;/gi, (m) => ENTITIES[m.toLowerCase()] ?? m)
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

const header = (msg: gmail_v1.Schema$Message, name: string): string =>
  msg.payload?.headers?.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value ?? "";

/**
 * Lists a sender's messages with real subjects.
 *
 * Subjects are fetched from Gmail rather than read from the database, because
 * the database holds only a salted hash of each one. That is the data
 * minimisation working as designed: the cost is a request per message here,
 * and the benefit is that a database dump reveals no subject lines.
 */
export async function listSenderMessages(
  accountId: string,
  senderKey: string,
  limit = 20,
): Promise<MessageSummary[]> {
  const rows = db
    .prepare(
      `SELECT message_id, internal_date, size_bytes, is_unread
       FROM messages_meta
       WHERE account_id = ? AND sender_key = ?
       ORDER BY internal_date DESC
       LIMIT ?`,
    )
    .all(accountId, senderKey, Math.min(limit, 50)) as {
    message_id: string;
    internal_date: number;
    size_bytes: number;
    is_unread: number;
  }[];

  if (rows.length === 0) return [];

  const gmail = await gmailFor(accountId);
  const out = await Promise.all(
    rows.map(async (r) => {
      try {
        const res = await gmail.users.messages.get({
          userId: "me",
          id: r.message_id,
          format: "metadata",
          metadataHeaders: ["Subject", "From", "Date"],
        });
        return {
          messageId: r.message_id,
          subject: header(res.data, "Subject") || "(no subject)",
          from: header(res.data, "From") || senderKey,
          date: r.internal_date,
          sizeBytes: r.size_bytes,
          unread: r.is_unread === 1,
          snippet: res.data.snippet ?? "",
        };
      } catch {
        // A message deleted in Gmail since the last sync is not an error worth
        // failing the whole list over.
        return null;
      }
    }),
  );
  return out.filter((m): m is MessageSummary => m !== null);
}

/** Fetches one message's content. Returns null if it is not this account's. */
export async function readMessage(
  accountId: string,
  messageId: string,
): Promise<MessageBody | null> {
  if (!ownsMessage(accountId, messageId)) return null;

  const gmail = await gmailFor(accountId);
  const res = await gmail.users.messages.get({
    userId: "me",
    id: messageId,
    format: "full",
  });
  const msg = res.data;

  const plain = findPart(msg.payload, "text/plain");
  const html = plain ? null : findPart(msg.payload, "text/html");
  const raw = msg.payload?.body?.data;

  let text = "";
  let convertedFromHtml = false;
  if (plain?.body?.data) {
    text = decode(plain.body.data);
  } else if (html?.body?.data) {
    text = htmlToText(decode(html.body.data));
    convertedFromHtml = true;
  } else if (raw) {
    const body = decode(raw);
    convertedFromHtml = /<[a-z][\s\S]*>/i.test(body);
    text = convertedFromHtml ? htmlToText(body) : body;
  } else {
    text = msg.snippet ?? "(This message has no readable text content.)";
  }

  return {
    messageId,
    subject: header(msg, "Subject") || "(no subject)",
    from: header(msg, "From"),
    date: Number(msg.internalDate ?? 0),
    sizeBytes: msg.sizeEstimate ?? 0,
    unread: (msg.labelIds ?? []).includes("UNREAD"),
    snippet: msg.snippet ?? "",
    // Long marketing mail can be enormous; the reader is for judging a sender,
    // not for archival display.
    text: text.length > 200_000 ? `${text.slice(0, 200_000)}\n\n[truncated]` : text,
    convertedFromHtml,
  };
}
