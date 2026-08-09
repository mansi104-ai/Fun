import { candidatesFor } from "./candidates.js";
import { db } from "./db.js";
import { CATEGORIES, PROTECTED_CATEGORIES, type Category } from "./classify/taxonomy.js";
import { evaluate, type CandidateMessage } from "./safety/policy.js";
import type { BatchAction } from "./gmail/executor.js";

/**
 * CATEGORIES — the browse-by-kind layer.
 *
 * Recipes answer "clean the obvious stuff for me". Categories answer the other
 * half of the job: "show me everything you found, grouped the way I think about
 * my mail, and let me decide category by category."
 *
 * Two rules make this safe:
 *
 *  1. **Every category is listed, always** — including the protected ones. A
 *     user who cannot see `finance` or `security` in the list assumes we missed
 *     them. Showing them, with the count and an explicit "these are held back
 *     and why", is what turns the guardrails from an invisible constraint into
 *     a visible feature.
 *
 *  2. **Counts are guard-accurate.** Same discipline as recipes.ts: every
 *     number here comes out of a dry run of the real policy, so the number on
 *     the row is exactly what will happen. `total` is what exists; `cleanable`
 *     is what will actually move; the gap is itemised.
 */

export interface CategorySender {
  senderKey: string;
  displayName: string | null;
  messageCount: number;
  /** Messages from this sender that survive the guards. 0 for a held sender. */
  cleanableCount: number;
  totalBytes: number;
  unreadCount: number;
  lastSeen: number;
  hasUnsubscribe: boolean;
  /** Set when the sender is fully or partly held back. Shown verbatim. */
  holdReason: string | null;
}

export interface CategoryView {
  id: Category;
  label: string;
  icon: string;
  blurb: string;
  /** Protected categories are never bulk-actionable without a per-sender release. */
  isProtected: boolean;
  defaultAction: BatchAction;

  totalMessages: number;
  totalBytes: number;
  senderCount: number;

  cleanableMessages: number;
  cleanableBytes: number;
  cleanableSenders: number;

  /** totalMessages - cleanableMessages, i.e. what the guards are holding. */
  heldMessages: number;
  /** Deduped, human-readable list of why things were held. */
  heldReasons: string[];

  /**
   * True when the cohort is too large for one batch. The UI offers to run it in
   * slices rather than presenting a button that will be refused.
   */
  needsSplit: boolean;

  senders: CategorySender[];
}

interface Meta {
  label: string;
  icon: string;
  blurb: string;
  order: number;
}

/**
 * Copy is written for someone who has never thought about email taxonomy. The
 * blurb answers "what would I lose if I cleaned this?", not "what is this".
 */
const META: Record<Category, Meta> = {
  promotional: {
    label: "Promotions & deals",
    icon: "🏷️",
    blurb: "Sales, offers, and marketing blasts from shops and brands.",
    order: 1,
  },
  newsletter: {
    label: "Newsletters",
    icon: "📰",
    blurb: "Regular reading you signed up for — digests, roundups, updates.",
    order: 2,
  },
  social: {
    label: "Social networks",
    icon: "💬",
    blurb: "Likes, follows, mentions and comments you already saw in the app.",
    order: 3,
  },
  notification: {
    label: "App & service alerts",
    icon: "🔔",
    blurb: "Automated activity mail from the tools and services you use.",
    order: 4,
  },
  unknown: {
    label: "Unsorted",
    icon: "❓",
    blurb: "Senders we could not confidently place. Left alone until you say so.",
    order: 5,
  },
  transactional: {
    label: "Orders & receipts",
    icon: "🧾",
    blurb: "Order confirmations, invoices, delivery updates, warranties.",
    order: 6,
  },
  finance: {
    label: "Banking & money",
    icon: "🏦",
    blurb: "Bank statements, card alerts, payments, tax documents.",
    order: 7,
  },
  travel: {
    label: "Travel & bookings",
    icon: "✈️",
    blurb: "Flights, hotels, trains, boarding passes and itineraries.",
    order: 8,
  },
  security: {
    label: "Security & sign-in codes",
    icon: "🔐",
    blurb: "One-time codes, password resets, and login alerts.",
    order: 9,
  },
  personal: {
    label: "People",
    icon: "👤",
    blurb: "Mail written by a human — colleagues, friends, family.",
    order: 10,
  },
};

interface SenderRow {
  sender_key: string;
  display_name: string | null;
  category: string | null;
  message_count: number;
  unread_count: number;
  total_bytes: number;
  last_seen: number;
  has_unsubscribe: number;
}

function sendersByCategory(accountId: string): Map<Category, SenderRow[]> {
  const rows = db
    .prepare(
      `SELECT sender_key, display_name, category, message_count, unread_count,
              total_bytes, last_seen, has_unsubscribe
       FROM senders WHERE account_id = ? AND message_count > 0
       ORDER BY message_count DESC`,
    )
    .all(accountId) as SenderRow[];

  const out = new Map<Category, SenderRow[]>();
  for (const c of CATEGORIES) out.set(c, []);
  for (const r of rows) {
    // An unrecognised or missing category is surfaced under "Unsorted" rather
    // than dropped — a sender the user cannot see is a sender they cannot act on.
    const key = (out.has(r.category as Category) ? r.category : "unknown") as Category;
    out.get(key)!.push(r);
  }
  return out;
}

/**
 * Builds the full category view for an account. Every category in the taxonomy
 * appears in the result, even at zero, so the list does not reshuffle between
 * scans and the user can always confirm that a kind of mail was considered.
 */
export function computeCategories(accountId: string): CategoryView[] {
  const grouped = sendersByCategory(accountId);

  const views = [...grouped].map(([id, rows]) => {
    const meta = META[id];
    const isProtected = PROTECTED_CATEGORIES.has(id);
    const senderKeys = rows.map((r) => r.sender_key);

    const base = {
      id,
      label: meta.label,
      icon: meta.icon,
      blurb: meta.blurb,
      isProtected,
      defaultAction: "archive" as BatchAction,
      totalMessages: rows.reduce((s, r) => s + r.message_count, 0),
      totalBytes: rows.reduce((s, r) => s + r.total_bytes, 0),
      senderCount: rows.length,
      order: meta.order,
    };

    if (senderKeys.length === 0) {
      return {
        ...base,
        cleanableMessages: 0, cleanableBytes: 0, cleanableSenders: 0,
        heldMessages: 0, heldReasons: [], needsSplit: false, senders: [],
      };
    }

    // Dry run through the real policy. `confirmed: true` suppresses the
    // second-look prompt, which belongs at the confirm step, not on a listing.
    const verdict = evaluate({
      accountId,
      action: "archive",
      senderKeys,
      candidates: candidatesFor(accountId, senderKeys, "archive"),
      confirmed: true,
    });

    const allowedPerSender = new Map<string, { count: number; bytes: number }>();
    for (const c of verdict.allowed) {
      const acc = allowedPerSender.get(c.sender_key) ?? { count: 0, bytes: 0 };
      acc.count += 1;
      acc.bytes += c.size_bytes;
      allowedPerSender.set(c.sender_key, acc);
    }

    // First reason wins per sender; the guards are ordered most-specific first
    // (replied > pinned > protected category > low confidence > recency).
    const reasonPerSender = new Map<string, string>();
    for (const e of verdict.exclusions) {
      if (!reasonPerSender.has(e.senderKey)) reasonPerSender.set(e.senderKey, e.reason);
    }

    const senders: CategorySender[] = rows.map((r) => ({
      senderKey: r.sender_key,
      displayName: r.display_name,
      messageCount: r.message_count,
      cleanableCount: allowedPerSender.get(r.sender_key)?.count ?? 0,
      totalBytes: r.total_bytes,
      unreadCount: r.unread_count,
      lastSeen: r.last_seen,
      hasUnsubscribe: Boolean(r.has_unsubscribe),
      holdReason: reasonPerSender.get(r.sender_key) ?? null,
    }));

    const cleanableMessages = verdict.allowed.length;

    return {
      ...base,
      cleanableMessages,
      cleanableBytes: verdict.allowed.reduce((s, c) => s + c.size_bytes, 0),
      cleanableSenders: senders.filter((s) => s.cleanableCount > 0).length,
      heldMessages: base.totalMessages - cleanableMessages,
      heldReasons: summariseHeld(verdict.exclusions),
      needsSplit: verdict.violations.some(
        (v) => v.code === "BATCH_TOO_LARGE" || v.code === "TOO_MANY_SENDERS",
      ),
      senders,
    };
  });

  return views
    .sort((a, b) => a.order - b.order)
    .map(({ order: _order, ...rest }) => rest);
}

/**
 * Collapses per-sender exclusions into one line per reason.
 *
 * Exclusions arrive one per sender, so a category where twelve senders each had
 * a few recent messages produced twelve near-identical bullets differing only
 * in a number. Grouping by guard code and summing the counts says the same
 * thing once, accurately.
 */
/**
 * Every guard code MUST appear here.
 *
 * A missing entry falls through to that guard's own per-sender wording, which
 * carries no count — so the list renders as "4 from the last 7 days" followed
 * by a bare "Part of a conversation you replied to", and the numbers visibly
 * fail to add up to the total shown above them. That shipped, and it makes the
 * safety summary look broken exactly where it most needs to look precise.
 */
const HELD_LABEL: Record<string, (n: string) => string> = {
  TOO_RECENT: (n) => `${n} from the last 7 days — recent mail is more likely to still matter.`,
  PROTECTED_CATEGORY: (n) => `${n} from protected senders — receipts, codes, travel, or bank mail.`,
  REPLIED_SENDER: (n) => `${n} from people you have replied to.`,
  USER_PINNED: (n) => `${n} from senders you pinned as protected.`,
  LOW_CONFIDENCE: (n) => `${n} we are not confident enough to sort.`,
  STARRED: (n) => `${n} you starred.`,
  IN_REPLIED_THREAD: (n) => `${n} in conversations you replied to.`,
  HAS_ATTACHMENT: (n) => `${n} carrying attachments.`,
  GMAIL_IMPORTANT: (n) => `${n} Gmail marked important.`,
};

function summariseHeld(exclusions: { code: string; messageCount: number; reason: string }[]): string[] {
  const byCode = new Map<string, number>();
  for (const e of exclusions) byCode.set(e.code, (byCode.get(e.code) ?? 0) + e.messageCount);

  return [...byCode]
    .sort((a, b) => b[1] - a[1])
    .map(([code, n]) => {
      const label = HELD_LABEL[code];
      if (label) return label(n.toLocaleString());
      // Unknown guard: fall back to its own wording rather than dropping it —
      // a held message the user cannot see explained is the worst outcome.
      return exclusions.find((e) => e.code === code)!.reason;
    });
}

export function categoryById(accountId: string, id: string): CategoryView | null {
  return computeCategories(accountId).find((c) => c.id === id) ?? null;
}

/**
 * Resolves a category to the sender keys a batch should target.
 *
 * The client may pass `only` to narrow the selection — unticking senders it
 * does not want. That list is **intersected** with the server's own membership
 * set, never unioned, so a tampered request can shrink a batch but can never
 * pull in a sender that is not in the category.
 */
export function senderKeysForCategory(
  accountId: string,
  id: string,
  only?: string[],
): string[] | null {
  const view = categoryById(accountId, id);
  if (!view) return null;

  const actionable = view.senders.filter((s) => s.cleanableCount > 0).map((s) => s.senderKey);
  if (!only || only.length === 0) return actionable;

  const requested = new Set(only);
  return actionable.filter((k) => requested.has(k));
}
