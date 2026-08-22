import { config } from "../config.js";

/**
 * OPERATOR NOTIFICATIONS.
 *
 * A lead-capture form that writes to a table nobody watches is worse than no
 * form: the visitor believes they have been heard, and the operator finds out
 * days later. Every event here is one a human has to act on within hours —
 * someone asking for access, or someone paying.
 *
 * Two independent channels, either or both configurable:
 *
 *   WEBHOOK  — one URL, works today with Telegram, Discord, Slack, or Zapier.
 *              Reaches a phone in minutes, which is what "act within hours"
 *              actually requires.
 *   EMAIL    — Resend's HTTP API. Slower and easier to miss, but it needs no
 *              chat app configured and it is the channel most operators check
 *              by reflex.
 *
 * Email is sent over HTTP rather than SMTP on purpose: no dependency, no
 * connection pool, and the same fetch-and-swallow shape as the webhook. The
 * cost is a provider account — see config.alertEmail for why the default
 * sender needs no domain.
 *
 * Failure is always swallowed, on both channels. A notification that cannot be
 * delivered must never fail the request that triggered it — losing a sale
 * because a Discord webhook 500'd would be absurd.
 */

export type NotifyEvent = "access_request" | "upi_order" | "purchase";

const ICON: Record<NotifyEvent, string> = {
  access_request: "🙋",
  upi_order: "💳",
  purchase: "💰",
};

export function notifyOperator(event: NotifyEvent, title: string, detail: string): void {
  const text = `${ICON[event]} ${title}\n${detail}`;

  sendWebhook(event, title, detail, text);
  sendEmail(event, title, detail, text);

  // Always logged as well, so `pnpm logs` is a complete record even when no
  // channel is configured.
  console.log(`[notify] ${event}: ${title} — ${detail}`);
}

/** POST the alert as JSON. Silent no-op when NOTIFY_WEBHOOK_URL is unset. */
function sendWebhook(event: NotifyEvent, title: string, detail: string, text: string): void {
  const url = config.notifyWebhookUrl;
  if (!url) return;

  // Shapes for the three services a solo founder is most likely to reach for.
  // Slack and Discord both accept `content`/`text`; Telegram's sendMessage
  // wants `text` too, so one body satisfies all of them.
  const body = JSON.stringify({ content: text, text, event, title, detail });

  void post(url, { "Content-Type": "application/json" }, body, `webhook (${event})`);
}

/**
 * Email the alert through Resend. Silent no-op unless BOTH the API key and a
 * destination address are set — a key with nowhere to send is a
 * misconfiguration, not a reason to guess at a recipient.
 *
 * The subject carries the whole headline, because on a phone lock screen the
 * subject is frequently all that is read.
 */
function sendEmail(event: NotifyEvent, title: string, detail: string, text: string): void {
  const { resendApiKey, to, from } = config.alertEmail;
  if (!resendApiKey || !to) return;

  const body = JSON.stringify({
    from,
    to: [to],
    subject: `${ICON[event]} ${title}`,
    text: `${text}\n\n${config.appUrl}/admin.html`,
    html:
      `<p style="font-size:16px;margin:0 0 12px">${ICON[event]} <strong>${escapeHtml(title)}</strong></p>` +
      `<p style="margin:0 0 20px;white-space:pre-wrap">${escapeHtml(detail)}</p>` +
      `<p style="margin:0"><a href="${config.appUrl}/admin.html">Open the admin queue</a></p>`,
  });

  void post(
    "https://api.resend.com/emails",
    { "Content-Type": "application/json", Authorization: `Bearer ${resendApiKey}` },
    body,
    `email (${event})`,
  );
}

/** Fire-and-forget POST with a hard timeout. Never throws, never rejects. */
function post(
  url: string,
  headers: Record<string, string>,
  body: string,
  label: string,
): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5_000);

  return fetch(url, { method: "POST", headers, body, signal: controller.signal })
    .then(async (r) => {
      if (!r.ok) {
        // Resend explains refusals (unverified sender, wrong recipient) in the
        // body; without it a 403 is unactionable.
        const why = await r.text().catch(() => "");
        console.error(`[notify] ${label} returned ${r.status}${why ? ` — ${why.slice(0, 300)}` : ""}`);
      }
    })
    .catch((err) => {
      console.error(`[notify] could not deliver ${label}:`, err);
    })
    .finally(() => clearTimeout(timer));
}

function escapeHtml(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );
}
