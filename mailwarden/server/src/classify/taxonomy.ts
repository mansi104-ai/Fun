/** Categories the UI knows how to render and the LLM is constrained to emit. */
export const CATEGORIES = [
  "promotional", // marketing, deals, newsletters with commercial intent
  "newsletter", // editorial content the user opted into
  "notification", // app/service activity: "X commented on your post"
  "transactional", // order confirmations, shipping, invoices — receipts live here
  "security", // OTP, password reset, login alerts, 2FA
  "personal", // a human wrote this
  "social", // social network activity
  "finance", // banks, statements, tax
  "travel", // bookings, boarding passes, itineraries
  "unknown",
] as const;

export type Category = (typeof CATEGORIES)[number];

/**
 * Categories that can never be bulk-actioned without an explicit per-sender
 * override. This is the guarantee that stops "delete all promotions" from
 * eating a boarding pass or a password-reset link — the single most-cited
 * failure of every competitor in docs/00.
 */
export const PROTECTED_CATEGORIES: ReadonlySet<Category> = new Set<Category>([
  "security",
  "transactional",
  "finance",
  "travel",
  "personal",
]);

/** Safe to propose for bulk archive/trash when confidence is high enough. */
export const ACTIONABLE_CATEGORIES: ReadonlySet<Category> = new Set<Category>([
  "promotional",
  "newsletter",
  "notification",
  "social",
]);

export const MIN_AUTO_SUGGEST_CONFIDENCE = 0.7;

export function isCategory(v: unknown): v is Category {
  return typeof v === "string" && (CATEGORIES as readonly string[]).includes(v);
}
