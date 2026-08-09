import type { Category } from "./taxonomy.js";
import { PROTECTED_CATEGORIES } from "./taxonomy.js";

/**
 * Aggregated, content-free facts about one sender. This is the ONLY shape that
 * ever reaches a third-party model — no subjects, no bodies, no recipients.
 */
export interface SenderFacts {
  senderKey: string;
  displayName: string | null;
  domain: string;
  messageCount: number;
  unreadCount: number;
  totalBytes: number;
  firstSeen: number | null;
  lastSeen: number | null;
  hasUnsubscribe: boolean;
  userReplied: boolean;
  /** Distinct Gmail label IDs seen across this sender's messages. */
  labels: string[];
  /** Distinct subject-template hashes — high repetition implies bulk mail. */
  distinctSubjectHashes: number;
  /**
   * What the user did to this sender last time, and how often. Their own past
   * decision outranks any classifier's guess about what they want.
   */
  userDecision?: "keep" | "archive" | "trash" | null;
  decisionCount?: number;
}

export interface Verdict {
  category: Category;
  confidence: number;
  reason: string;
  protectedSender: boolean;
  source: "heuristic" | `llm:${string}`;
}

/**
 * Security signals must be SPECIFIC.
 *
 * `no-reply@` and `noreply@` were originally in this list and are now
 * deliberately excluded: measured against a real mailbox, they match a large
 * share of ALL automated senders, not security ones. Their presence classified
 * Google Classroom (647 messages) as `security` and locked it permanently.
 * Over-protection is safer than under-protection, but it is not free — mail the
 * user wanted cleaned that we refuse to touch is the product failing quietly.
 *
 * Genuine security senders are still caught by the specific tokens below;
 * `no-reply@accounts.google.com` matches on `accounts.google`.
 */
const SECURITY_DOMAIN_HINTS = [
  "accounts.google", "login", "signin", "auth", "security", "verify",
  "verification", "otp", "one-time", "2fa", "mfa", "password", "id.apple",
  "okta", "duosecurity", "authy", "onelogin",
];
const FINANCE_HINTS = [
  "bank", "chase", "wellsfargo", "hdfc", "icici", "sbi", "paypal", "stripe",
  "wise", "revolut", "amex", "visa", "mastercard", "coinbase", "fidelity",
  "vanguard", "irs", "hmrc", "incometax",
];
const TRAVEL_HINTS = [
  "airlines", "airways", "flight", "booking.com", "expedia", "airbnb", "irctc",
  "makemytrip", "united", "delta", "lufthansa", "emirates", "indigo", "marriott",
  "hilton", "hotels.com", "uber", "lyft",
];
const SOCIAL_HINTS = [
  "facebook", "instagram", "twitter", "x.com", "linkedin", "reddit", "tiktok",
  "pinterest", "discord", "slack", "snapchat", "threads",
];
const TRANSACTIONAL_LOCAL_HINTS = [
  "order", "receipt", "invoice", "billing", "shipping", "delivery", "payment",
  "confirm", "tracking", "support", "ticket",
];

const includesAny = (haystack: string, needles: string[]): boolean =>
  needles.some((n) => haystack.includes(n));

/**
 * Deterministic first-pass classifier.
 *
 * Design intent: this must resolve the large majority of senders on its own.
 * Every sender it settles is a sender the LLM never sees, which is what keeps
 * the free tier inside a 50-request/day budget and the paid tier cheap.
 * It is also fully offline, so an LLM outage degrades quality, not
 * availability.
 *
 * Ordering matters: protective rules run first and win. A false "security"
 * costs the user nothing; a false "promotional" costs them a password reset.
 */
export function classifyHeuristically(f: SenderFacts): Verdict | null {
  const local = f.senderKey.split("@")[0]?.toLowerCase() ?? "";
  const domain = f.domain.toLowerCase();
  const name = (f.displayName ?? "").toLowerCase();
  const blob = `${f.senderKey} ${name}`.toLowerCase();
  const labels = new Set(f.labels);

  const protect = (category: Category, confidence: number, reason: string): Verdict => ({
    category,
    confidence,
    reason,
    protectedSender: true,
    source: "heuristic",
  });

  // ── Protective rules (highest priority) ────────────────────────────────

  // 1. The user has written back. Nothing else outranks this.
  if (f.userReplied) {
    return protect("personal", 0.99, "You have replied to this sender before.");
  }

  // 2. Security / OTP. Bulk mail always carries List-Unsubscribe; security mail
  //    essentially never does. That absence plus a security-shaped address is a
  //    strong, low-false-positive signal.
  if (!f.hasUnsubscribe && includesAny(blob, SECURITY_DOMAIN_HINTS)) {
    return protect("security", 0.9, "Looks like login codes or security alerts — never bulk-actioned.");
  }

  // 3. Money and travel. Receipts and boarding passes hide in Gmail's
  //    Promotions tab, which is exactly how competitors lose them.
  if (includesAny(blob, FINANCE_HINTS)) {
    return protect("finance", 0.85, "Financial sender — statements and payment records.");
  }
  if (includesAny(blob, TRAVEL_HINTS)) {
    return protect("travel", 0.82, "Travel sender — may contain bookings or boarding passes.");
  }

  // 4. Transactional. Low subject-template repetition means each message is
  //    likely distinct (a real receipt), not one blast reused 400 times.
  const templateRatio = f.messageCount > 0 ? f.distinctSubjectHashes / f.messageCount : 1;
  if (!f.hasUnsubscribe && includesAny(local, TRANSACTIONAL_LOCAL_HINTS) && templateRatio > 0.5) {
    return protect("transactional", 0.78, "Order, receipt, or billing mail — kept by default.");
  }

  // ── Actionable rules ───────────────────────────────────────────────────

  const actionable = (category: Category, confidence: number, reason: string): Verdict => ({
    category,
    confidence,
    reason,
    protectedSender: PROTECTED_CATEGORIES.has(category),
    source: "heuristic",
  });

  /**
   * The user's own past decisions.
   *
   * Deliberately placed AFTER the protective block: if a sender has since
   * started sending boarding passes or login codes, that outranks the fact that
   * the user archived their marketing mail six months ago. But it comes before
   * every inference rule below, because a decision the user actually made beats
   * anything Gmail's labels or our template maths can infer.
   *
   * This is also a budget saver — a decided sender never reaches the LLM again.
   */
  if (f.userDecision === "archive" || f.userDecision === "trash") {
    const times = f.decisionCount ?? 1;
    return actionable(
      "promotional",
      Math.min(0.97, 0.88 + times * 0.03),
      times > 1
        ? `You have cleaned this sender ${times} times before.`
        : "You cleaned this sender last time.",
    );
  }
  if (f.userDecision === "keep") {
    return {
      category: "personal",
      confidence: 0.95,
      reason: "You chose to keep this sender.",
      protectedSender: true,
      source: "heuristic",
    };
  }

  if (labels.has("CATEGORY_SOCIAL") || includesAny(blob, SOCIAL_HINTS)) {
    return actionable("social", 0.8, "Social network activity.");
  }

  // Gmail's own classifier is a strong prior, but only when we also see
  // bulk-mail headers. Gmail alone misfiles receipts into Promotions.
  if (labels.has("CATEGORY_PROMOTIONS") && f.hasUnsubscribe) {
    const unreadRate = f.messageCount > 0 ? f.unreadCount / f.messageCount : 0;
    if (unreadRate > 0.8 && f.messageCount >= 5) {
      return actionable(
        "promotional",
        0.92,
        `Marketing mail you almost never open — ${Math.round(unreadRate * 100)}% unread across ${f.messageCount} messages.`,
      );
    }
    return actionable("promotional", 0.8, "Marketing mail with a one-click unsubscribe link.");
  }

  if (labels.has("CATEGORY_UPDATES") && f.hasUnsubscribe) {
    return actionable("notification", 0.72, "Automated service notifications.");
  }

  if (labels.has("CATEGORY_FORUMS")) {
    return actionable("newsletter", 0.7, "Mailing list or forum digest.");
  }

  // Heavy template reuse + unsubscribe header = bulk mail, whatever Gmail said.
  if (f.hasUnsubscribe && f.messageCount >= 10 && templateRatio < 0.35) {
    return actionable(
      "newsletter",
      0.75,
      `Recurring bulk mail — ${f.messageCount} messages reusing ${f.distinctSubjectHashes} subject templates.`,
    );
  }

  // ── Undecided: hand this sender to the LLM tier ────────────────────────
  return null;
}

/**
 * Cheap pre-filter for LLM spend. Senders below this bar aren't worth a model
 * call — resolving one message saves the user nothing.
 */
export function worthEscalating(f: SenderFacts): boolean {
  return f.messageCount >= 3 && !f.userReplied;
}

/**
 * Last-resort tier, used only when the LLM returned nothing for a sender —
 * budget exhausted, provider down, or a malformed response.
 *
 * The previous behaviour was to mark every such sender `unknown` at confidence
 * 0.3 and protect it. That is safe but it is not honest: measured on a real
 * mailbox it left a standing ~6% of mail permanently untouchable for no reason
 * other than an outage, and the user was never told why. A provider being down
 * is our problem, not something the user should pay for in locked mail.
 *
 * So: when the bulk-mail evidence is strong and entirely local — an RFC-8058
 * unsubscribe header, a real volume of mail, and a user who almost never opens
 * it — we say so at a confidence that reflects a guess rather than a finding.
 * 0.55 clears the guard layer's hard floor (0.4), so the mail is visible and
 * actionable in the category view, but sits below the auto-suggest bar (0.7),
 * so nothing sweeps it up without the user deliberately choosing it.
 *
 * Everything else still returns null and stays protected. The bar here is
 * intentionally high; the protective heuristics have already had their pass.
 */
export function fallbackClassify(f: SenderFacts): Verdict | null {
  if (!f.hasUnsubscribe || f.messageCount < 10) return null;

  const unreadRate = f.messageCount > 0 ? f.unreadCount / f.messageCount : 0;
  if (unreadRate < 0.7) return null;

  const templateRatio = f.distinctSubjectHashes / f.messageCount;
  if (templateRatio > 0.6) return null; // too varied to be a mail blast

  return {
    category: "newsletter",
    confidence: 0.55,
    reason:
      `Bulk mail with an unsubscribe link — ${f.messageCount} messages, ` +
      `${Math.round(unreadRate * 100)}% unread. We could not double-check this one, ` +
      `so review it before cleaning.`,
    protectedSender: false,
    source: "heuristic",
  };
}
