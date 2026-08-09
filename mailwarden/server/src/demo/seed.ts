import { db, now } from "../db.js";
import { newId } from "../lib/crypto.js";
import { classifyHeuristically, type SenderFacts } from "../classify/heuristics.js";
import { DAY_MS } from "../safety/limits.js";

/**
 * DEMO MODE — a synthetic inbox.
 *
 * Exists so the entire product can be evaluated without Google credentials,
 * which matters for three reasons: the OAuth verification demo video has to
 * show the app working, UI work shouldn't be blocked on a 4–6 week approval,
 * and nobody should have to point unproven code at their real mailbox.
 *
 * The generated mix is deliberately realistic — including the traps. It
 * contains an airline that Gmail filed under PROMOTIONS, a bank, an OTP
 * sender, and a colleague you replied to, so the guardrails are visibly doing
 * something rather than being asserted.
 *
 * Never enabled in production; see the gate in routes/demo.ts.
 */

interface Seed {
  key: string;
  name: string;
  count: number;
  unreadRate: number;
  avgBytes: number;
  labels: string[];
  unsubscribe: boolean;
  ageDays: number;
  spanDays: number;
  templates: number;
  replied?: boolean;
}

const SEEDS: Seed[] = [
  // ── Bulk mail: the stuff we should confidently clean ──────────────────
  { key: "deals@groupon.com", name: "Groupon", count: 2341, unreadRate: 0.97, avgBytes: 180_000, labels: ["CATEGORY_PROMOTIONS"], unsubscribe: true, ageDays: 2, spanDays: 2200, templates: 40 },
  { key: "offers@myntra.com", name: "Myntra", count: 1876, unreadRate: 0.94, avgBytes: 220_000, labels: ["CATEGORY_PROMOTIONS"], unsubscribe: true, ageDays: 3, spanDays: 1400, templates: 30 },
  { key: "news@linkedin.com", name: "LinkedIn", count: 1203, unreadRate: 0.88, avgBytes: 90_000, labels: ["CATEGORY_SOCIAL"], unsubscribe: true, ageDays: 1, spanDays: 1900, templates: 60 },
  { key: "notify@facebook.com", name: "Facebook", count: 894, unreadRate: 0.91, avgBytes: 70_000, labels: ["CATEGORY_SOCIAL"], unsubscribe: true, ageDays: 5, spanDays: 2400, templates: 55 },
  { key: "digest@medium.com", name: "Medium Daily Digest", count: 612, unreadRate: 0.83, avgBytes: 140_000, labels: ["CATEGORY_UPDATES"], unsubscribe: true, ageDays: 190, spanDays: 900, templates: 400 },
  { key: "hello@substacknews.com", name: "The Weekly Brief", count: 288, unreadRate: 0.76, avgBytes: 310_000, labels: ["CATEGORY_FORUMS"], unsubscribe: true, ageDays: 240, spanDays: 800, templates: 280 },
  { key: "noreply@github.com", name: "GitHub", count: 1544, unreadRate: 0.62, avgBytes: 45_000, labels: ["CATEGORY_UPDATES"], unsubscribe: true, ageDays: 1, spanDays: 1600, templates: 90 },
  { key: "updates@zomato.com", name: "Zomato", count: 967, unreadRate: 0.95, avgBytes: 260_000, labels: ["CATEGORY_PROMOTIONS"], unsubscribe: true, ageDays: 8, spanDays: 1100, templates: 25 },
  { key: "promo@swiggy.in", name: "Swiggy", count: 1130, unreadRate: 0.96, avgBytes: 240_000, labels: ["CATEGORY_PROMOTIONS"], unsubscribe: true, ageDays: 4, spanDays: 1000, templates: 22 },
  { key: "newsletter@oldstartup.io", name: "OldStartup", count: 342, unreadRate: 0.89, avgBytes: 120_000, labels: ["CATEGORY_PROMOTIONS"], unsubscribe: true, ageDays: 840, spanDays: 500, templates: 30 },

  // ── The traps. Each must survive every recipe. ────────────────────────
  { key: "info@united.airlines.com", name: "United Airlines", count: 84, unreadRate: 0.4, avgBytes: 95_000, labels: ["CATEGORY_PROMOTIONS"], unsubscribe: true, ageDays: 12, spanDays: 1500, templates: 70 },
  { key: "alerts@chase.com", name: "Chase Bank", count: 421, unreadRate: 0.3, avgBytes: 40_000, labels: ["CATEGORY_UPDATES"], unsubscribe: false, ageDays: 2, spanDays: 1800, templates: 380 },
  { key: "no-reply@accounts.google.com", name: "Google Accounts", count: 156, unreadRate: 0.2, avgBytes: 20_000, labels: [], unsubscribe: false, ageDays: 1, spanDays: 1700, templates: 140 },
  { key: "receipts@amazon.in", name: "Amazon Orders", count: 733, unreadRate: 0.25, avgBytes: 130_000, labels: ["CATEGORY_UPDATES"], unsubscribe: false, ageDays: 3, spanDays: 2000, templates: 700 },
  { key: "booking@irctc.co.in", name: "IRCTC", count: 97, unreadRate: 0.35, avgBytes: 85_000, labels: ["CATEGORY_UPDATES"], unsubscribe: false, ageDays: 30, spanDays: 1200, templates: 92 },
  { key: "priya@worklab.com", name: "Priya Nair", count: 214, unreadRate: 0.05, avgBytes: 55_000, labels: [], unsubscribe: false, ageDays: 1, spanDays: 900, templates: 210, replied: true },
];

function pseudoRandom(seed: number): () => number {
  // Deterministic, so the demo inbox is identical between runs and any bug is
  // reproducible rather than a one-off.
  let state = seed;
  return () => {
    state = (state * 1_664_525 + 1_013_904_223) % 4_294_967_296;
    return state / 4_294_967_296;
  };
}

export interface DemoAccount {
  userId: string;
  accountId: string;
  email: string;
}

export function seedDemoInbox(): DemoAccount {
  const userId = newId("usr");
  const accountId = newId("acc");
  const email = `demo-${userId.slice(4, 10)}@mailwarden.local`;
  const rand = pseudoRandom(20260809);

  db.prepare(`INSERT INTO users (id, email, plan, created_at, updated_at) VALUES (?,?,?,?,?)`).run(
    userId, email, "free", now(), now(),
  );
  db.prepare(
    `INSERT INTO accounts (id, user_id, email, refresh_token_enc, sync_state, last_sync_at, created_at)
     VALUES (?,?,?,?,?,?,?)`,
  ).run(accountId, userId, email, "demo-no-token", "idle", now(), now());

  const insertMsg = db.prepare(
    `INSERT INTO messages_meta
       (account_id, message_id, thread_id, sender_key, subject_hash, internal_date,
        size_bytes, labels, is_unread, has_unsubscribe)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
  );
  const insertSender = db.prepare(
    `INSERT INTO senders
       (id, account_id, sender_key, display_name, domain, message_count, unread_count,
        total_bytes, first_seen, last_seen, has_unsubscribe, user_replied,
        category, confidence, reason, protected, classified_by)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  );

  db.transaction(() => {
    for (const seed of SEEDS) {
      const newest = now() - seed.ageDays * DAY_MS;
      const oldest = newest - seed.spanDays * DAY_MS;
      let unread = 0;
      let bytes = 0;

      for (let i = 0; i < seed.count; i++) {
        const isUnread = rand() < seed.unreadRate;
        if (isUnread) unread++;
        const date = Math.round(oldest + rand() * (newest - oldest));
        const size = Math.round(seed.avgBytes * (0.5 + rand()));
        bytes += size;

        const labels = [...seed.labels, "INBOX", ...(isUnread ? ["UNREAD"] : [])];
        // A replied-to sender needs a SENT message in-thread for the
        // aggregation logic to detect the reply, exactly as in real sync.
        const threadId = `thr_${seed.key}_${i}`;
        insertMsg.run(
          accountId, `msg_${seed.key}_${i}`, threadId, seed.key,
          `h${i % seed.templates}`, date, size, labels.join(","), isUnread ? 1 : 0,
          seed.unsubscribe ? 1 : 0,
        );
        if (seed.replied && i % 3 === 0) {
          insertMsg.run(
            accountId, `msg_sent_${seed.key}_${i}`, threadId, email,
            `hs${i}`, date + 3600_000, 4000, "SENT", 0, 0,
          );
        }
      }

      const facts: SenderFacts = {
        senderKey: seed.key,
        displayName: seed.name,
        domain: seed.key.split("@")[1] ?? "unknown",
        messageCount: seed.count,
        unreadCount: unread,
        totalBytes: bytes,
        firstSeen: oldest,
        lastSeen: newest,
        hasUnsubscribe: seed.unsubscribe,
        userReplied: seed.replied === true,
        labels: [...seed.labels, "INBOX"],
        distinctSubjectHashes: Math.min(seed.templates, seed.count),
      };

      // Run the real classifier rather than hardcoding categories, so the demo
      // reflects actual behaviour — including any misclassification.
      const verdict = classifyHeuristically(facts) ?? {
        category: "unknown" as const,
        confidence: 0.3,
        reason: "Not enough signal to classify — left untouched.",
        protectedSender: true,
        source: "heuristic" as const,
      };

      insertSender.run(
        newId("snd"), accountId, seed.key, seed.name, facts.domain, seed.count, unread,
        bytes, oldest, newest, seed.unsubscribe ? 1 : 0, seed.replied ? 1 : 0,
        verdict.category, verdict.confidence, verdict.reason,
        verdict.protectedSender ? 1 : 0, verdict.source,
      );
    }
  })();

  return { userId, accountId, email };
}
