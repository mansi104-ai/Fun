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
