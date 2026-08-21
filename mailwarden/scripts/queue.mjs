#!/usr/bin/env node
/**
 * The access-request queue, formatted for one paste into Google Cloud Console.
 *
 *   pnpm queue                       # https://mailwarden.fly.dev
 *   pnpm queue http://localhost:8902
 *
 * Why this exists
 * ---------------
 * There is no public API for the OAuth consent screen's Test users list —
 * Google has never shipped one and has said so directly on the developer
 * forum. So while the app is in **Testing** publishing status, every person
 * who signs up has to be pasted into the console by hand.
 *
 * This script does not remove that step. It makes it one paste instead of N:
 * Console -> Google Auth Platform -> Audience -> Test users -> Add users
 * accepts a newline-separated block, so 60 pending signups take about as long
 * as one.
 *
 * The real fix is to switch publishing status from Testing to In production,
 * which removes the Test users list entirely (and stops refresh tokens
 * expiring every 7 days). See docs/08-launch-checklist.md. This script is the
 * fallback for as long as Testing mode is in use.
 *
 * Auth: the queue endpoint is gated on ADMIN_EMAIL, so it needs the operator's
 * session cookie.
 *
 *   1. Sign in to the app as ADMIN_EMAIL in a browser
 *   2. DevTools -> Application -> Cookies -> copy the value of `mw_session`
 *   3. MW_SESSION=<value> pnpm queue
 *
 * The cookie is read from the environment and never written to disk here.
 */

const BASE = (process.argv[2] ?? "https://mailwarden.fly.dev").replace(/\/$/, "");
const SESSION = process.env.MW_SESSION;

if (!SESSION) {
  console.error(
    "MW_SESSION is not set.\n\n" +
      "  Sign in as ADMIN_EMAIL, copy the `mw_session` cookie, then:\n" +
      "  MW_SESSION=<value> pnpm queue\n",
  );
  process.exit(2);
}

const res = await fetch(`${BASE}/api/access-request/list`, {
  headers: { cookie: `mw_session=${SESSION}` },
});

if (res.status === 401 || res.status === 403) {
  console.error(
    `${res.status} from ${BASE}. The cookie is expired, or the account it ` +
      `belongs to is not ADMIN_EMAIL.\n\n` +
      `Note: in Testing mode Google expires authorizations after 7 days, so an ` +
      `admin session that worked last week will not work today. Sign in again.`,
  );
  process.exit(1);
}

if (!res.ok) {
  console.error(`${res.status} ${res.statusText} from ${BASE}`);
  process.exit(1);
}

const { requests = [] } = await res.json();

const pending = requests.filter((r) => !r.invited_at);
const invited = requests.filter((r) => r.invited_at);

// De-duplicate and normalise. Someone who submits the form three times should
// not burn three lines of a paste, and Google will reject a malformed address
// for the whole batch rather than skipping it.
const seen = new Set();
const emails = [];
for (const r of pending) {
  const email = String(r.email ?? "").trim().toLowerCase();
  if (!email || seen.has(email)) continue;
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    console.warn(`  skipped (malformed): ${r.email}`);
    continue;
  }
  seen.add(email);
  emails.push(email);
}

const rule = "─".repeat(64);

console.log(`\n${rule}`);
console.log(`  ${emails.length} pending · ${invited.length} already invited · ${BASE}`);
console.log(rule);

if (!emails.length) {
  console.log("\n  Queue is empty.\n");
  process.exit(0);
}

// The 100-user ceiling is the whole constraint, so surface it every run rather
// than letting it be discovered at seat 101.
const total = invited.length + emails.length;
if (total > 100) {
  console.log(
    `\n  ⚠ ${total} total requests against a 100-seat cap. ` +
      `${total - 100} cannot be granted until verification clears.`,
  );
} else {
  console.log(`\n  ${100 - total} of 100 seats would remain after this batch.`);
}

console.log(`\n  Paste into: Console → Google Auth Platform → Audience → Test users → Add users\n`);
console.log(emails.join("\n"));
console.log(`\n${rule}\n`);

for (const r of pending.filter((p) => p.note)) {
  console.log(`  note · ${r.email}: ${r.note}`);
}
