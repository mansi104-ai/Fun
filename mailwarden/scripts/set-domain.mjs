#!/usr/bin/env node
/**
 * Points the whole site at a different origin, in one command.
 *
 *   node scripts/set-domain.mjs https://mailwarden.ai
 *   node scripts/set-domain.mjs https://mailwarden.ai --dry-run
 *
 * WHY THIS EXISTS
 *
 * Google rejected OAuth verification with "the website of your homepage URL is
 * not registered to you". A `*.fly.dev` subdomain is registered to Fly.io, not
 * to us, and no amount of Search Console verification changes whose name is on
 * the registration. The fix is a domain we own — which means moving every
 * canonical tag, og:url, sitemap entry and robots directive at once.
 *
 * Doing that by hand across six files is how a canonical ends up pointing at
 * the old host for a month. smoke.ts §19 fails the build if they disagree, so
 * a half-finished move cannot ship — but a script that finishes the job is
 * better than a check that catches you not having done it.
 *
 * WHAT THIS DOES NOT DO — these need your Google and Fly accounts:
 *
 *   1. flyctl certs add <host>
 *   2. flyctl secrets set APP_URL=<origin>
 *   3. Google Cloud → Credentials → add <origin>/auth/google/callback
 *      as an Authorised redirect URI. Miss this and OAuth breaks with
 *      redirect_uri_mismatch for every user, including you.
 *   4. Google Cloud → OAuth consent screen → set the homepage to <origin>
 *   5. Google Search Console → add and verify <origin> → submit
 *      <origin>/sitemap.xml
 *
 * The script prints these when it finishes. It cannot do them for you.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const web = path.join(root, "web");

const target = process.argv[2];
const dryRun = process.argv.includes("--dry-run");

if (!target) {
  console.error("Usage: node scripts/set-domain.mjs https://your-domain.example [--dry-run]");
  process.exit(1);
}

let origin;
try {
  const url = new URL(target);
  if (url.protocol !== "https:") throw new Error("must be https");
  // Origin only: a trailing path here would end up inside every canonical tag.
  origin = url.origin;
} catch (err) {
  console.error(`Not a usable https origin: ${target} (${err.message})`);
  process.exit(1);
}

/** Every file that names the site's own origin. */
const FILES = [
  "index.html", "pricing.html", "privacy.html", "terms.html",
  "robots.txt", "sitemap.xml",
].map((f) => path.join(web, f));

/**
 * Self-references are found only where the site DEFINES its own URLs, never by
 * scanning for anything that looks like a URL.
 *
 * The homepage documents the Google scopes it requests, so it legitimately
 * contains `https://www.googleapis.com/...` and `https://mail.google.com/`. A
 * bare origin regex finds those too and then refuses to run — or worse,
 * rewrites them, which would turn the scope disclosure Google is reviewing
 * into nonsense.
 *
 * What is found is also never assumed. Hardcoding "replace mailwarden.fly.dev"
 * would work exactly once and silently do nothing on the second move; reading
 * the current value means the script keeps working, and means it can refuse
 * when it finds two different self-origins — the drift it exists to prevent.
 */
const SELF_URL_PATTERNS = [
  /<link\s+rel="canonical"\s+href="([^"]+)"/gi,
  /<meta\s+property="og:(?:url|image)"\s+content="([^"]+)"/gi,
  /<loc>([^<]+)<\/loc>/gi,
  /^Sitemap:\s*(\S+)/gim,
  /"(?:url|image)":\s*"([^"]+)"/gi,
];

const found = new Map();
for (const file of FILES) {
  if (!fs.existsSync(file)) {
    console.error(`Missing: ${path.relative(root, file)}`);
    process.exit(1);
  }
  const text = fs.readFileSync(file, "utf8");
  for (const pattern of SELF_URL_PATTERNS) {
    for (const m of text.matchAll(pattern)) {
      let ref;
      try {
        ref = new URL(m[1]);
      } catch {
        continue;  // a relative or malformed value is not ours to move
      }
      // schema.org appears as a JSON-LD "@context" and "availability" value.
      if (/schema\.org$/.test(ref.hostname)) continue;
      found.set(ref.origin, (found.get(ref.origin) ?? 0) + 1);
    }
  }
}

const ours = [...found.keys()].filter((o) => o !== origin);
if (ours.length === 0) {
  console.log(`Nothing to change — every self-reference already points at ${origin}.`);
  process.exit(0);
}
if (ours.length > 1) {
  console.error("Refusing to guess: the tree already contains more than one self-origin.");
  for (const o of ours) console.error(`  ${o}  (${found.get(o)} references)`);
  console.error("Fix that by hand first, then re-run.");
  process.exit(1);
}

const from = ours[0];
console.log(`${dryRun ? "Would rewrite" : "Rewriting"} ${from} -> ${origin}\n`);

let total = 0;
for (const file of FILES) {
  const before = fs.readFileSync(file, "utf8");
  const after = before.split(from).join(origin);
  const hits = before.split(from).length - 1;
  if (hits === 0) continue;
  total += hits;
  console.log(`  ${path.relative(root, file).padEnd(24)} ${hits} reference${hits === 1 ? "" : "s"}`);
  if (!dryRun) fs.writeFileSync(file, after);
}

const host = new URL(origin).hostname;
console.log(`\n${dryRun ? "Would change" : "Changed"} ${total} references in ${FILES.length} files.`);

if (dryRun) process.exit(0);

console.log(`
Now run the smoke suite — §19 proves canonical, og:url and the sitemap agree:

    cd server && pnpm test

Then the five things this script cannot do:

  1. flyctl certs add ${host}
  2. flyctl secrets set APP_URL=${origin}
  3. Google Cloud -> Credentials -> Authorised redirect URIs:
       add ${origin}/auth/google/callback
     (missing this breaks OAuth with redirect_uri_mismatch for everyone)
  4. Google Cloud -> OAuth consent screen -> Application home page:
       ${origin}
  5. Google Search Console -> add ${origin}, verify it, submit
       ${origin}/sitemap.xml

Keep the old fly.dev certificate until DNS has propagated; removing it early
takes the site down for anyone still resolving the old host.
`);
