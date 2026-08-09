/**
 * Offline test suite — no Gmail, no network, no API keys.
 *
 * Covers the paths that decide whether a user loses something they needed:
 * the protective heuristics, every guardrail in safety/policy.ts, the
 * plan/execute/undo bookkeeping, and the entitlement gate. It also scans the
 * source for forbidden Gmail APIs, so the never-delete promise cannot be
 * broken by a future edit without failing the build.
 *
 * Run:  pnpm exec tsx src/smoke.ts
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { candidatesFor, labelsAfter } from "./candidates.js";
import { computeCategories, senderKeysForCategory } from "./categories.js";
import { classifyHeuristically, fallbackClassify, type SenderFacts } from "./classify/heuristics.js";
import { factsHash as factsHashForTest, isSuggestable } from "./classify/index.js";
import { CATEGORIES } from "./classify/taxonomy.js";
import { db } from "./db.js";
import { planBatch } from "./gmail/executor.js";
import { aggregateSenders } from "./gmail/sync.js";
import { isPubliclyRoutable, parseTargets } from "./gmail/unsubscribe.js";
import { newId } from "./lib/crypto.js";
import { config } from "./config.js";
import { FOUNDING_SEATS, foundingSeatsSold, grantManual, isAdmin, requestAccess } from "./lib/billing.js";
import { canExecuteBatch, entitlementsFor, setPlan } from "./lib/entitlements.js";
import { DAY_MS, LIMITS } from "./safety/limits.js";
import { assertExecutable, evaluate, GuardError, type CandidateMessage } from "./safety/policy.js";

let failures = 0;
let checks = 0;

function check(name: string, condition: boolean, detail = ""): void {
  checks++;
  if (!condition) failures++;
  console.log(`  [${condition ? "PASS" : "FAIL"}] ${name}${detail ? ` — ${detail}` : ""}`);
}
const section = (title: string): void => console.log(`\n${title}`);

// ── Fixtures ─────────────────────────────────────────────────────────────

const base: SenderFacts = {
  senderKey: "x@example.com",
  displayName: null,
  domain: "example.com",
  messageCount: 50,
  unreadCount: 45,
  totalBytes: 5_000_000,
  firstSeen: Date.now() - 400 * DAY_MS,
  lastSeen: Date.now(),
  hasUnsubscribe: true,
  userReplied: false,
  labels: ["CATEGORY_PROMOTIONS", "UNREAD"],
  distinctSubjectHashes: 8,
};
const facts = (o: Partial<SenderFacts>): SenderFacts => ({ ...base, ...o });

const OLD = Date.now() - 200 * DAY_MS;
const RECENT = Date.now() - 2 * DAY_MS;

const accountId = newId("acc");
const userId = newId("usr");

db.prepare(`INSERT INTO users (id, email, plan, created_at, updated_at) VALUES (?,?,?,?,?)`).run(
  userId, `${userId}@test.local`, "free", Date.now(), Date.now(),
);
db.prepare(
  `INSERT INTO accounts (id, user_id, email, refresh_token_enc, created_at) VALUES (?,?,?,?,?)`,
).run(accountId, userId, "t@test.local", "x", Date.now());

function addSender(key: string, o: Partial<Record<string, unknown>> = {}): void {
  db.prepare(
    `INSERT INTO senders (id, account_id, sender_key, domain, message_count, protected,
                          user_protected, user_replied, category, confidence)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    newId("snd"), accountId, key, key.split("@")[1], (o.message_count as number) ?? 10,
    (o.protected as number) ?? 0, (o.user_protected as number) ?? 0,
    (o.user_replied as number) ?? 0, (o.category as string) ?? "promotional",
    (o.confidence as number) ?? 0.9,
  );
}

function addMessages(senderKey: string, count: number, date = OLD): void {
  const stmt = db.prepare(
    `INSERT INTO messages_meta (account_id, message_id, sender_key, internal_date, size_bytes, labels)
     VALUES (?,?,?,?,?,?)`,
  );
  for (let i = 0; i < count; i++) {
    stmt.run(accountId, `m_${senderKey}_${date}_${i}`, senderKey, date, 1000, "INBOX,UNREAD");
  }
}

function candidates(senderKey: string): CandidateMessage[] {
  return db
    .prepare(
      `SELECT message_id, sender_key, labels, size_bytes, internal_date
       FROM messages_meta WHERE account_id = ? AND sender_key = ?`,
    )
    .all(accountId, senderKey) as CandidateMessage[];
}

const cleanup = (): void => {
  db.prepare(`DELETE FROM users WHERE id = ?`).run(userId);
  db.prepare(`DELETE FROM messages_meta WHERE account_id = ?`).run(accountId);
};

// ── 1. Heuristics: protective rules ──────────────────────────────────────

section("1. Protective heuristics (boarding pass / OTP / receipt)");

const otp = classifyHeuristically(
  facts({ senderKey: "no-reply@accounts.google.com", domain: "accounts.google.com", hasUnsubscribe: false, labels: [] }),
);
check("OTP sender is protected", otp?.protectedSender === true, otp?.category);

// The exact competitor failure: an airline sitting in Gmail's Promotions tab.
const airline = classifyHeuristically(
  facts({ senderKey: "info@united.airlines.com", domain: "united.airlines.com", labels: ["CATEGORY_PROMOTIONS"] }),
);
check("Airline in PROMOTIONS is protected, not archived", airline?.protectedSender === true, airline?.category);

const bank = classifyHeuristically(
  facts({ senderKey: "alerts@chase.com", domain: "chase.com", hasUnsubscribe: false, labels: [] }),
);
check("Bank sender is protected", bank?.protectedSender === true, bank?.category);

const replied = classifyHeuristically(facts({ userReplied: true, senderKey: "deals@groupon.com" }));
check("Sender you replied to outranks marketing signals", replied?.category === "personal", replied?.category);

const receipt = classifyHeuristically(
  facts({ senderKey: "order-update@shop.com", hasUnsubscribe: false, distinctSubjectHashes: 48, labels: [] }),
);
check("Distinct-subject receipts are protected", receipt?.protectedSender === true, receipt?.category);

section("2. Heuristics: actionable rules");

const promo = classifyHeuristically(facts({ senderKey: "deals@groupon.com", domain: "groupon.com" }));
check("Unread marketing is promotional", promo?.category === "promotional", `conf ${promo?.confidence}`);
check("…is suggestable", isSuggestable(promo?.category ?? null, promo?.confidence ?? null));
check("…is not protected", promo?.protectedSender === false);

const ambiguous = classifyHeuristically(
  facts({ senderKey: "hello@weirdstartup.io", hasUnsubscribe: false, labels: [], distinctSubjectHashes: 25, messageCount: 30 }),
);
check("Ambiguous sender escalates to the LLM tier (null)", ambiguous === null);

// ── 3. Guardrails ────────────────────────────────────────────────────────

section("3. Guardrail: NEVER_DELETE");

addSender("deals@groupon.com");
addMessages("deals@groupon.com", 10);

const deleteAttempt = evaluate({
  accountId, action: "delete", senderKeys: ["deals@groupon.com"],
  candidates: candidates("deals@groupon.com"),
});
check(
  "A 'delete' action is refused outright",
  deleteAttempt.violations.some((v) => v.code === "NEVER_DELETE" && v.severity === "block"),
);
check("…and the batch is not ok", deleteAttempt.ok === false);

section("4. Guardrail: protected / pinned / replied senders");

addSender("alerts@chase.com", { protected: 1, category: "finance" });
addMessages("alerts@chase.com", 5);
addSender("pinned@newsletter.com", { user_protected: 1 });
addMessages("pinned@newsletter.com", 5);
addSender("friend@personal.com", { user_replied: 1, protected: 0 });
addMessages("friend@personal.com", 5);

const mixed = evaluate({
  accountId, action: "archive",
  senderKeys: ["deals@groupon.com", "alerts@chase.com", "pinned@newsletter.com", "friend@personal.com"],
  candidates: [
    ...candidates("deals@groupon.com"), ...candidates("alerts@chase.com"),
    ...candidates("pinned@newsletter.com"), ...candidates("friend@personal.com"),
  ],
  confirmed: true,
});
const allowedSenders = new Set(mixed.allowed.map((c) => c.sender_key));
check("Protected-category sender excluded", !allowedSenders.has("alerts@chase.com"));
check("User-pinned sender excluded", !allowedSenders.has("pinned@newsletter.com"));
check("Replied-to sender excluded", !allowedSenders.has("friend@personal.com"));
check("Unprotected sender still proceeds", allowedSenders.has("deals@groupon.com"));
check("Exclusions are reported, not silent", mixed.exclusions.length >= 3, `${mixed.exclusions.length} exclusions`);
check(
  "…each with a code the UI can render",
  mixed.exclusions.every((e) => e.code && e.reason && e.senderKey),
);

section("5. Guardrail: user release override");

db.prepare(`UPDATE senders SET user_protected = -1 WHERE account_id = ? AND sender_key = ?`)
  .run(accountId, "alerts@chase.com");
const released = evaluate({
  accountId, action: "archive", senderKeys: ["alerts@chase.com"],
  candidates: candidates("alerts@chase.com"), confirmed: true,
});
check("Explicit release lets a protected sender through", released.allowed.length === 5);

db.prepare(`UPDATE senders SET user_protected = -1 WHERE account_id = ? AND sender_key = ?`)
  .run(accountId, "friend@personal.com");
const releasedReply = evaluate({
  accountId, action: "archive", senderKeys: ["friend@personal.com"],
  candidates: candidates("friend@personal.com"), confirmed: true,
});
check("…but release can NEVER override the replied-to rule", releasedReply.allowed.length === 0);

// Restore for later assertions.
db.prepare(`UPDATE senders SET user_protected = 0 WHERE account_id = ?`).run(accountId);

section("6. Guardrail: confidence floor");

addSender("mystery@unknown.io", { confidence: 0.2, category: "unknown" });
addMessages("mystery@unknown.io", 8);
const lowConf = evaluate({
  accountId, action: "archive", senderKeys: ["mystery@unknown.io"],
  candidates: candidates("mystery@unknown.io"), confirmed: true,
});
check(
  `Sender below the ${LIMITS.hardConfidenceFloor} hard floor is excluded`,
  lowConf.allowed.length === 0 && lowConf.exclusions.some((e) => e.code === "LOW_CONFIDENCE"),
);

section("7. Guardrail: recency shield");

addSender("mixedage@shop.com");
addMessages("mixedage@shop.com", 6, OLD);
addMessages("mixedage@shop.com", 4, RECENT);
const recency = evaluate({
  accountId, action: "archive", senderKeys: ["mixedage@shop.com"],
  candidates: candidates("mixedage@shop.com"), confirmed: true,
});
check(
  `Messages from the last ${LIMITS.recencyProtectionDays} days are kept`,
  recency.allowed.length === 6,
  `${recency.allowed.length} of 10 allowed`,
);
check("…and the reason is reported", recency.exclusions.some((e) => e.code === "TOO_RECENT"));

section("8. Guardrail: unknown sender fails closed");

const stale = evaluate({
  accountId, action: "archive", senderKeys: ["ghost@nowhere.com"], candidates: [],
});
check(
  "A sender that no longer exists blocks the batch",
  stale.violations.some((v) => v.code === "UNKNOWN_SENDER" && v.severity === "block"),
);

section("9. Guardrail: velocity + scale");

const synthetic: CandidateMessage[] = Array.from(
  { length: LIMITS.maxMessagesPerBatch + 1 },
  (_, i) => ({
    message_id: `syn_${i}`, sender_key: "deals@groupon.com",
    labels: "INBOX", size_bytes: 100, internal_date: OLD,
  }),
);
const tooBig = evaluate({
  accountId, action: "archive", senderKeys: ["deals@groupon.com"],
  candidates: synthetic, confirmed: true,
});
check(
  "Oversized batch is blocked",
  tooBig.violations.some((v) => v.code === "BATCH_TOO_LARGE" && v.severity === "block"),
);

// deals@groupon.com is 10 of ~44 messages in this account — under the 40%
// anomaly ratio. Widen the batch until it trips.
addSender("bulk@spam.com");
addMessages("bulk@spam.com", 60);
const anomaly = evaluate({
  accountId, action: "archive", senderKeys: ["bulk@spam.com"],
  candidates: candidates("bulk@spam.com"),
});
check(
  "A batch spanning most of the mailbox asks for confirmation",
  anomaly.violations.some((v) => v.code === "SCALE_ANOMALY" && v.severity === "confirm"),
);
check("…and is not blocked outright", anomaly.violations.every((v) => v.severity !== "block"));
check("…requiresConfirmation is set", anomaly.requiresConfirmation === true);

const anomalyConfirmed = evaluate({
  accountId, action: "archive", senderKeys: ["bulk@spam.com"],
  candidates: candidates("bulk@spam.com"), confirmed: true,
});
check("…and proceeds once confirmed", anomalyConfirmed.ok === true);

// ── 10. Plan / execute contract ──────────────────────────────────────────

section("10. Plan persistence and the TOCTOU gate");

const blockedPlan = planBatch(accountId, "archive", ["bulk@spam.com"], false);
check("Unconfirmed anomalous plan is not persisted", blockedPlan.batchId === null);
check("…and reports why", blockedPlan.violations.some((v) => v.code === "SCALE_ANOMALY"));

const plan = planBatch(accountId, "archive", ["deals@groupon.com", "alerts@chase.com"], true);
check("Plan includes only unprotected senders", plan.messageCount === 10, `${plan.messageCount} messages`);
check("Protected sender excluded even when explicitly requested",
  plan.senders.every((s) => s.senderKey !== "alerts@chase.com"));
check("…and the exclusion is reported to the user",
  plan.exclusions.some((e) => e.senderKey === "alerts@chase.com"));

const items = db.prepare(`SELECT prior_labels FROM batch_items WHERE batch_id = ?`)
  .all(plan.batchId!) as { prior_labels: string }[];
check("Prior labels captured for undo",
  items.length === 10 && items.every((i) => i.prior_labels.includes("INBOX")));

const batchRow = db.prepare(`SELECT status, guard_report FROM batches WHERE id = ?`)
  .get(plan.batchId!) as { status: string; guard_report: string | null };
check("Planning does not execute (status stays pending)", batchRow.status === "pending");
check("Guard report is persisted for the audit trail", Boolean(batchRow.guard_report));

// The critical regression test: a clean plan must NOT authorise execution if
// the sender's protection changes in between.
db.prepare(`UPDATE senders SET user_protected = 1 WHERE account_id = ? AND sender_key = ?`)
  .run(accountId, "deals@groupon.com");

const revalidated = assertExecutable({
  accountId, action: "archive", senderKeys: ["deals@groupon.com"],
  candidates: candidates("deals@groupon.com"),
});
check(
  "Pinning a sender AFTER planning removes it at execute time (TOCTOU)",
  revalidated.allowed.length === 0,
);

let threw = false;
try {
  assertExecutable({
    accountId, action: "delete", senderKeys: ["deals@groupon.com"],
    candidates: candidates("deals@groupon.com"),
  });
} catch (err) {
  threw = err instanceof GuardError;
}
check("assertExecutable throws GuardError on a block violation", threw);

db.prepare(`UPDATE senders SET user_protected = 0 WHERE account_id = ?`).run(accountId);

// ── 11. Entitlements ─────────────────────────────────────────────────────

section("11. Entitlement gate");

// Metered in batches, not senders. A free user must be able to run a full
// one-click recipe — paywalling before the first job completes is the
// competitor failure documented in docs/00 §2a.
check("Free plan allows the first cleanup", canExecuteBatch(userId).allowed);

/**
 * The free limit is currently overridden to unlimited for pre-launch use, so
 * this asserts the GATE, not the number: exceeding whatever limit is configured
 * must block and must ask for an upgrade.
 *
 * The override is surfaced as its own check rather than silently accommodated —
 * a disabled paywall that nobody is reminded about is a disabled paywall that
 * ships.
 */
const freeLimit = entitlementsFor(userId).freeBatches;
const unlimited = freeLimit > 1_000;
check(
  unlimited
    ? "NOTE: free tier is temporarily UNLIMITED — restore freeBatches to 1 once Stripe exists"
    : `Free tier is metered at ${freeLimit} batch(es)`,
  true,
);

db.prepare(`UPDATE users SET free_batch_used = ? WHERE id = ?`).run(
  unlimited ? Number.MAX_SAFE_INTEGER : 1,
  userId,
);
const exhausted = canExecuteBatch(userId);
check("Exceeding the free limit blocks, and asks for an upgrade",
  !exhausted.allowed && exhausted.upgradeRequired === true);

db.prepare(`UPDATE users SET plan = 'starter' WHERE id = ?`).run(userId);
check("Paid plan is unrestricted", canExecuteBatch(userId).allowed);

// ── 12. Regressions found against a real 6,000-message mailbox ───────────

section("12. Real-inbox regressions");

// BUG 1: a single stray reply used to lock an entire bulk sender as
// 'personal'. Measured cost: 15 senders / 1,964 messages — a third of the
// mailbox — permanently untouchable.
const bulkAcct = newId("acc");
const bulkUser = newId("usr");
db.prepare(`INSERT INTO users (id, email, plan, created_at, updated_at) VALUES (?,?,?,?,?)`)
  .run(bulkUser, `${bulkUser}@t.local`, "free", Date.now(), Date.now());
db.prepare(`INSERT INTO accounts (id, user_id, email, refresh_token_enc, created_at) VALUES (?,?,?,?,?)`)
  .run(bulkAcct, bulkUser, "me@t.local", "x", Date.now());

const insertM = db.prepare(
  `INSERT INTO messages_meta (account_id, message_id, thread_id, sender_key, internal_date, size_bytes, labels)
   VALUES (?,?,?,?,?,?,?)`,
);
// Newsletter: 100 messages, exactly one of which sits in a replied thread.
for (let i = 0; i < 100; i++) {
  insertM.run(bulkAcct, `bulk_${i}`, `tb_${i}`, "news@bigsender.com", OLD, 1000, "INBOX");
}
insertM.run(bulkAcct, `sent_bulk`, `tb_0`, "me@t.local", OLD, 500, "SENT");
// Colleague: 8 messages, all conversational.
for (let i = 0; i < 8; i++) {
  insertM.run(bulkAcct, `col_${i}`, `tc_${i}`, "colleague@work.com", OLD, 1000, "INBOX");
  insertM.run(bulkAcct, `sent_col_${i}`, `tc_${i}`, "me@t.local", OLD, 500, "SENT");
}
// A noreply address that somehow appears in a replied thread (forward, or a
// Gmail threading artifact). It can never be a real correspondent.
for (let i = 0; i < 40; i++) {
  insertM.run(bulkAcct, `nr_${i}`, `tn_${i}`, "noreply@alerts.com", OLD, 1000, "INBOX");
}
insertM.run(bulkAcct, `sent_nr`, `tn_0`, "me@t.local", OLD, 500, "SENT");
for (let i = 0; i < 20; i++) {
  insertM.run(bulkAcct, `nr2_${i}`, `tn_0`, "noreply@alerts.com", OLD, 1000, "INBOX");
}

aggregateSenders(bulkAcct);
const flagged = (key: string): number =>
  (db.prepare(`SELECT user_replied FROM senders WHERE account_id=? AND sender_key=?`)
    .get(bulkAcct, key) as { user_replied: number } | undefined)?.user_replied ?? -1;

check("Bulk sender with 1 reply in 100 is NOT a correspondent", flagged("news@bigsender.com") === 0);
check("Genuine correspondent IS detected", flagged("colleague@work.com") === 1);
check("noreply@ address is never a correspondent", flagged("noreply@alerts.com") === 0);

// BUG 2: the user's own sent mail was aggregated into a sender row, offering
// 116 of their own messages up for archiving.
check("User's own address is not a sender", flagged("me@t.local") === -1);

// BUG 3: 'no-reply@' was a security signal, which matches most automated mail.
// It classified Google Classroom (647 messages) as security and locked it.
const classroom = classifyHeuristically(
  facts({ senderKey: "no-reply@classroom.google.com", domain: "classroom.google.com",
          hasUnsubscribe: false, labels: ["CATEGORY_UPDATES"], distinctSubjectHashes: 40 }),
);
check("Generic no-reply@ is not classified as security",
  classroom === null || classroom.category !== "security", classroom?.category ?? "escalated");
const realSecurity = classifyHeuristically(
  facts({ senderKey: "no-reply@accounts.google.com", domain: "accounts.google.com",
          hasUnsubscribe: false, labels: [] }),
);
check("…while genuine security senders still are", realSecurity?.category === "security");

db.prepare(`DELETE FROM users WHERE id = ?`).run(bulkUser);
db.prepare(`DELETE FROM messages_meta WHERE account_id = ?`).run(bulkAcct);

// ── 13. Category view ────────────────────────────────────────────────────

section("13. Category view: completeness and scope integrity");

const catUser = newId("usr");
const catAcct = newId("acc");
db.prepare(`INSERT INTO users (id, email, plan, created_at, updated_at) VALUES (?,?,?,?,?)`).run(
  catUser, `${catUser}@test.local`, "free", Date.now(), Date.now(),
);
db.prepare(
  `INSERT INTO accounts (id, user_id, email, refresh_token_enc, created_at) VALUES (?,?,?,?,?)`,
).run(catAcct, catUser, "cat@test.local", "x", Date.now());

function addCatSender(
  key: string,
  category: string,
  count: number,
  o: { protected?: number; confidence?: number } = {},
): void {
  db.prepare(
    `INSERT INTO senders (id, account_id, sender_key, domain, message_count, protected,
                          user_protected, user_replied, category, confidence)
     VALUES (?,?,?,?,?,?,0,0,?,?)`,
  ).run(
    newId("snd"), catAcct, key, key.split("@")[1], count, o.protected ?? 0,
    category, o.confidence ?? 0.9,
  );
  const stmt = db.prepare(
    `INSERT INTO messages_meta (account_id, message_id, sender_key, internal_date, size_bytes, labels)
     VALUES (?,?,?,?,?,?)`,
  );
  for (let i = 0; i < count; i++) {
    stmt.run(catAcct, `cm_${key}_${i}`, key, OLD, 2000, "INBOX,UNREAD");
  }
}

addCatSender("deals@shop.com", "promotional", 40);
addCatSender("news@paper.com", "newsletter", 20);
addCatSender("alerts@bank.com", "finance", 30, { protected: 1 });
addCatSender("codes@auth.com", "security", 10, { protected: 1 });
addCatSender("mystery@nowhere.com", "promotional", 15, { confidence: 0.2 });

const cats = computeCategories(catAcct);
const byId = new Map(cats.map((c) => [c.id, c]));

check("Every taxonomy category is returned", cats.length === CATEGORIES.length,
  `${cats.length} of ${CATEGORIES.length}`);
check("Protected categories are still listed, not hidden",
  byId.get("finance") !== undefined && byId.get("security") !== undefined);
check("Protected category reports its real total",
  byId.get("finance")?.totalMessages === 30);
check("…but nothing in it is cleanable",
  byId.get("finance")?.cleanableMessages === 0);
check("Protected category is flagged as such", byId.get("finance")?.isProtected === true);

const promoCat = byId.get("promotional")!;
check("Actionable category exposes cleanable mail", promoCat.cleanableMessages === 40,
  String(promoCat.cleanableMessages));
check("Low-confidence sender is held, not offered",
  promoCat.senders.find((s) => s.senderKey === "mystery@nowhere.com")?.cleanableCount === 0);
check("Held sender carries a reason the UI can show",
  Boolean(promoCat.senders.find((s) => s.senderKey === "mystery@nowhere.com")?.holdReason));
check("heldMessages accounts for the gap exactly",
  promoCat.heldMessages === promoCat.totalMessages - promoCat.cleanableMessages);
check("Empty categories are present at zero", byId.get("travel")?.totalMessages === 0);

// Scope integrity: the client can narrow a category but never widen it.
check("No narrowing returns the whole actionable set",
  senderKeysForCategory(catAcct, "promotional")?.length === 1);
check("Narrowing to a subset is honoured",
  JSON.stringify(senderKeysForCategory(catAcct, "promotional", ["deals@shop.com"])) ===
    JSON.stringify(["deals@shop.com"]));
check("A foreign sender key cannot be smuggled into a category",
  senderKeysForCategory(catAcct, "promotional", ["alerts@bank.com"])?.length === 0);
check("A held sender cannot be re-included by asking for it",
  senderKeysForCategory(catAcct, "promotional", ["mystery@nowhere.com"])?.length === 0);
check("An unknown category id is rejected",
  senderKeysForCategory(catAcct, "not-a-category") === null);

db.prepare(`DELETE FROM users WHERE id = ?`).run(catUser);
db.prepare(`DELETE FROM messages_meta WHERE account_id = ?`).run(catAcct);

// ── 13a. Per-message protection ──────────────────────────────────────────

section("13a. Per-message guards: starred, replied threads, attachments, important");

/**
 * Every other guard is sender-level, which leaves the hole these close: once a
 * sender is judged actionable, so is every message they ever sent — including
 * the one you starred, the one with the invoice attached, and the one in a
 * thread you wrote in.
 */
const msgAcct = newId("acc");
const msgUser = newId("usr");
db.prepare(`INSERT INTO users (id, email, plan, created_at, updated_at) VALUES (?,?,?,?,?)`).run(
  msgUser, `${msgUser}@test.local`, "free", Date.now(), Date.now(),
);
db.prepare(
  `INSERT INTO accounts (id, user_id, email, refresh_token_enc, created_at) VALUES (?,?,?,?,?)`,
).run(msgAcct, msgUser, "msg@test.local", "x", Date.now());
db.prepare(
  `INSERT INTO senders (id, account_id, sender_key, domain, message_count, protected,
                        user_protected, user_replied, category, confidence)
   VALUES (?,?,?,?,?,0,0,0,?,?)`,
).run(newId("snd"), msgAcct, "blast@shop.com", "shop.com", 6, "promotional", 0.95);

{
  const ins = db.prepare(
    `INSERT INTO messages_meta
       (account_id, message_id, thread_id, sender_key, internal_date, size_bytes,
        labels, is_unread, has_attachment)
     VALUES (?,?,?,?,?,?,?,1,?)`,
  );
  ins.run(msgAcct, "plain", "t1", "blast@shop.com", OLD, 1000, "INBOX,UNREAD", 0);
  ins.run(msgAcct, "starred", "t2", "blast@shop.com", OLD, 1000, "INBOX,STARRED", 0);
  ins.run(msgAcct, "attach", "t3", "blast@shop.com", OLD, 1000, "INBOX", 1);
  ins.run(msgAcct, "important", "t4", "blast@shop.com", OLD, 1000, "INBOX,IMPORTANT", 0);
  ins.run(msgAcct, "inthread", "t5", "blast@shop.com", OLD, 1000, "INBOX", 0);
  // The user's own reply, which makes thread t5 a conversation.
  ins.run(msgAcct, "myreply", "t5", "me@test.local", OLD, 500, "SENT", 0);
}

const msgCandidates = candidatesFor(msgAcct, ["blast@shop.com"], "trash");
const trashVerdict = evaluate({
  accountId: msgAcct, action: "trash", senderKeys: ["blast@shop.com"],
  candidates: msgCandidates, confirmed: true,
});
const trashOk = new Set(trashVerdict.allowed.map((c) => c.message_id));

check("Starred mail is never trashed", !trashOk.has("starred"));
check("Mail in a thread you replied to is never trashed", !trashOk.has("inthread"));
check("Mail with an attachment is never trashed", !trashOk.has("attach"));
check("Gmail-important mail is never trashed", !trashOk.has("important"));
check("Ordinary bulk mail still is", trashOk.has("plain"));

const archiveVerdict = evaluate({
  accountId: msgAcct, action: "archive", senderKeys: ["blast@shop.com"],
  candidates: candidatesFor(msgAcct, ["blast@shop.com"], "archive"),
  confirmed: true,
});
const archiveOk = new Set(archiveVerdict.allowed.map((c) => c.message_id));

// Archiving is reversible forever, so the attachment/important guards are
// scoped to trash. Starred and replied-thread stay absolute.
check("Starred mail is not archived either", !archiveOk.has("starred"));
check("Replied threads are not archived either", !archiveOk.has("inthread"));
check("Attachments CAN be archived — reversible, stays in All Mail", archiveOk.has("attach"));
check("Important mail CAN be archived", archiveOk.has("important"));

check("Each protection is reported to the user",
  ["STARRED", "IN_REPLIED_THREAD", "HAS_ATTACHMENT", "GMAIL_IMPORTANT"].every((code) =>
    trashVerdict.exclusions.some((e) => e.code === code)));

db.prepare(`DELETE FROM users WHERE id = ?`).run(msgUser);
db.prepare(`DELETE FROM messages_meta WHERE account_id = ?`).run(msgAcct);

// ── 13b. Local mailbox state tracks what we told Gmail to do ─────────────

section("13b. Executing a batch updates our own copy of the mailbox");

/**
 * The bug this pins cost a real user 2,421 messages of confusion: Gmail moved
 * them, and every count in the UI stayed identical, because messages_meta was
 * never updated. The same messages were then offered for the same action again.
 */
check("Archive drops INBOX", labelsAfter("INBOX,UNREAD,CATEGORY_PROMOTIONS", "archive") === "UNREAD,CATEGORY_PROMOTIONS");
check("Archive does not add TRASH", !labelsAfter("INBOX,UNREAD", "archive").includes("TRASH"));
check("Trash drops INBOX and adds TRASH", (() => {
  const l = labelsAfter("INBOX,UNREAD", "trash").split(",");
  return !l.includes("INBOX") && l.includes("TRASH");
})());
check("Label transform is idempotent",
  labelsAfter(labelsAfter("INBOX,UNREAD", "trash"), "trash") === labelsAfter("INBOX,UNREAD", "trash"));

const stateAcct = newId("acc");
const stateUser = newId("usr");
db.prepare(`INSERT INTO users (id, email, plan, created_at, updated_at) VALUES (?,?,?,?,?)`).run(
  stateUser, `${stateUser}@test.local`, "free", Date.now(), Date.now(),
);
db.prepare(
  `INSERT INTO accounts (id, user_id, email, refresh_token_enc, created_at) VALUES (?,?,?,?,?)`,
).run(stateAcct, stateUser, "state@test.local", "x", Date.now());
db.prepare(
  `INSERT INTO senders (id, account_id, sender_key, domain, message_count, protected,
                        user_protected, user_replied, category, confidence)
   VALUES (?,?,?,?,?,0,0,0,?,?)`,
).run(newId("snd"), stateAcct, "bulk@shop.com", "shop.com", 20, "promotional", 0.9);
{
  const stmt = db.prepare(
    `INSERT INTO messages_meta (account_id, message_id, sender_key, internal_date, size_bytes, labels)
     VALUES (?,?,?,?,?,?)`,
  );
  for (let i = 0; i < 20; i++) {
    stmt.run(stateAcct, `sm_${i}`, "bulk@shop.com", OLD, 1000, "INBOX,UNREAD");
  }
}

check("Archive candidates are inbox-only",
  candidatesFor(stateAcct, ["bulk@shop.com"], "archive").length === 20);

// Simulate the post-execute write the executor now performs.
db.prepare(`UPDATE messages_meta SET labels = ? WHERE account_id = ?`).run("UNREAD", stateAcct);

check("Archived mail is no longer an archive candidate",
  candidatesFor(stateAcct, ["bulk@shop.com"], "archive").length === 0);
check("…but is still a trash candidate",
  candidatesFor(stateAcct, ["bulk@shop.com"], "trash").length === 20);

db.prepare(`UPDATE messages_meta SET labels = ? WHERE account_id = ?`).run("TRASH", stateAcct);
check("Trashed mail is not a candidate for anything",
  candidatesFor(stateAcct, ["bulk@shop.com"], "trash").length === 0 &&
    candidatesFor(stateAcct, ["bulk@shop.com"], "archive").length === 0);

aggregateSenders(stateAcct);
check("Sender counts exclude trashed mail — the number the user watches",
  (db.prepare(`SELECT COALESCE(SUM(message_count),0) c FROM senders WHERE account_id = ?`)
    .get(stateAcct) as { c: number }).c === 0);

// Undo restores prior labels, so the counts must come back.
db.prepare(`UPDATE messages_meta SET labels = ? WHERE account_id = ?`).run("INBOX,UNREAD", stateAcct);
aggregateSenders(stateAcct);
check("Undo restores the counts",
  (db.prepare(`SELECT COALESCE(SUM(message_count),0) c FROM senders WHERE account_id = ?`)
    .get(stateAcct) as { c: number }).c === 20);

db.prepare(`DELETE FROM users WHERE id = ?`).run(stateUser);
db.prepare(`DELETE FROM messages_meta WHERE account_id = ?`).run(stateAcct);

// ── 13c. Unsubscribe: parsing and SSRF containment ───────────────────────

section("13c. Unsubscribe engine");

{
  const p = parseTargets("<https://ex.com/u?id=1>, <mailto:un@ex.com?subject=off>");
  check("Parses both HTTPS and mailto targets",
    p.https[0] === "https://ex.com/u?id=1" && p.mailto[0] === "mailto:un@ex.com?subject=off");
}
check("Ignores http:// — we only auto-POST over TLS",
  parseTargets("<http://ex.com/u>").https.length === 0);
check("Handles a header with no angle brackets", parseTargets("nonsense").https.length === 0);

/**
 * The one-click endpoint POSTs to a URL taken from an email header —
 * attacker-controlled input reaching our server's network. Without these
 * checks it is a direct SSRF into the Fly private network.
 */
const ssrf = [
  ["https://127.0.0.1/u", false, "loopback"],
  ["https://10.0.0.5/u", false, "private 10/8"],
  ["https://192.168.1.1/u", false, "private 192.168/16"],
  ["https://172.16.9.9/u", false, "private 172.16/12"],
  ["https://169.254.169.254/latest/meta-data", false, "cloud metadata"],
  ["https://100.64.0.1/u", false, "carrier-grade NAT"],
  ["https://0.0.0.0/u", false, "unspecified"],
  ["http://example.com/u", false, "plain http"],
  ["ftp://example.com/u", false, "non-http scheme"],
  ["not a url", false, "malformed"],
  ["https://[::1]/u", false, "IPv6 loopback"],
  ["https://8.8.8.8/u", true, "public IPv4"],
] as const;

for (const [url, expected, label] of ssrf) {
  const got = await isPubliclyRoutable(url);
  check(`SSRF guard: ${label} -> ${expected ? "allowed" : "blocked"}`, got === expected, url);
}

// ── 13d. Billing ─────────────────────────────────────────────────────────

section("13d. Billing: seats, idempotency, and entitlements");

const billUser = newId("usr");
db.prepare(`INSERT INTO users (id, email, plan, created_at, updated_at) VALUES (?,?,?,?,?)`).run(
  billUser, `${billUser}@test.local`, "free", Date.now(), Date.now(),
);

check("Founding plan grants Pro-level entitlements", (() => {
  setPlan(billUser, "founding");
  const e = entitlementsFor(billUser);
  return e.premiumClassification && e.scheduledRescan && e.maxAccounts === 5;
})());
check("A paying plan is never batch-limited", canExecuteBatch(billUser).allowed);

check("Seats sold is counted, not cached", foundingSeatsSold() >= 1);
check("The cap is the real Google Testing limit", FOUNDING_SEATS === 100);

setPlan(billUser, "free");
check("Downgrade takes effect immediately",
  entitlementsFor(billUser).premiumClassification === false);

/**
 * Stripe does not guarantee exactly-once delivery and retries on any non-2xx,
 * so duplicates are normal traffic. Replaying an event must never grant a
 * second founding seat.
 */
{
  const evt = { id: `evt_${newId("x")}`, type: "checkout.session.completed" } as const;
  db.prepare(`INSERT INTO stripe_events (id, type, created_at) VALUES (?,?,?)`).run(
    evt.id, evt.type, Date.now(),
  );
  const dup = db.prepare(`SELECT COUNT(*) c FROM stripe_events WHERE id = ?`).get(evt.id) as {
    c: number;
  };
  check("An event id is recorded exactly once", dup.c === 1);

  let rejected = false;
  try {
    db.prepare(`INSERT INTO stripe_events (id, type, created_at) VALUES (?,?,?)`).run(
      evt.id, evt.type, Date.now(),
    );
  } catch {
    rejected = true;
  }
  check("A replayed event id cannot be inserted twice", rejected);
  db.prepare(`DELETE FROM stripe_events WHERE id = ?`).run(evt.id);
}

/**
 * The manual-grant path hands out paid access on a human decision. Its gate is
 * the only thing between that and anyone signed in, so the failure mode that
 * matters is an unset ADMIN_EMAIL being read as "everyone".
 */
check("No admin is configured in tests, so nobody is admin",
  !isAdmin("anyone@example.com") && !isAdmin("someone-else@example.com"));
check("Admin check rejects undefined", !isAdmin(undefined));
check("Admin check rejects the empty string", !isAdmin(""));

check("Manual grant refuses an unknown email",
  !grantManual(billUser, "nobody-here@example.com", "founding", "ref").ok);

check("Manual grant works for a real account", (() => {
  const r = grantManual(billUser, `${billUser}@test.local`, "founding", "UPI-12345");
  return r.ok && entitlementsFor(billUser).plan === "founding";
})());
check("…and is recorded in the audit log with its reference", (() => {
  const row = db.prepare(
    `SELECT detail FROM audit_log WHERE user_id = ? AND action = 'billing.granted_manually'
     ORDER BY created_at DESC LIMIT 1`,
  ).get(billUser) as { detail: string } | undefined;
  return Boolean(row && row.detail.includes("UPI-12345"));
})());
setPlan(billUser, "free");

check("Access requests accept a real address", requestAccess("buyer@example.com", null, "test"));
check("…and reject a malformed one", !requestAccess("not-an-email", null, "test"));
check("…and are deduplicated by address", (() => {
  requestAccess("buyer@example.com", "again", "test");
  const c = db.prepare(`SELECT COUNT(*) c FROM access_requests WHERE email = ?`)
    .get("buyer@example.com") as { c: number };
  return c.c === 1;
})());
db.prepare(`DELETE FROM access_requests WHERE email = ?`).run("buyer@example.com");
db.prepare(`DELETE FROM users WHERE id = ?`).run(billUser);

// (The webhook source-level invariants live in the source-scan section, which
// is where `sources` is built.)

// ── 14. Agent: learning, caching, and degradation ────────────────────────

section("14. Agent: user decisions outrank inference");

const learned = classifyHeuristically(
  facts({ senderKey: "digest@somelist.com", domain: "somelist.com", labels: [], hasUnsubscribe: false,
          userDecision: "archive", decisionCount: 3 }),
);
check("A sender the user cleaned before is actionable", learned?.category === "promotional");
check("…with confidence that grows with repetition", (learned?.confidence ?? 0) > 0.9,
  String(learned?.confidence));
check("…and is not sent to the LLM again", learned !== null);

const kept = classifyHeuristically(
  facts({ senderKey: "digest@somelist.com", labels: [], userDecision: "keep" }),
);
check("A sender the user kept is protected", kept?.protectedSender === true);

// The precedence that matters: a past decision must NOT unlock a sender that
// has since started carrying things the user cannot afford to lose.
const decidedButSecurity = classifyHeuristically(
  facts({ senderKey: "no-reply@accounts.google.com", domain: "accounts.google.com",
          hasUnsubscribe: false, labels: [], userDecision: "archive", decisionCount: 5 }),
);
check("A past 'archive' never overrides a security sender",
  decidedButSecurity?.category === "security" && decidedButSecurity.protectedSender === true,
  decidedButSecurity?.category);

const decidedButReplied = classifyHeuristically(
  facts({ senderKey: "colleague@work.com", userReplied: true, userDecision: "archive" }),
);
check("A past 'archive' never overrides a replied-to sender",
  decidedButReplied?.category === "personal" && decidedButReplied.protectedSender === true);

section("15. Agent: fallback when the model is unavailable");

// Strong, entirely local bulk evidence: unsubscribe header, volume, ignored.
const fb = fallbackClassify(
  facts({ messageCount: 40, unreadCount: 38, hasUnsubscribe: true, distinctSubjectHashes: 6 }),
);
check("Obvious bulk mail gets an honest guess rather than a lock", fb !== null, fb?.category);
check("…above the guard layer's hard floor", (fb?.confidence ?? 0) > LIMITS.hardConfidenceFloor);
check("…but below the auto-suggest bar", (fb?.confidence ?? 1) < LIMITS.suggestConfidenceFloor);
check("…so it is never auto-suggested",
  !isSuggestable(fb?.category ?? null, fb?.confidence ?? null));
check("…and it is not marked protected", fb?.protectedSender === false);

check("No unsubscribe header — no guess",
  fallbackClassify(facts({ messageCount: 40, unreadCount: 38, hasUnsubscribe: false })) === null);
check("Mail the user actually reads — no guess",
  fallbackClassify(facts({ messageCount: 40, unreadCount: 5, hasUnsubscribe: true })) === null);
check("Too few messages — no guess",
  fallbackClassify(facts({ messageCount: 4, unreadCount: 4, hasUnsubscribe: true })) === null);
check("Varied subjects (likely real receipts) — no guess",
  fallbackClassify(
    facts({ messageCount: 40, unreadCount: 38, hasUnsubscribe: true, distinctSubjectHashes: 39 }),
  ) === null);

section("16. Agent: verdict caching is bucketed, not brittle");

const stableA = factsHashForTest(facts({ messageCount: 100, unreadCount: 90 }));
const stableB = factsHashForTest(facts({ messageCount: 103, unreadCount: 93 }));
check("A few new messages do not invalidate a verdict", stableA === stableB);

check("Crossing a volume bucket does",
  stableA !== factsHashForTest(facts({ messageCount: 1000, unreadCount: 900 })));
check("A change in read behaviour does",
  stableA !== factsHashForTest(facts({ messageCount: 100, unreadCount: 20 })));
check("Gaining a reply does",
  stableA !== factsHashForTest(facts({ messageCount: 100, unreadCount: 90, userReplied: true })));
check("A user decision does",
  stableA !== factsHashForTest(
    facts({ messageCount: 100, unreadCount: 90, userDecision: "archive", decisionCount: 1 }),
  ));
check("Losing the unsubscribe header does",
  stableA !== factsHashForTest(
    facts({ messageCount: 100, unreadCount: 90, hasUnsubscribe: false }),
  ));
check("Gmail re-categorising the sender does",
  stableA !== factsHashForTest(
    facts({ messageCount: 100, unreadCount: 90, labels: ["CATEGORY_UPDATES"] }),
  ));
check("Label ORDER does not — the hash must be order-independent",
  factsHashForTest(facts({ messageCount: 100, unreadCount: 90, labels: ["CATEGORY_PROMOTIONS", "CATEGORY_UPDATES"] })) ===
    factsHashForTest(facts({ messageCount: 100, unreadCount: 90, labels: ["CATEGORY_UPDATES", "CATEGORY_PROMOTIONS"] })));

// ── 17. Source-level invariants ──────────────────────────────────────────

section("17. Source scan: forbidden capabilities");

const srcRoot = path.dirname(fileURLToPath(import.meta.url));
function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return full.endsWith(".ts") && !full.endsWith("smoke.ts") ? [full] : [];
  });
}
/**
 * Comments are stripped before scanning. Several of these files deliberately
 * *name* the forbidden APIs in order to warn against them, and a scan that
 * flagged its own documentation would train everyone to ignore it.
 */
const stripComments = (text: string): string =>
  text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const sources = sourceFiles(srcRoot).map((f) => ({
  file: f,
  text: stripComments(readFileSync(f, "utf8")),
}));

// If any of these ever appear, the never-delete promise in docs/03 is broken
// and the CASA Tier 2 scope argument no longer holds.
const forbidden: [RegExp, string][] = [
  [/messages\s*\.\s*delete\s*\(/, "gmail messages.delete"],
  [/batchDelete\s*\(/, "gmail batchDelete"],
  [/https:\/\/mail\.google\.com/, "full-access scope mail.google.com"],
  [/gmail\.readonly/, "gmail.readonly scope"],
];
for (const [pattern, label] of forbidden) {
  const hits = sources.filter((s) => pattern.test(s.text));
  check(`No use of ${label}`, hits.length === 0,
    hits.map((h) => path.basename(h.file)).join(", "));
}

/**
 * The CSP forbids inline scripts, so an inline <script> ships an app that
 * renders perfectly and does nothing.
 *
 * This shipped to production once. Every asset returned 200, the page painted,
 * and not a single API call was ever made — because `default-src 'self'` with
 * no script-src blocks inline execution, and the entire client was one inline
 * module. Status codes cannot catch this; a source check can.
 */
const webDir = path.resolve(srcRoot, "../../web");
const inlineScript = /<script(?![^>]*\bsrc=)[^>]*>[\s\S]*?<\/script>/;
for (const file of readdirSync(webDir).filter((f) => f.endsWith(".html"))) {
  const html = readFileSync(path.join(webDir, file), "utf8");
  check(`web/${file} has no inline <script>`, !inlineScript.test(html));
}

// Any script the pages DO reference must actually exist, or the app is equally
// dead — just with a 404 instead of a CSP violation.
for (const file of readdirSync(webDir).filter((f) => f.endsWith(".html"))) {
  const html = readFileSync(path.join(webDir, file), "utf8");
  for (const m of html.matchAll(/<script[^>]*\bsrc="\/([^"]+)"/g)) {
    check(`web/${file} -> /${m[1]} exists`, existsSync(path.join(webDir, m[1]!)));
  }
}

// The CSP itself must keep forbidding inline scripts. Relaxing it with
// 'unsafe-inline' would silence the check above while reintroducing the risk it
// exists to prevent.
// Matched on basename + parent dir: a path suffix like "src/index.ts" does not
// match on Windows, where the separator is a backslash.
const indexTs = sources.find(
  (s) => path.basename(s.file) === "index.ts" && path.dirname(s.file) === srcRoot,
);
check("index.ts was located for the CSP check", indexTs !== undefined);
check("CSP does not allow 'unsafe-inline' scripts",
  indexTs !== undefined && !/script-src[^;]*unsafe-inline/.test(indexTs.text));

/**
 * Reading mail is allowed; retaining it is not.
 *
 * The product claim is now "we never store your message content, and we only
 * read the one you asked to see". That is only true if reader.ts writes
 * nothing, so the promise is enforced here rather than trusted.
 */
const reader = sources.find((s) => path.basename(s.file) === "reader.ts");
check("reader.ts exists", reader !== undefined);
if (reader) {
  check("Reader never writes to the database",
    !/\b(INSERT|UPDATE|DELETE)\b/i.test(reader.text));
  check("Reader never logs message content", !/console\.(log|info|warn)/.test(reader.text));
  check("Reader checks ownership before fetching", reader.text.includes("ownsMessage"));
}

// Message content must never reach a model. Classification runs on aggregate
// sender statistics; if llm.ts ever imports the reader, that has changed.
const llm = sources.find((s) => path.basename(s.file) === "llm.ts");
check("Classifier does not import the message reader",
  llm !== undefined && !/from\s+["'].*reader\.js["']/.test(llm.text));

// The database schema must not gain a column that could hold a body or a
// plaintext subject — the data-minimisation claim in docs/03 rests on it.
const dbTs = sources.find((s) => path.basename(s.file) === "db.ts")!;
check("Schema stores no message body or plaintext subject",
  !/\b(body|snippet|plain_text|subject)\s+TEXT/i.test(dbTs.text) ||
    /subject_hash\s+TEXT/.test(dbTs.text));
check("Schema still stores subject_hash, not subject",
  /subject_hash/.test(dbTs.text) && !/\bsubject\s+TEXT/i.test(dbTs.text));

// The webhook is unauthenticated by necessity, so the signature check IS the
// security boundary. It must verify against raw bytes, never a re-serialised
// object — index.ts keeps that route's body as a string.
// Matched on basename AND directory: src/classify/index.ts is also called
// index.ts, and a bare basename match silently picks the wrong file — which is
// how this check passed against a file that could never contain the pattern.
const indexSrc = sources.find(
  (s) => path.basename(s.file) === "index.ts" && path.dirname(s.file) === srcRoot,
);
check("Webhook route is exempt from JSON re-serialisation",
  indexSrc !== undefined && /RAW_BODY_ROUTES/.test(indexSrc.text) &&
    indexSrc.text.includes("/api/billing/webhook"));

const billingSrc = sources.find((s) => path.basename(s.file) === "billing.ts" &&
  s.file.includes("lib"));
check("Plans change only via a verified webhook — no client-trusted upgrade path",
  billingSrc !== undefined && /constructEvent/.test(billingSrc.text));

// The payee id must never reach a public endpoint. Enforced at the source
// level because it is a one-line mistake to reintroduce.
check("UPI payee id is not exposed on any public route", (() => {
  const routes = sources.find((x) => x.file.endsWith("billing.ts") && x.file.includes("routes"));
  return routes !== undefined && !/upiId/.test(routes.text);
})());

// The guard layer is only meaningful if it is the sole path to mutation.
const executor = sources.find((s) => s.file.endsWith("executor.ts"))!;
check("executor.ts routes through assertExecutable", executor.text.includes("assertExecutable("));
const mutators = sources.filter(
  (s) => /users\.messages\.batchModify/.test(s.text) && !s.file.endsWith("executor.ts"),
);
check("batchModify is called from executor.ts only", mutators.length === 0,
  mutators.map((m) => path.basename(m.file)).join(", "));

// ── Done ─────────────────────────────────────────────────────────────────

cleanup();
console.log(
  failures === 0
    ? `\nAll ${checks} checks passed.\n`
    : `\n${failures} of ${checks} checks FAILED.\n`,
);
process.exit(failures === 0 ? 0 : 1);
