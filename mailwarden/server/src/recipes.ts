import { candidatesFor } from "./candidates.js";
import { db } from "./db.js";
import { evaluate, type CandidateMessage } from "./safety/policy.js";
import { DAY_MS } from "./safety/limits.js";
import type { BatchAction } from "./gmail/executor.js";

/**
 * RECIPES — the one-click layer.
 *
 * Reviewing 300 sender cards is powerful but it is not *easy*. A recipe is a
 * named, pre-built cohort ("Marketing you never open") that resolves to a
 * single button press. This is the Smart Views insight from
 * docs/00-competitive-analysis.md §3: named cohorts outperform a filter
 * builder, because nobody wants to design their own cleanup.
 *
 * The critical property is that a tile's number is **guard-accurate**. Every
 * count here is produced by running the real safety policy in dry-run, so the
 * number on the tile is exactly what will happen — never an optimistic
 * estimate that shrinks at the confirm step. A tile that promises 2,341 and
 * delivers 1,800 destroys trust faster than a tile that never existed.
 */

export interface RecipeDefinition {
  id: string;
  title: string;
  /** One line, addressed to the user, describing the job. */
  blurb: string;
  icon: string;
  action: BatchAction;
  /** Ordering on the grid. Lower is earlier. */
  order: number;
  /** Chooses candidate senders. Guards are applied afterwards, never here. */
  select: (s: SenderSummary) => boolean;
}

export interface SenderSummary {
  senderKey: string;
  displayName: string | null;
  category: string | null;
  confidence: number;
  messageCount: number;
  unreadCount: number;
  totalBytes: number;
  lastSeen: number;
  firstSeen: number;
  hasUnsubscribe: boolean;
  isProtected: boolean;
}

export interface Recipe extends Omit<RecipeDefinition, "select"> {
  messageCount: number;
  bytes: number;
  senderCount: number;
  senderKeys: string[];
  /** Names shown on the tile so the job is concrete, not abstract. */
  sampleSenders: string[];
}

const unreadRate = (s: SenderSummary): number =>
  s.messageCount > 0 ? s.unreadCount / s.messageCount : 0;

const daysSince = (ts: number): number => (Date.now() - ts) / DAY_MS;

export const RECIPES: RecipeDefinition[] = [
  {
    id: "unread-marketing",
    title: "Marketing you never open",
    blurb: "Promotional senders whose mail you leave unread almost every time.",
    icon: "🏷️",
    action: "archive",
    order: 1,
    select: (s) => s.category === "promotional" && unreadRate(s) > 0.8 && s.messageCount >= 5,
  },
  {
    id: "old-newsletters",
    title: "Newsletters gone quiet",
    blurb: "Lists that stopped being relevant — nothing new from them in months.",
    icon: "📰",
    action: "archive",
    order: 2,
    select: (s) => s.category === "newsletter" && daysSince(s.lastSeen) > 120,
  },
  {
    id: "social-noise",
    title: "Social notifications",
    blurb: "Likes, follows, mentions and comments you already saw in the app.",
    icon: "💬",
    action: "archive",
    order: 3,
    select: (s) => s.category === "social",
  },
  {
    id: "app-notifications",
    title: "App and service alerts",
    blurb: "Automated activity mail from tools and services you use.",
    icon: "🔔",
    action: "archive",
    order: 4,
    select: (s) => s.category === "notification" && unreadRate(s) > 0.5,
  },
  {
    id: "storage-hogs",
    title: "Biggest storage users",
    blurb: "The senders eating the most of your Gmail quota.",
    icon: "💾",
    action: "archive",
    order: 5,
    // Bytes rather than count: 40 newsletters with images beat 4,000 plain-text
    // notifications for reclaiming storage, which is the actual pain point.
    select: (s) => !s.isProtected && s.totalBytes > 50 * 1_048_576,
  },
  {
    id: "ancient-unread",
    title: "Ancient and unread",
    blurb: "Bulk mail over two years old that you never opened.",
    icon: "🗄️",
    action: "archive",
    order: 6,
    select: (s) => s.hasUnsubscribe && daysSince(s.lastSeen) > 730 && unreadRate(s) > 0.7,
  },
  {
    id: "deep-clean",
    title: "Everything we suggest",
    blurb: "Every sender above, in one pass. Still fully reversible.",
    icon: "✨",
    action: "archive",
    order: 7,
    select: (s) =>
      !s.isProtected &&
      ["promotional", "newsletter", "social", "notification"].includes(s.category ?? "") &&
      s.confidence >= 0.7,
  },
];

function loadSummaries(accountId: string): SenderSummary[] {
  const rows = db
    .prepare(
      `SELECT sender_key, display_name, category, confidence, message_count, unread_count,
              total_bytes, last_seen, first_seen, has_unsubscribe, protected, user_protected
       FROM senders WHERE account_id = ? AND message_count > 0`,
    )
    .all(accountId) as Record<string, unknown>[];

  return rows.map((r) => ({
    senderKey: r.sender_key as string,
    displayName: (r.display_name as string | null) ?? null,
    category: (r.category as string | null) ?? null,
    confidence: (r.confidence as number | null) ?? 0,
    messageCount: r.message_count as number,
    unreadCount: (r.unread_count as number) ?? 0,
    totalBytes: (r.total_bytes as number) ?? 0,
    lastSeen: (r.last_seen as number) ?? 0,
    firstSeen: (r.first_seen as number) ?? 0,
    hasUnsubscribe: Boolean(r.has_unsubscribe),
    // Effective protection, matching what the guard layer will decide.
    isProtected:
      r.user_protected === 1 || (Boolean(r.protected) && r.user_protected !== -1),
  }));
}

/**
 * Computes every recipe for an account, with counts that have already survived
 * the guardrails. Recipes resolving to nothing are returned with zero counts so
 * the grid stays stable between scans rather than reshuffling under the user.
 */
export function computeRecipes(accountId: string): Recipe[] {
  const summaries = loadSummaries(accountId);

  return RECIPES.map((def) => {
    const matched = summaries.filter((s) => !s.isProtected && def.select(s));
    const senderKeys = matched.map((s) => s.senderKey);

    if (senderKeys.length === 0) {
      return {
        ...stripSelect(def),
        messageCount: 0, bytes: 0, senderCount: 0, senderKeys: [], sampleSenders: [],
      };
    }

    // Dry-run through the real policy so the tile cannot over-promise.
    const verdict = evaluate({
      accountId,
      action: def.action,
      senderKeys,
      candidates: candidatesFor(accountId, senderKeys, "archive"),
      confirmed: true,
    });

    const allowedKeys = new Set(verdict.allowed.map((c) => c.sender_key));
    const survivors = matched.filter((s) => allowedKeys.has(s.senderKey));

    return {
      ...stripSelect(def),
      messageCount: verdict.allowed.length,
      bytes: verdict.allowed.reduce((sum, c) => sum + c.size_bytes, 0),
      senderCount: survivors.length,
      senderKeys: survivors.map((s) => s.senderKey),
      sampleSenders: survivors
        .slice()
        .sort((a, b) => b.messageCount - a.messageCount)
        .slice(0, 4)
        .map((s) => s.displayName || s.senderKey),
    };
  }).sort((a, b) => a.order - b.order);
}

function stripSelect(def: RecipeDefinition): Omit<RecipeDefinition, "select"> {
  const { select: _select, ...rest } = def;
  return rest;
}

export function recipeById(accountId: string, id: string): Recipe | null {
  return computeRecipes(accountId).find((r) => r.id === id) ?? null;
}
