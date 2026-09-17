/**
 * THE SANDBOX INBOX — the mail a visitor can drop into /try.html.
 *
 * This is not the demo account in demo/seed.ts. That one mints a session,
 * writes to the database and is dev-only. This is a fixed, read-only list that
 * exists so a stranger with no account can watch the real classifier and the
 * real guard layer decide what happens to mail they chose themselves.
 *
 * The catalogue is held on the SERVER, and the client sends only ids. That is
 * deliberate: if the browser posted whole messages, the endpoint would be a
 * "classify this arbitrary text" API and the demo would stop resembling what
 * the product actually does — which is read metadata that Gmail already
 * labelled, and never the body.
 *
 * WHAT THE MIX IS FOR
 *
 * Ten pieces of obvious clutter would make a demo where everything gets
 * cleaned and nothing is learned. The interesting half is `tricky`: mail that
 * *looks* cleanable and must survive anyway. Every guard in docs/06 §3 has at
 * least one message here that trips it, so a visitor who selects the whole
 * inbox sees the entire guard layer fire at once.
 *
 * `subject` is shown in the inbox picker and then thrown away — run.ts hashes
 * it with the same hashSubject() that sync.ts uses and the trace displays the
 * hash. Showing the subject and then showing what we keep of it is the point:
 * the data-minimisation claim in docs/03 §4 becomes something a visitor
 * watches happen rather than something they read.
 */

/**
 * EXACTLY the fields the pipeline reads — the sandbox's equivalent of what
 * Gmail hands us for one message under `format: "metadata"`.
 *
 * The split between this and `SandboxMessage` below is the privacy claim
 * expressed as a type rather than a comment: `runSandbox` takes `InboxMessage`,
 * so there is no body in scope for it to read even by accident. When a visitor
 * writes their own test email on /try.html, the browser sends these fields and
 * keeps the body it never had a reason to transmit.
 */
export interface InboxMessage {
  /** Stable id, used to correlate the trace back to the browser's own copy. */
  id: string;
  senderKey: string;
  senderName: string;
  /** Read, hashed, and dropped — exactly as the Subject header is in sync.ts. */
  subject: string;
  /** Days before now. Anything under LIMITS.recencyProtectionDays trips G4. */
  ageDays: number;
  sizeKb: number;
  /** Gmail label ids as sync.ts would have recorded them, minus INBOX/UNREAD. */
  labels: string[];
  unread: boolean;
  /** An RFC-8058 List-Unsubscribe header. Bulk mail has one; security mail does not. */
  hasUnsubscribe: boolean;
  starred?: boolean;
  hasAttachment?: boolean;
  important?: boolean;
  /** Puts a SENT message in this message's thread, exactly as a real reply would. */
  youRepliedInThread?: boolean;
  /** True for a message the visitor wrote themselves. Presentation only. */
  custom?: boolean;
}

export interface SandboxMessage extends InboxMessage {
  /**
   * Prose that exists ONLY to be visibly withheld.
   *
   * `format: "metadata"` means Gmail never transfers a body to us at all, so
   * there is nothing in the product for this to correspond to. It is served
   * with the catalogue, shown in the sample card, and is conspicuously absent
   * from the /api/demo/run response — which a sceptic can confirm in their own
   * network tab. A claim someone can check beats a claim they have to accept.
   */
  body: string;
  /**
   * One line for the picker. Says what KIND of mail this is — never what
   * Mailwarden will decide. A card that pre-announces the verdict turns the
   * demo back into marketing copy.
   */
  note: string;
  group: "bulk" | "tricky";
}

export const SANDBOX_INBOX: SandboxMessage[] = [
  // ── Bulk: the mail the product exists to remove ──────────────────────
  {
    id: "groupon-1",
    senderKey: "deals@groupon.com",
    senderName: "Groupon",
    subject: "⚡ 70% off spa days near you — today only",
    body:
      "Hi there! Your weekend is sorted. 70% off at 14 spas within 5km of you, plus free cancellation. Deals end at midnight — browse all 340 offers in your area.",
    ageDays: 412,
    sizeKb: 184,
    labels: ["CATEGORY_PROMOTIONS"],
    unread: true,
    hasUnsubscribe: true,
    note: "Marketing blast, unopened, over a year old.",
    group: "bulk",
  },
  {
    id: "groupon-2",
    senderKey: "deals@groupon.com",
    senderName: "Groupon",
    subject: "Last chance: your weekend deals expire tonight",
    body:
      "Last call. The deals in your cart expire tonight at 11:59pm. Checkout in one tap and save an average of ₹2,400 on this order.",
    ageDays: 260,
    sizeKb: 176,
    labels: ["CATEGORY_PROMOTIONS"],
    unread: true,
    hasUnsubscribe: true,
    note: "Same sender again — decisions are made per sender, not per message.",
    group: "bulk",
  },
  {
    id: "groupon-3",
    senderKey: "deals@groupon.com",
    senderName: "Groupon",
    subject: "New deals in your area",
    body:
      "Fresh this week: 22 new restaurant deals, 9 spa offers and a half-price karting session. Pick yours before they sell out.",
    ageDays: 2,
    sizeKb: 169,
    labels: ["CATEGORY_PROMOTIONS"],
    unread: true,
    hasUnsubscribe: true,
    note: "Identical marketing mail, but it arrived two days ago.",
    group: "bulk",
  },
  {
    id: "myntra-1",
    senderKey: "offers@myntra.com",
    senderName: "Myntra",
    subject: "END OF REASON SALE starts now 🛍",
    body:
      "The sale you wait all year for is live. Up to 80% off across 2,800 brands. Your size is still in stock in 41 of your saved items — shop now.",
    ageDays: 190,
    sizeKb: 228,
    labels: ["CATEGORY_PROMOTIONS"],
    unread: true,
    hasUnsubscribe: true,
    note: "Retail promotion, never opened.",
    group: "bulk",
  },
  {
    id: "myntra-2",
    senderKey: "offers@myntra.com",
    senderName: "Myntra",
    subject: "Your wishlist is on sale",
    body:
      "Good news — 4 items from your wishlist just dropped in price, including the jacket you saved in March. Free delivery on orders over ₹1,199.",
    ageDays: 95,
    sizeKb: 210,
    labels: ["CATEGORY_PROMOTIONS"],
    unread: false,
    hasUnsubscribe: true,
    starred: true,
    note: "Another Myntra promotion — this one you starred.",
    group: "bulk",
  },
  {
    id: "linkedin-1",
    senderKey: "news@linkedin.com",
    senderName: "LinkedIn",
    subject: "You appeared in 9 searches this week",
    body:
      "You're getting noticed. Your profile appeared in 9 searches this week, up 3 from last week. See who's looking and what they searched for.",
    ageDays: 45,
    sizeKb: 88,
    labels: ["CATEGORY_SOCIAL"],
    unread: true,
    hasUnsubscribe: true,
    note: "Social network activity digest.",
    group: "bulk",
  },
  {
    id: "medium-1",
    senderKey: "digest@medium.com",
    senderName: "Medium Daily Digest",
    subject: "Stories for you: 7 reads picked for your interests",
    body:
      "Today's picks, based on what you've been reading: 'The quiet death of the monolith', 'What I learned shipping 200 features', and 5 more.",
    ageDays: 300,
    sizeKb: 142,
    labels: ["CATEGORY_UPDATES"],
    unread: true,
    hasUnsubscribe: true,
    note: "A newsletter you opted into and stopped reading.",
    group: "bulk",
  },
  {
    id: "oldstartup-1",
    senderKey: "newsletter@oldstartup.io",
    senderName: "OldStartup",
    subject: "Product update #48",
    body:
      "Release 4.8 is out. New: bulk import, a rebuilt permissions model, and 31 bug fixes. Full changelog attached as a PDF.",
    ageDays: 900,
    sizeKb: 120,
    labels: ["CATEGORY_PROMOTIONS"],
    unread: true,
    hasUnsubscribe: true,
    hasAttachment: true,
    note: "Dead newsletter from a company you forgot — with a PDF attached.",
    group: "bulk",
  },

  // ── Tricky: mail that looks cleanable and must survive ───────────────
  {
    id: "united-1",
    senderKey: "info@united.airlines.com",
    senderName: "United Airlines",
    subject: "Your boarding pass for UA 82 — DEL to EWR",
    body:
      "Your boarding pass is ready. UA 82, Delhi (DEL) to Newark (EWR), departing 01:35. Seat 24A. Gate and terminal are confirmed 3 hours before departure.",
    ageDays: 140,
    sizeKb: 96,
    labels: ["CATEGORY_PROMOTIONS"],
    unread: true,
    hasUnsubscribe: true,
    note: "Gmail filed this under Promotions. It carries a boarding pass.",
    group: "tricky",
  },
  {
    id: "chase-1",
    senderKey: "alerts@chase.com",
    senderName: "Chase Bank",
    subject: "Your statement for account ending 4417 is ready",
    body:
      "Your monthly statement for the account ending 4417 is now available. Statement balance ₹184,220.14, minimum due ₹9,211.00 by the 28th.",
    ageDays: 60,
    sizeKb: 41,
    labels: ["CATEGORY_UPDATES"],
    unread: true,
    hasUnsubscribe: false,
    note: "A bank statement notice sitting in the Updates tab.",
    group: "tricky",
  },
  {
    id: "google-1",
    senderKey: "no-reply@accounts.google.com",
    senderName: "Google Accounts",
    subject: "Your verification code is 418 902",
    body:
      "Your verification code is 418 902. Enter this code to finish signing in. Don't share it with anyone — Google will never ask you for it.",
    ageDays: 75,
    sizeKb: 18,
    labels: [],
    unread: false,
    hasUnsubscribe: false,
    note: "A one-time login code — the kind of mail people fear losing most.",
    group: "tricky",
  },
  {
    id: "amazon-1",
    senderKey: "receipts@amazon.in",
    senderName: "Amazon Orders",
    subject: "Your order of 'Mechanical Keyboard' has shipped",
    body:
      "Good news, your order has shipped. Mechanical Keyboard (Brown switches) is out for delivery and arrives tomorrow by 9pm. Track your package.",
    ageDays: 220,
    sizeKb: 134,
    labels: ["CATEGORY_UPDATES"],
    unread: false,
    hasUnsubscribe: false,
    important: true,
    note: "A shipping receipt Gmail also marked Important.",
    group: "tricky",
  },
  {
    id: "priya-1",
    senderKey: "priya@worklab.com",
    senderName: "Priya Nair",
    subject: "Re: Thursday's handover notes",
    body:
      "Thanks for picking this up so fast. I've put the handover notes in the shared drive — section 4 is the one we argued about, have a look before Thursday.",
    ageDays: 30,
    sizeKb: 52,
    labels: [],
    unread: false,
    hasUnsubscribe: false,
    youRepliedInThread: true,
    note: "A colleague, in a thread you wrote back in.",
    group: "tricky",
  },
  {
    id: "priya-2",
    senderKey: "priya@worklab.com",
    senderName: "Priya Nair",
    subject: "Lunch on Friday?",
    body:
      "Are you around on Friday? There's a new place near the office everyone keeps going on about. 1pm-ish if that works for you.",
    ageDays: 110,
    sizeKb: 21,
    labels: [],
    unread: false,
    hasUnsubscribe: false,
    note: "The same colleague, in a thread you never replied to.",
    group: "tricky",
  },
];

const BY_ID = new Map(SANDBOX_INBOX.map((m) => [m.id, m]));

/**
 * Ceilings for visitor-written messages.
 *
 * The endpoint takes no credential, so these numbers are its entire abuse
 * story. They are generous for a person trying the demo and uninteresting for
 * anyone trying to use it as free compute: the work is O(messages) in-memory
 * with no model call, no database write and no outbound request, so the only
 * resource on the table is a few milliseconds of CPU.
 */
export const CUSTOM_LIMITS = {
  maxCustom: 10,
  /** Catalogue picks plus custom messages. */
  maxTotal: 30,
  maxSubject: 300,
  maxSenderKey: 200,
  maxName: 120,
  maxAgeDays: 5_000,
  maxSizeKb: 50_000,
  maxLabels: 2,
} as const;

/**
 * The only labels a visitor may set.
 *
 * This allowlist is load-bearing, not tidiness. `labels` flows into the
 * guard layer, where `SENT` means "the user wrote this" and `TRASH` and
 * `INBOX` decide which messages an action can even touch. A free-text label
 * field would let a crafted request mark its own message as sent mail and
 * watch the reply guards fire on a fiction — the demo would be lying, and it
 * would be the visitor's own input doing it.
 *
 * Every other label the pipeline sees is derived from a boolean below.
 */
const SETTABLE_LABELS = new Set([
  "CATEGORY_PROMOTIONS",
  "CATEGORY_SOCIAL",
  "CATEGORY_UPDATES",
  "CATEGORY_FORUMS",
  "CATEGORY_PERSONAL",
]);

/** Permissive but closed: a local part, an @, and a dotted domain. */
const EMAIL = /^[^\s@,;<>"]{1,64}@[^\s@.,;<>"]{1,63}(?:\.[^\s@.,;<>"]{1,63})+$/;

/** Ids the client assigns to its own drafts. Namespaced so they cannot shadow a sample. */
const CUSTOM_ID = /^custom-[A-Za-z0-9]{1,24}$/;

/**
 * Control characters become spaces before anything else happens. They have no
 * business in a header value, and a newline inside one is the shape of every
 * header-injection bug ever written. Nothing here builds a real message, but a
 * sanitiser that is only safe because of what the code happens not to do yet
 * is not a sanitiser.
 */
/**
 * Control characters become spaces before anything else happens. They have no
 * business in a header value, and a newline inside one is the shape of every
 * header-injection bug ever written. Nothing here builds a real message, but a
 * sanitiser that is only safe because of what the surrounding code happens not
 * to do yet is not a sanitiser.
 */
const str = (v: unknown, max: number): string =>
  typeof v === "string"
    ? v.replace(/[\x00-\x1f\x7f]/g, " ").trim().slice(0, max)
    : "";

const bool = (v: unknown): boolean => v === true;

const num = (v: unknown, min: number, max: number, fallback: number): number => {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
};

/**
 * Validates visitor-written messages into the same shape the catalogue uses.
 *
 * Note what is absent: a body. The client does not send one and this function
 * could not accept one — which is the whole point of letting people write
 * their own test mail. They can put a password in the body on /try.html, watch
 * it get redacted, and confirm in their network tab that it was never in the
 * request to begin with.
 *
 * Anything malformed is dropped rather than rejected. A visitor experimenting
 * with the form should get a result, not a validation essay; the fields that
 * survive are shown back to them in the trace, so a dropped one is visible.
 */
export function parseCustom(input: unknown, seen: Set<string>): InboxMessage[] {
  if (!Array.isArray(input)) return [];
  const out: InboxMessage[] = [];

  for (const raw of input.slice(0, CUSTOM_LIMITS.maxCustom)) {
    if (typeof raw !== "object" || raw === null) continue;
    const m = raw as Record<string, unknown>;

    const id = str(m.id, 40);
    if (!CUSTOM_ID.test(id) || seen.has(id)) continue;

    const senderKey = str(m.senderKey, CUSTOM_LIMITS.maxSenderKey).toLowerCase();
    if (!EMAIL.test(senderKey)) continue;

    const labels = Array.isArray(m.labels)
      ? [...new Set(m.labels.filter((l): l is string => typeof l === "string" && SETTABLE_LABELS.has(l)))]
          .slice(0, CUSTOM_LIMITS.maxLabels)
      : [];

    seen.add(id);
    out.push({
      id,
      senderKey,
      senderName: str(m.senderName, CUSTOM_LIMITS.maxName) || senderKey,
      subject: str(m.subject, CUSTOM_LIMITS.maxSubject),
      ageDays: num(m.ageDays, 0, CUSTOM_LIMITS.maxAgeDays, 30),
      sizeKb: num(m.sizeKb, 1, CUSTOM_LIMITS.maxSizeKb, 50),
      labels,
      unread: bool(m.unread),
      hasUnsubscribe: bool(m.hasUnsubscribe),
      starred: bool(m.starred),
      hasAttachment: bool(m.hasAttachment),
      important: bool(m.important),
      youRepliedInThread: bool(m.youRepliedInThread),
      custom: true,
    });
  }
  return out;
}

/**
 * Resolves ids to messages, dropping anything unrecognised.
 *
 * The cap is the endpoint's whole abuse story: it is unauthenticated, so the
 * only thing standing between it and a CPU-burning payload is that the work is
 * bounded by a catalogue the caller cannot add to. Duplicate ids collapse.
 */
export function resolve(ids: unknown, seen = new Set<string>()): SandboxMessage[] {
  if (!Array.isArray(ids)) return [];
  const out: SandboxMessage[] = [];
  for (const id of ids.slice(0, SANDBOX_INBOX.length)) {
    if (typeof id !== "string" || seen.has(id)) continue;
    const msg = BY_ID.get(id);
    if (!msg) continue;
    seen.add(id);
    out.push(msg);
  }
  return out;
}

/**
 * The full inbox for one request: catalogue picks plus whatever the visitor
 * wrote themselves, de-duplicated across both and capped as a whole.
 *
 * The shared `seen` set is what stops a crafted request from pairing a sample
 * id with a custom message claiming the same id — two rows for one message
 * would double its weight in every per-sender count the classifier reads.
 */
export function buildInbox(ids: unknown, custom: unknown): InboxMessage[] {
  const seen = new Set<string>();
  const picked: InboxMessage[] = resolve(ids, seen);
  return [...picked, ...parseCustom(custom, seen)].slice(0, CUSTOM_LIMITS.maxTotal);
}
