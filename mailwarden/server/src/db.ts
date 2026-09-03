import Database from "better-sqlite3";
import { config } from "./config.js";

export const db = new Database(config.databasePath);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

/**
 * Data minimisation is a hard requirement, not a preference — it is what keeps
 * the CASA assessment cheap and the privacy claim true.
 *
 *   NO message bodies.
 *   NO plaintext subjects (subject_hash only).
 *   NO recipient addresses.
 *
 * See docs/03-compliance-and-launch-path.md §4.
 */
db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id                TEXT PRIMARY KEY,
  email             TEXT NOT NULL UNIQUE,
  plan              TEXT NOT NULL DEFAULT 'free',   -- free | starter | pro
  stripe_customer   TEXT,
  free_batch_used   INTEGER NOT NULL DEFAULT 0,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS accounts (
  id                TEXT PRIMARY KEY,
  user_id           TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  email             TEXT NOT NULL,
  refresh_token_enc TEXT NOT NULL,
  history_id        TEXT,
  last_sync_at      INTEGER,
  sync_state        TEXT NOT NULL DEFAULT 'idle',   -- idle | running | error | needs_reconnect
  sync_cursor       TEXT,
  created_at        INTEGER NOT NULL,
  UNIQUE(user_id, email)
);

-- One row per message. Deliberately narrow.
CREATE TABLE IF NOT EXISTS messages_meta (
  account_id        TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  message_id        TEXT NOT NULL,
  thread_id         TEXT,
  sender_key        TEXT NOT NULL,                  -- normalised sender address
  subject_hash      TEXT,
  internal_date     INTEGER NOT NULL,
  size_bytes        INTEGER NOT NULL DEFAULT 0,
  labels            TEXT NOT NULL DEFAULT '',       -- comma-joined Gmail label IDs
  is_unread         INTEGER NOT NULL DEFAULT 0,
  has_unsubscribe   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (account_id, message_id)
);
CREATE INDEX IF NOT EXISTS idx_messages_sender ON messages_meta(account_id, sender_key);

-- The unit of decision. ~200-400 rows for a 40k-message inbox.
CREATE TABLE IF NOT EXISTS senders (
  id                TEXT PRIMARY KEY,
  account_id        TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  sender_key        TEXT NOT NULL,
  display_name      TEXT,
  domain            TEXT NOT NULL,
  message_count     INTEGER NOT NULL DEFAULT 0,
  unread_count      INTEGER NOT NULL DEFAULT 0,
  total_bytes       INTEGER NOT NULL DEFAULT 0,
  first_seen        INTEGER,
  last_seen         INTEGER,
  has_unsubscribe   INTEGER NOT NULL DEFAULT 0,
  user_replied      INTEGER NOT NULL DEFAULT 0,     -- strongest protect signal
  category          TEXT,                           -- see classify/taxonomy.ts
  confidence        REAL,
  reason            TEXT,                           -- shown verbatim in the UI
  protected         INTEGER NOT NULL DEFAULT 0,
  classified_by     TEXT,                           -- heuristic | llm:<model>
  user_decision     TEXT,                           -- keep | archive | trash | unsubscribe
  UNIQUE(account_id, sender_key)
);
CREATE INDEX IF NOT EXISTS idx_senders_account ON senders(account_id);

-- A batch is one consent event. Nothing executes without one.
CREATE TABLE IF NOT EXISTS batches (
  id                TEXT PRIMARY KEY,
  account_id        TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  status            TEXT NOT NULL DEFAULT 'pending', -- pending | running | done | failed | undone
  action            TEXT NOT NULL,                   -- archive | trash
  message_count     INTEGER NOT NULL DEFAULT 0,
  bytes_freed       INTEGER NOT NULL DEFAULT 0,
  error             TEXT,
  created_at        INTEGER NOT NULL,
  completed_at      INTEGER,
  undone_at         INTEGER
);

-- Every message touched, with the labels it had beforehand. This table IS the
-- undo feature; without it we cannot honour the 30-day reversal promise.
CREATE TABLE IF NOT EXISTS batch_items (
  batch_id          TEXT NOT NULL REFERENCES batches(id) ON DELETE CASCADE,
  message_id        TEXT NOT NULL,
  sender_key        TEXT NOT NULL,
  prior_labels      TEXT NOT NULL,
  applied           INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (batch_id, message_id)
);

CREATE TABLE IF NOT EXISTS audit_log (
  id                TEXT PRIMARY KEY,
  user_id           TEXT NOT NULL,
  action            TEXT NOT NULL,
  detail            TEXT,
  created_at        INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_user ON audit_log(user_id, created_at DESC);

-- Enforces the OpenRouter free-tier ceiling. Without this the free tier
-- silently starts failing at request 51 of the day.
CREATE TABLE IF NOT EXISTS llm_usage (
  day               TEXT NOT NULL,
  provider          TEXT NOT NULL,
  requests          INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, provider)
);
`);

/**
 * Additive migrations.
 *
 * The CREATE TABLE statements above use IF NOT EXISTS, so they never alter an
 * existing table. Anything added after the first release has to arrive here.
 */
function addColumn(table: string, column: string, definition: string): void {
  const existing = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (existing.some((c) => c.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

// Iteration 12 — explicit user overrides on classification.
//   1  = user pinned this sender as protected, permanently
//  -1  = user explicitly released a protection we applied
//   0  = no override; automatic classification governs
addColumn("senders", "user_protected", "INTEGER NOT NULL DEFAULT 0");

// The other half of the same idea: the user moving a sender INTO Clean.
//
// Separate from user_protected rather than another value on it, because the
// two answer different questions — "should this be held back?" and "has the
// user vouched for this?" — and only the first is consulted by the guards.
//
// Promotion changes which tab a sender appears in. It does NOT loosen a single
// per-message guard: starred, attached, and recent mail is still excluded at
// plan time, and a replied-to sender is never promotable at all. See
// safety/limits.ts — "below this confidence a sender is never *suggested*.
// Users may still choose it."
addColumn("senders", "user_promoted", "INTEGER NOT NULL DEFAULT 0");

// Iteration 48 — the guard verdict recorded at plan time, so the receipt and
// the audit trail can show exactly which rules ran and what they excluded.
addColumn("batches", "guard_report", "TEXT");
addColumn("batches", "excluded_count", "INTEGER NOT NULL DEFAULT 0");

// A fingerprint of the signals that produced a sender's verdict. When it is
// unchanged, the verdict is still valid and the sender is skipped — which is
// what stops every re-scan from re-spending the whole LLM budget.
addColumn("senders", "facts_hash", "TEXT");

// How many times the user has archived or trashed this sender. The strongest
// available signal about their intent, and free — it comes from their own past
// decisions rather than a model. See classify/heuristics.ts.
addColumn("senders", "decision_count", "INTEGER NOT NULL DEFAULT 0");
addColumn("senders", "decided_at", "INTEGER");

// Iterations 44/45 — unsubscribe, and the verification nobody else does.
//   method  one-click | link | mailto
//   status  sent | needs_user | failed | verified | ignored
// `unsubscribed_at` is the clock that iteration 45 checks against: if mail from
// this sender keeps arriving 14 days later, the sender ignored the request and
// we can say so.
// ── Billing (iterations 24–27) ───────────────────────────────────────────
//
// plan values: free | starter | pro | founding
//   founding = the $49 one-time Founding 100 seat. Pro entitlements, no expiry.
//              Deliberately a distinct plan rather than pro+flag, because the
//              seat count is a public promise ("only 100 exist") and has to be
//              countable with one query.
addColumn("users", "stripe_subscription", "TEXT");
addColumn("users", "plan_expires_at", "INTEGER");
addColumn("users", "founding_seat", "INTEGER");

// Volume metering. The free tier is 1,000 cleaned messages a month; the
// Backlog Pass is a 50,000-message bucket with a 60-day expiry. Both are
// counted here, and `quota_period` is what makes the monthly refill derivable
// from the row instead of dependent on a cron that can fail silently.
//
// `free_batch_used` above is the retired batch-count meter, left in place
// rather than dropped: SQLite rewrites the whole table to drop a column, and
// the old numbers are the only record of what the pre-metering tier gave away.
addColumn("users", "messages_used", "INTEGER NOT NULL DEFAULT 0");
addColumn("users", "unsubs_used", "INTEGER NOT NULL DEFAULT 0");
addColumn("users", "quota_period", "TEXT");

// Demand captured while the Google 100-user cap is binding. This is the list
// you work through as seats free up, and the evidence that demand exists.
db.exec(`
CREATE TABLE IF NOT EXISTS access_requests (
  id          TEXT PRIMARY KEY,
  email       TEXT NOT NULL UNIQUE,
  note        TEXT,
  source      TEXT,
  invited_at  INTEGER,
  created_at  INTEGER NOT NULL
);

-- One row per UPI payment attempt.
--
-- The reference is what makes manual reconciliation tractable: it goes in the
-- UPI transaction note, so a bank statement line can be matched to a buyer
-- without guessing from name or amount. Without it, ten people paying ₹799 on
-- the same evening are indistinguishable.
CREATE TABLE IF NOT EXISTS payment_orders (
  id           TEXT PRIMARY KEY,
  reference    TEXT NOT NULL UNIQUE,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  email        TEXT NOT NULL,
  plan         TEXT NOT NULL,
  amount_inr   INTEGER NOT NULL,
  status       TEXT NOT NULL DEFAULT 'pending',  -- pending | confirmed | cancelled
  utr          TEXT,                             -- the bank's transaction id
  created_at   INTEGER NOT NULL,
  confirmed_at INTEGER,
  confirmed_by TEXT
);
CREATE INDEX IF NOT EXISTS idx_orders_status ON payment_orders(status, created_at DESC);

-- Every Stripe event we accept, so a replayed or duplicated webhook cannot
-- grant a second seat or double-count revenue. Stripe explicitly does not
-- guarantee exactly-once delivery.
CREATE TABLE IF NOT EXISTS stripe_events (
  id          TEXT PRIMARY KEY,
  type        TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);
`);

/**
 * Per-message undo state, so the round-trip guarantee is a fact rather than an
 * assumption.
 *
 *   restored      1 once Gmail has been asked to put this message back
 *   verify_state  what a READ-BACK of Gmail actually found:
 *                   verified   labels we changed match prior_labels exactly
 *                   mismatch   Gmail disagrees; the message is not restored
 *                   missing    Gmail no longer has it (purged after 30 days)
 *
 * Without these, a partial undo cannot resume precisely and cannot tell the
 * user WHICH messages are still wrong.
 */
addColumn("batch_items", "restored", "INTEGER NOT NULL DEFAULT 0");
addColumn("batch_items", "verify_state", "TEXT");

/**
 * Attachment presence, per message.
 *
 * A message carrying a file is far more likely to be something the user cannot
 * reproduce — an invoice, a ticket, a contract, a photo. Size is a poor proxy
 * (image-heavy marketing mail is large and worthless), so this is populated
 * from Gmail's own `has:attachment` search during sync.
 */
addColumn("messages_meta", "has_attachment", "INTEGER NOT NULL DEFAULT 0");

addColumn("senders", "unsubscribed_at", "INTEGER");
addColumn("senders", "unsubscribe_method", "TEXT");
addColumn("senders", "unsubscribe_status", "TEXT");
addColumn("senders", "unsubscribe_detail", "TEXT");

export const now = (): number => Date.now();

export function audit(userId: string, action: string, detail?: unknown): void {
  db.prepare(
    `INSERT INTO audit_log (id, user_id, action, detail, created_at) VALUES (?, ?, ?, ?, ?)`,
  ).run(
    `aud_${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`,
    userId,
    action,
    detail === undefined ? null : JSON.stringify(detail),
    now(),
  );
}
