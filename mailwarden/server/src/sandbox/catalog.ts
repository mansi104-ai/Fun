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

export interface SandboxMessage {
  /** Stable id. The client sends these back and nothing else. */
  id: string;
  senderKey: string;
  senderName: string;
  /** Rendered in the picker, hashed and discarded on the way in. */
  subject: string;
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
 * Resolves ids to messages, dropping anything unrecognised.
 *
 * The cap is the endpoint's whole abuse story: it is unauthenticated, so the
 * only thing standing between it and a CPU-burning payload is that the work is
 * bounded by a catalogue the caller cannot add to. Duplicate ids collapse.
 */
export function resolve(ids: unknown): SandboxMessage[] {
  if (!Array.isArray(ids)) return [];
  const seen = new Set<string>();
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
