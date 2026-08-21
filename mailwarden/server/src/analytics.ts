import { createHash, randomBytes } from "node:crypto";

import { db } from "./db.js";

/**
 * FIRST-PARTY, COOKIELESS ANALYTICS.
 *
 * Same origin, same database, no vendor. That is not a purity exercise — three
 * concrete constraints rule out a hosted tracker for this product:
 *
 *   1. The CSP is `default-src 'self'` with no script-src, enforced by a smoke
 *      check. A third-party tag needs that opened, and opening it is not a
 *      thing to do in the same week Google is reviewing our Gmail access.
 *   2. The privacy page's claim is that mail data goes nowhere. Shipping an
 *      ad-tech tag on the page making that claim is a bad look at best and, if
 *      the tag ever saw a URL containing a sender address, a false statement.
 *   3. No cookie means no consent banner, in any jurisdiction.
 *
 * WHAT IS STORED: an event name, a page path, a referrer HOST, a utm source,
 * and a rotating visitor hash. Nothing else.
 *
 * WHAT IS NOT STORED: IP addresses, user agents, full referrer URLs, user ids,
 * email addresses, or anything joinable to a mailbox. The visitor hash is
 * salted with a key that lives in memory only and rotates every UTC day, so
 * yesterday's rows cannot be re-identified even by someone holding the DB and
 * today's salt — the salt that made them no longer exists anywhere.
 *
 * The cost of that design is honest and worth stating: a "unique visitor"
 * resets at midnight UTC and is per-device. This measures a launch, not a
 * cohort.
 */

db.exec(`
CREATE TABLE IF NOT EXISTS web_events (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT NOT NULL,          -- from EVENTS, never free text
  path          TEXT NOT NULL,          -- from PATHS, never free text
  referrer_host TEXT,                   -- host only; never a full URL
  utm_source    TEXT,
  visitor       TEXT NOT NULL,          -- daily-rotating salted hash
  created_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_web_events_day ON web_events(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_web_events_name ON web_events(name, created_at DESC);
`);

/**
 * The event vocabulary, fixed at build time.
 *
 * `/api/e` is necessarily public and unauthenticated — it fires on the landing
 * page, before anyone has an account. An allowlist is what stops that endpoint
 * from being a free write-anything-you-like table: a name not on this list is
 * dropped, so no amount of crafted POSTs can invent event types, inflate
 * cardinality, or smuggle text into the admin dashboard.
 */
export const EVENTS = [
  "pageview",
  "invite_submit",
  "invite_ok",
  "cta_signin",
  "cta_pricing",
  "plan_select",
] as const;

/** Public paths, likewise fixed. Unknown paths are recorded as "other". */
const PATHS = new Set(["/", "/pricing.html", "/privacy.html", "/terms.html", "/app"]);

const EVENT_SET = new Set<string>(EVENTS);

/**
 * Visitor identity without a cookie.
 *
 * hash(salt + ip + user-agent), where the salt is 32 random bytes generated at
 * boot and regenerated whenever the UTC day changes. The inputs are hashed and
 * discarded immediately; only the digest is written. Rotating the salt is what
 * makes the digest non-reversible in practice — without rotation, anyone with
 * the salt could hash a candidate IP and confirm a match.
 */
let salt = randomBytes(32);
let saltDay = utcDay();

function utcDay(): string {
  return new Date().toISOString().slice(0, 10);
}

function visitorHash(ip: string, userAgent: string): string {
  const today = utcDay();
  if (today !== saltDay) {
    salt = randomBytes(32);
    saltDay = today;
  }
  return createHash("sha256")
    .update(salt)
    .update(ip)
    .update("\0")
    .update(userAgent)
    .digest("hex")
    .slice(0, 16);
}

/**
 * Per-visitor flood ceiling.
 *
 * Without it one script can add a million rows to the table the launch is being
 * judged from, and the first sign of trouble would be a dashboard that reads
 * like a hit. Sixty events a minute is far above what a person browsing five
 * pages can produce and far below what an attacker needs to be useful.
 */
const RATE_LIMIT = 60;
const RATE_WINDOW_MS = 60_000;
let windowStart = Date.now();
let counts = new Map<string, number>();

function overRateLimit(visitor: string): boolean {
  const nowMs = Date.now();
  if (nowMs - windowStart > RATE_WINDOW_MS) {
    windowStart = nowMs;
    counts = new Map();
  }
  const n = (counts.get(visitor) ?? 0) + 1;
  counts.set(visitor, n);
  return n > RATE_LIMIT;
}

/** Referrers are reduced to a host. A full URL can carry someone's private path. */
function referrerHost(referrer: string | undefined, selfHost: string): string | null {
  if (!referrer) return null;
  try {
    const host = new URL(referrer).hostname.toLowerCase().replace(/^www\./, "");
    // Our own pages linking to each other are navigation, not acquisition.
    if (!host || host === selfHost.toLowerCase().replace(/^www\./, "")) return null;
    return host.slice(0, 80);
  } catch {
    return null;
  }
}

/** utm_source, reduced to a slug. Anything else is discarded rather than stored. */
function utmSource(query: string | undefined): string | null {
  if (!query) return null;
  try {
    const value = new URLSearchParams(query.replace(/^\?/, "")).get("utm_source");
    if (!value) return null;
    const slug = value.toLowerCase().replace(/[^a-z0-9_.-]/g, "").slice(0, 32);
    return slug || null;
  } catch {
    return null;
  }
}

function normalisePath(raw: string | undefined): string {
  if (!raw) return "other";
  const bare = raw.split("?")[0]!.split("#")[0]!;
  const path = bare === "/index.html" ? "/" : bare === "/app.html" ? "/app" : bare;
  return PATHS.has(path) ? path : "other";
}

export interface WebEventInput {
  name: string;
  path?: string;
  query?: string;
  referrer?: string;
  ip: string;
  userAgent: string;
  selfHost: string;
}

/**
 * Records one client-side event. Returns false when the event was dropped, so
 * the route can answer 204 either way — a tracker that reports back which of
 * its payloads were rejected is a tracker that can be probed.
 */
export function recordWebEvent(input: WebEventInput): boolean {
  if (!EVENT_SET.has(input.name)) return false;

  const visitor = visitorHash(input.ip, input.userAgent);
  if (overRateLimit(visitor)) return false;

  db.prepare(
    `INSERT INTO web_events (name, path, referrer_host, utm_source, visitor, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    input.name,
    normalisePath(input.path),
    referrerHost(input.referrer, input.selfHost),
    utmSource(input.query),
    visitor,
    Date.now(),
  );
  return true;
}

export interface AnalyticsSummary {
  days: number;
  since: number;
  traffic: { visitors: number; pageviews: number };
  pages: { path: string; views: number; visitors: number }[];
  referrers: { host: string; visitors: number }[];
  sources: { source: string; visitors: number }[];
  daily: { day: string; visitors: number; pageviews: number }[];
  /**
   * The launch funnel. The first two steps are web events; every step after
   * that is counted from audit_log and access_requests, which are written by
   * the server as part of the action itself. That half of the funnel therefore
   * cannot be inflated by anyone POSTing at /api/e.
   */
  funnel: { step: string; count: number; source: "web" | "server" }[];
}

/** One rolling window, computed on read. Nothing here is precomputed or cached. */
export function analyticsSummary(days = 7): AnalyticsSummary {
  const since = Date.now() - days * 86_400_000;

  const traffic = db
    .prepare(
      `SELECT COUNT(DISTINCT visitor) AS visitors,
              COUNT(*) FILTER (WHERE name = 'pageview') AS pageviews
       FROM web_events WHERE created_at >= ?`,
    )
    .get(since) as { visitors: number; pageviews: number };

  const pages = db
    .prepare(
      `SELECT path, COUNT(*) AS views, COUNT(DISTINCT visitor) AS visitors
       FROM web_events WHERE created_at >= ? AND name = 'pageview'
       GROUP BY path ORDER BY views DESC LIMIT 20`,
    )
    .all(since) as { path: string; views: number; visitors: number }[];

  const referrers = db
    .prepare(
      `SELECT referrer_host AS host, COUNT(DISTINCT visitor) AS visitors
       FROM web_events WHERE created_at >= ? AND referrer_host IS NOT NULL
       GROUP BY referrer_host ORDER BY visitors DESC LIMIT 20`,
    )
    .all(since) as { host: string; visitors: number }[];

  const sources = db
    .prepare(
      `SELECT utm_source AS source, COUNT(DISTINCT visitor) AS visitors
       FROM web_events WHERE created_at >= ? AND utm_source IS NOT NULL
       GROUP BY utm_source ORDER BY visitors DESC LIMIT 20`,
    )
    .all(since) as { source: string; visitors: number }[];

  const daily = db
    .prepare(
      `SELECT date(created_at / 1000, 'unixepoch') AS day,
              COUNT(DISTINCT visitor) AS visitors,
              COUNT(*) FILTER (WHERE name = 'pageview') AS pageviews
       FROM web_events WHERE created_at >= ?
       GROUP BY day ORDER BY day DESC`,
    )
    .all(since) as { day: string; visitors: number; pageviews: number }[];

  const webCount = db.prepare(
    `SELECT COUNT(DISTINCT visitor) c FROM web_events WHERE created_at >= ? AND name = ?`,
  );
  const auditCount = db.prepare(
    `SELECT COUNT(DISTINCT user_id) c FROM audit_log WHERE created_at >= ? AND action = ?`,
  );
  const one = (stmt: typeof webCount, arg: string): number =>
    (stmt.get(since, arg) as { c: number }).c;

  const waitlist = (
    db
      .prepare(`SELECT COUNT(*) c FROM access_requests WHERE created_at >= ?`)
      .get(since) as { c: number }
  ).c;

  return {
    days,
    since,
    traffic,
    pages,
    referrers,
    sources,
    daily,
    funnel: [
      { step: "Landed", count: one(webCount, "pageview"), source: "web" },
      { step: "Saw pricing", count: one(webCount, "cta_pricing"), source: "web" },
      { step: "Asked for access", count: waitlist, source: "server" },
      { step: "Connected Gmail", count: one(auditCount, "account.connected"), source: "server" },
      { step: "Finished a scan", count: one(auditCount, "scan.completed"), source: "server" },
      { step: "Cleaned something", count: one(auditCount, "batch.executed"), source: "server" },
      { step: "Paid", count: one(auditCount, "billing.purchased"), source: "server" },
    ],
  };
}

/**
 * Drops rows past their useful life. Called on a timer from index.ts.
 *
 * Retention is a deliberate 90 days: long enough to compare a launch week to
 * the month after it, short enough that the table cannot quietly become the
 * largest thing in a SQLite file that also holds every user's mailbox index.
 */
export function pruneWebEvents(retentionDays = 90): number {
  const cutoff = Date.now() - retentionDays * 86_400_000;
  return db.prepare(`DELETE FROM web_events WHERE created_at < ?`).run(cutoff).changes;
}
