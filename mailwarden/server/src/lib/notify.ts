import { config } from "../config.js";

/**
 * OPERATOR NOTIFICATIONS.
 *
 * A lead-capture form that writes to a table nobody watches is worse than no
 * form: the visitor believes they have been heard, and the operator finds out
 * days later. Every event here is one a human has to act on within hours —
 * someone asking for access, or someone paying.
 *
 * Deliberately a generic webhook rather than SMTP. Sending email needs a
 * provider, a domain, SPF/DKIM, and a deliverability reputation; a webhook
 * needs one URL and works today with Telegram, Discord, Slack, or Zapier. For
 * a solo operator who needs to know *now*, a phone notification beats an email
 * that lands in the same inbox this product exists to clean out.
 *
 * Failure is always swallowed. A notification that cannot be delivered must
 * never fail the request that triggered it — losing a sale because a Discord
 * webhook 500'd would be absurd.
 */

export type NotifyEvent = "access_request" | "upi_order" | "purchase";

const ICON: Record<NotifyEvent, string> = {
  access_request: "🙋",
  upi_order: "💳",
  purchase: "💰",
};

export function notifyOperator(event: NotifyEvent, title: string, detail: string): void {
  const url = config.notifyWebhookUrl;
  if (!url) return;

  const text = `${ICON[event]} ${title}\n${detail}`;

  // Shapes for the three services a solo founder is most likely to reach for.
  // Slack and Discord both accept `content`/`text`; Telegram's sendMessage
  // wants `text` too, so one body satisfies all of them.
  const body = JSON.stringify({ content: text, text, event, title, detail });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5_000);

  void fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
    signal: controller.signal,
  })
    .then((r) => {
      if (!r.ok) console.error(`[notify] webhook returned ${r.status} for ${event}`);
    })
    .catch((err) => {
      console.error(`[notify] could not deliver ${event}:`, err);
    })
    .finally(() => clearTimeout(timer));

  // Always logged as well, so `pnpm logs` is a complete record even when no
  // webhook is configured.
  console.log(`[notify] ${event}: ${title} — ${detail}`);
}
