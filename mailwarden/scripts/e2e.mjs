#!/usr/bin/env node
/**
 * End-to-end checks against a RUNNING server.
 *
 *   node scripts/e2e.mjs                       # http://localhost:8902
 *   node scripts/e2e.mjs https://mailwarden.fly.dev
 *
 * smoke.ts covers logic offline. This covers the gap that logic tests cannot
 * see, and that has now bitten twice in production:
 *
 *   1. The container built green and died at boot (missing native binding).
 *   2. Every asset returned 200 while the client never executed one line,
 *      because the CSP blocks inline scripts.
 *   3. Every bodyless POST returned 400 before reaching its handler.
 *
 * None of those are visible from unit tests, and (2) is not visible from status
 * codes either — so this drives a real browser over the DevTools protocol and
 * asserts the client actually issued API calls.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const BASE = (process.argv[2] ?? "http://localhost:8902").replace(/\/$/, "");
let failures = 0;
let checks = 0;

const check = (name, ok, detail = "") => {
  checks++;
  if (!ok) failures++;
  console.log(`  [${ok ? "PASS" : "FAIL"}] ${name}${detail ? ` — ${detail}` : ""}`);
};
const section = (t) => console.log(`\n${t}`);

const status = async (p, init) => (await fetch(BASE + p, init)).status;

// ── 1. Reachability and production posture ──────────────────────────────
section("1. Reachability and production posture");

check("GET /healthz", (await status("/healthz")) === 200);
check("GET /", (await status("/")) === 200);
check("GET /app.html", (await status("/app.html")) === 200);
check("GET /app.js", (await status("/app.js")) === 200);
check("Demo login is sealed", (await status("/auth/demo")) === 404);

for (const p of ["/api/me", "/api/senders", "/api/categories", "/api/recipes", "/api/audit"]) {
  check(`Unauthenticated GET ${p} -> 401`, (await status(p)) === 401);
}

// ── 2. Bodyless POSTs must reach their handler ──────────────────────────
//
// A 400 here means the request died in the content-type parser and the route
// never ran. 401 is the correct answer: the handler ran and rejected the
// session. This is the exact bug that hung the scan button.
section("2. Bodyless POSTs reach their handler (401, never 400)");

const bodyless = [
  "/api/scan",
  "/api/batches/does-not-exist/execute",
  "/api/batches/does-not-exist/undo",
];
for (const p of bodyless) {
  for (const [label, init] of [
    ["no content-type", { method: "POST" }],
    ["json content-type, empty body", { method: "POST", headers: { "Content-Type": "application/json" } }],
    ["explicit {}", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }],
  ]) {
    const s = await status(p, init);
    check(`POST ${p} (${label}) -> ${s}`, s === 401, s === 400 ? "400 = parser rejected it" : "");
  }
}

// Malformed JSON must still be refused — and as a 400, the caller's fault,
// not a 500 that blames the server and pollutes error monitoring.
const malformed = await status("/api/scan", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: "{not json",
});
check("Malformed JSON is rejected as 400", malformed === 400, `got ${malformed}`);

// ── 3. The client actually runs ─────────────────────────────────────────
section("3. Browser: the client executes and calls the API");

const CHROME = [
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  "/usr/bin/google-chrome",
].find((p) => fs.existsSync(p));

if (!CHROME) {
  console.log("  [SKIP] Chrome not found — browser checks skipped");
} else {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mw-cdp-"));
  // Random port: a stray Chrome from an earlier run holds a fixed one and the
  // whole suite dies on ECONNREFUSED.
  const port = 9300 + Math.floor(Math.random() * 400);
  const chrome = spawn(
    CHROME,
    [`--remote-debugging-port=${port}`, "--headless", "--disable-gpu", "--no-first-run",
     `--user-data-dir=${dir}`, "about:blank"],
    { stdio: "ignore" },
  );
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  try {
    // Chrome's startup time varies; poll rather than guess a sleep.
    let targets = null;
    for (let i = 0; i < 25 && !targets; i++) {
      await sleep(400);
      try {
        targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      } catch { /* not up yet */ }
    }
    if (!targets) throw new Error(`Chrome DevTools never came up on port ${port}`);
    const ws = new WebSocket(targets.find((t) => t.type === "page").webSocketDebuggerUrl);
    const requests = [];
    const violations = [];
    let id = 0;
    const send = (method, params = {}) => ws.send(JSON.stringify({ id: ++id, method, params }));

    ws.onopen = () => {
      send("Log.enable");
      send("Network.enable");
      send("Page.enable");
      send("Page.navigate", { url: `${BASE}/app.html` });
    };
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      if (m.method === "Network.requestWillBeSent") requests.push(m.params.request.url);
      if (m.method === "Log.entryAdded" && /Content Security Policy/i.test(m.params.entry.text)) {
        violations.push(m.params.entry.text);
      }
    };
    await sleep(6000);
    ws.close();

    check("Browser loaded /app.js", requests.some((u) => u.endsWith("/app.js")));
    check("Client issued an API call", requests.some((u) => u.includes("/api/")),
      requests.some((u) => u.includes("/api/")) ? "" : "client never executed");
    check("No CSP violations", violations.length === 0, violations[0]?.slice(0, 120) ?? "");
  } catch (err) {
    // A broken harness must not masquerade as a broken app, nor as a pass.
    check("Browser checks ran", false, String(err).slice(0, 140));
  } finally {
    chrome.kill();
    // Chrome still holds its crashpad files for a moment after kill(). A
    // leaked temp directory is not worth failing a test run over.
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch { /* the OS will reap it */ }
  }
}

console.log(
  failures === 0
    ? `\nAll ${checks} end-to-end checks passed against ${BASE}\n`
    : `\n${failures} of ${checks} end-to-end checks FAILED against ${BASE}\n`,
);
process.exit(failures === 0 ? 0 : 1);
