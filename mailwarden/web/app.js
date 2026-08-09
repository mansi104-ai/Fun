/**
 * Mailwarden app client.
 *
 * Organised around one idea: SAFE / REVIEW / PROTECTED. The user's real fear is
 * not "will it find enough junk" but "will it touch something important", so
 * protection is a headline number rather than a footnote, and every claim the
 * interface makes is backed by a value the server actually computed.
 *
 * Two rules this file follows without exception:
 *   1. No number is invented. If the API does not return it, it is not shown.
 *   2. No generated prose. Evidence comes from observed facts (`evidence[]`),
 *      never from a model writing an explanation after the fact.
 *
 * Lives in its own file because the production CSP is `default-src 'self'` with
 * no script-src — an inline script silently never executes. smoke.ts fails the
 * build if one reappears.
 */

const $ = (id) => document.getElementById(id);

/**
 * Content-Type is set only when there is a body. Sending it with an empty body
 * makes Fastify reject the request with FST_ERR_CTP_EMPTY_JSON_BODY, a 400
 * raised before the handler runs — which once broke every bodyless POST.
 */
const api = async (url, opts = {}) => {
  const hasBody = opts.body !== undefined && opts.body !== null;
  const res = await fetch(url, {
    ...opts,
    headers: { ...(hasBody ? { "Content-Type": "application/json" } : {}), ...(opts.headers ?? {}) },
    body: hasBody ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw Object.assign(new Error(data.message || data.error || res.statusText), {
      data, status: res.status,
    });
  }
  return data;
};

const fmt = new Intl.NumberFormat();
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const mb = (b) => !b ? "0 MB"
  : b >= 1073741824 ? `${(b / 1073741824).toFixed(1)} GB` : `${Math.max(1, Math.round(b / 1048576))} MB`;
const day = (ts) => ts ? new Date(ts).toLocaleDateString(undefined,
  { day: "numeric", month: "short" }) : "—";

const SECTIONS = ["scan", "overview", "list", "review", "protectedView", "history", "receipt"];
const show = (id) => {
  for (const s of SECTIONS) $(s).classList.add("hidden");
  $(id).classList.remove("hidden");
  window.scrollTo({ top: 0, behavior: "instant" });
};

// ── State ────────────────────────────────────────────────────────────
let overview = null;
let isDemo = false;
let tab = "overview";
let reviewQueue = [];
let reviewIndex = 0;
let lastBatchId = null;
let readerSender = null;

// ── Navigation ───────────────────────────────────────────────────────

/**
 * Seven items, no more. Counts are only rendered once the data exists, so the
 * nav never shows a zero that is really "not loaded yet".
 */
function renderTabs() {
  if (!overview) return;
  const items = [
    ["overview", "Overview", null],
    ["clean", "Clean", overview.safe.messages],
    ["review", "Review", overview.review.messages],
    ["protected", "Protected", overview.protected.messages],
    ["history", "History", overview.history.cleanups || null],
    ["unsub", "Unsubscribe", null],
    ["settings", "Settings", null],
  ];
  $("tabs").innerHTML = items.map(([id, label, count]) => `
    <button data-tab="${id}" ${tab === id ? 'aria-current="page"' : ""}>
      ${label}${count ? `<span class="count">${fmt.format(count)}</span>` : ""}
    </button>`).join("");
  $("tabs").classList.remove("hidden");
  for (const el of document.querySelectorAll("[data-tab]")) {
    el.onclick = () => goTab(el.dataset.tab);
  }
}

async function goTab(next) {
  tab = next;
  renderTabs();
  if (next === "overview") return renderOverview();
  if (next === "clean") return guarded(renderList)("safe");
  if (next === "review") return guarded(renderList)("review");
  if (next === "protected") return guarded(renderProtected)();
  if (next === "history") return guarded(renderHistory)();
  if (next === "unsub") return guarded(renderUnsub)();
  if (next === "settings") return guarded(renderSettings)();
}

$("goHome").onclick = async () => {
  const scanning = !$("scan").classList.contains("hidden")
    && !$("scanProgress").classList.contains("hidden");
  if (scanning) return;
  try { await loadOverview(); } catch { show("scan"); }
};

// ── Scan ─────────────────────────────────────────────────────────────

$("startScan").onclick = async () => {
  $("startScan").disabled = true;
  $("scanProgress").classList.remove("hidden");
  $("ticker").textContent = "Starting…";
  try {
    const res = await api("/api/scan", { method: "POST" });
    if (res.alreadyRunning) $("ticker").textContent = "A scan is already running — reattaching…";
    streamProgress();
  } catch (err) {
    // Never leave a dead button next to a spinner: an unreported failure is
    // indistinguishable from a hang.
    $("bar").style.width = "0";
    $("ticker").textContent = `Could not start the scan: ${err.message}`;
    $("startScan").disabled = false;
    $("startScan").textContent = "Try again";
  }
};

/**
 * Named stages rather than "Loading…". The percentage is real — it is messages
 * scanned against the scan cap — and the incremental pass shows no bar at all,
 * because a bar that completes before it renders reads as a glitch.
 */
function renderProgress(p) {
  if (p.mode === "incremental") {
    $("bar").style.width = p.done ? "100%" : "55%";
    $("ticker").textContent = p.done
      ? `Up to date — ${fmt.format(p.added ?? 0)} new, ${fmt.format(p.updated ?? 0)} changed.`
      : "Checking what changed since last time…";
    return;
  }
  $("bar").style.width = `${p.done ? 100 : Math.min(98, (p.scanned / 25000) * 100)}%`;
  $("ticker").textContent = p.done
    ? "Grouping senders and deciding what is safe…"
    : `Reading headers — ${fmt.format(p.scanned)} messages, ${mb(p.bytes)} analysed`;
}

function scanFailed(detail) {
  const expired = /reconnect|token|invalid_grant|unauthor/i.test(String(detail));
  $("ticker").innerHTML = expired
    ? 'The Gmail connection expired mid-scan. Nothing was changed. <a href="/auth/google">Reconnect and try again</a>.'
    : "The scan stopped early. Nothing was changed — try again, and tell us if it repeats.";
  $("startScan").disabled = false;
  $("startScan").textContent = "Try again";
}

function streamProgress() {
  if (typeof EventSource === "undefined") return pollProgress();
  const es = new EventSource("/api/scan/stream");
  es.onmessage = async (event) => {
    const p = JSON.parse(event.data);
    renderProgress(p);
    if (p.done && p.state !== "running") {
      es.close();
      if (p.error) return scanFailed(p.error);
      await loadOverview();
    }
  };
  es.onerror = () => { es.close(); pollProgress(); };
}

async function pollProgress() {
  const p = await api("/api/scan/progress");
  renderProgress(p);
  if (p.done && p.state !== "running") {
    if (p.error) return scanFailed(p.error);
    return loadOverview();
  }
  setTimeout(pollProgress, 1200);
}

// ── Errors ───────────────────────────────────────────────────────────

/**
 * Turns a server error into something a person can act on. Raw messages are
 * never shown: they leak implementation detail and tell the user nothing about
 * what to do next.
 *
 * "reconnect_required" is the one every beta user WILL hit — Google expires
 * refresh tokens for apps still under review — so it gets its own reassurance
 * that nothing was changed.
 */
function errorScreen(err) {
  const code = err.data?.error;
  const reconnect = code === "reconnect_required";
  const noAccount = code === "no_account_connected";

  let title, body, action = null;
  if (reconnect) {
    title = "Gmail needs reconnecting";
    body = "Google expires the connection periodically while an app is still under review. Nothing was changed, and nothing was lost.";
    action = ["Reconnect Gmail", "/auth/google"];
  } else if (noAccount) {
    title = "No Gmail account connected";
    body = "Connect an account to get started.";
    action = ["Connect Gmail", "/auth/google"];
  } else if (err.status === 402) {
    title = "You have used your free cleanup";
    body = err.data?.message ?? "Upgrade to keep going.";
    action = ["See plans", "/pricing.html"];
  } else if (err.status >= 500) {
    title = "Something went wrong on our side";
    body = "This has been logged. Trying again usually works — if it keeps happening, tell us.";
  } else {
    title = "Could not load that";
    body = "Check your connection and try again.";
  }

  show("list");
  $("list").innerHTML = `
    <div class="empty">
      <h2>${esc(title)}</h2>
      <p class="lede">${esc(body)}</p>
      <div class="row" style="justify-content:center">
        ${action ? `<a class="btn" href="${action[1]}">${esc(action[0])}</a>` : ""}
        <button id="errRetry">Try again</button>
      </div>
    </div>`;
  $("errRetry").onclick = () => location.reload();
}

/** Wraps a section renderer so no tab can ever fail silently. */
const guarded = (fn) => async (...args) => {
  try { await fn(...args); } catch (err) { errorScreen(err); }
};

// ── Overview ─────────────────────────────────────────────────────────

async function loadOverview() {
  overview = await api("/api/overview");
  tab = "overview";
  renderTabs();
  renderOverview();
}

function renderOverview() {
  const o = overview;
  if (!o) return show("scan");
  show("overview");

  const nothing = o.safe.messages === 0 && o.review.messages === 0;

  $("overview").innerHTML = `
    <div class="verdict">
      ${nothing ? `
        <h1 class="verdict-num">Your inbox is already in good shape</h1>
        <p class="lede">
          Mailwarden read ${fmt.format(o.scanned.messages)} messages and found nothing
          it is confident enough to clean. That is a good outcome, not a failure.
        </p>` : `
        <h1 class="verdict-num">${fmt.format(o.safe.messages)} emails are safe to clean</h1>
        <p class="lede">
          Out of ${fmt.format(o.scanned.messages)} scanned across
          ${fmt.format(o.scanned.senders)} senders. Nothing moves until you approve it.
        </p>`}

      <div class="verdict-guard">
        <span aria-hidden="true">🛡</span>
        <span><strong>${fmt.format(o.protected.messages)}</strong> emails are protected
        and will not be touched.</span>
      </div>

      ${nothing ? "" : `
      <div class="verdict-cta">
        <button class="primary big" id="ctaReview">Review ${fmt.format(o.safe.messages)} safe emails</button>
      </div>
      <p class="hint">Archived mail stays in All Mail and is reversible for 30 days.</p>`}
    </div>

    <div class="triptych">
      ${stateCard("safe", "Safe", o.safe.messages, o.safe.senders, "High confidence")}
      ${stateCard("review", "Review", o.review.messages, o.review.senders, "Needs your decision")}
      ${stateCard("protected", "Protected", o.protected.messages, o.protected.senders, "Mailwarden won't touch these")}
    </div>

    ${o.protected.reasons.length === 0 ? "" : `
    <h2>Why those emails are protected</h2>
    <div class="card" style="padding-top:4px; padding-bottom:4px">
      ${o.protected.reasons.slice(0, 6).map((r) => `
        <div class="reason-row">
          <span>${esc(r.label)}</span>
          <span class="reason-n">${fmt.format(r.messages)}</span>
        </div>`).join("")}
    </div>`}

    <p class="hint" style="margin-top:18px">
      Last scan ${o.scanned.lastScanAt ? day(o.scanned.lastScanAt) : "—"} ·
      ${mb(o.scanned.bytes)} analysed ·
      <button class="link-btn" id="rescan">Scan again</button>
    </p>`;

  if ($("ctaReview")) $("ctaReview").onclick = () => goTab("clean");
  $("rescan").onclick = () => { show("scan"); $("startScan").disabled = false; $("startScan").click(); };
  for (const el of document.querySelectorAll("[data-state]")) {
    el.onclick = () => goTab(el.dataset.state === "protected" ? "protected"
      : el.dataset.state === "safe" ? "clean" : "review");
  }
}

const stateCard = (state, label, messages, senders, note) => `
  <button class="state-card" data-state="${state}">
    <span class="state-tag ${state}">
      <span aria-hidden="true">${state === "safe" ? "✓" : state === "review" ? "?" : "🔒"}</span>
      ${label}
    </span>
    <div class="state-n">${fmt.format(messages)}</div>
    <div class="state-note">${esc(note)}${senders ? ` · ${fmt.format(senders)} sender${senders === 1 ? "" : "s"}` : ""}</div>
  </button>`;

// ── Clean / Review lists ─────────────────────────────────────────────

async function renderList(state) {
  show("list");
  $("list").innerHTML = `<p class="hint">Loading senders…</p>`;

  const { senders } = await api(`/api/senders/state?state=${state}`);
  const actionable = senders.filter((s) => s.actionableCount > 0);

  if (actionable.length === 0) {
    $("list").innerHTML = emptyState(
      state === "safe" ? "Nothing is safe to clean right now"
        : "Nothing is waiting on your decision",
      state === "safe"
        ? "Mailwarden only proposes senders it understands well. When it is unsure, it leaves them alone."
        : "Everything Mailwarden found fell clearly into safe or protected.",
    );
    wireEmpty();
    return;
  }

  const total = actionable.reduce((n, s) => n + s.actionableCount, 0);
  $("list").innerHTML = `
    <h1>${state === "safe" ? "Safe to clean" : "Needs your decision"}</h1>
    <p class="lede">
      ${state === "safe"
        ? `${fmt.format(total)} emails from ${actionable.length} senders Mailwarden understands well.`
        : `${fmt.format(total)} emails Mailwarden is not confident enough to propose. You decide.`}
    </p>
    <div class="row" style="margin-bottom:18px">
      <button class="primary" id="startReview">Go through them one at a time</button>
    </div>
    ${actionable.map((s) => senderCard(s, state)).join("")}`;

  $("startReview").onclick = () => startReview(actionable, state);
  wireSenderCards();
}

function senderCard(s, state) {
  const name = s.displayName || s.senderKey;
  const unread = s.messageCount ? Math.round((s.unreadCount / s.messageCount) * 100) : 0;
  return `
  <article class="sender">
    <div class="sender-top">
      <div>
        <div class="sender-name">${esc(name)}</div>
        <div class="sender-meta">
          ${esc(s.category ?? "unsorted")} · ${mb(s.totalBytes)} · ${unread}% unread
        </div>
      </div>
      <div class="sender-n">${fmt.format(s.actionableCount)}</div>
    </div>

    ${s.evidence.length === 0 ? "" : `
    <ul class="evidence">
      ${s.evidence.map((e) => `<li><span class="mark" aria-hidden="true">✓</span><span>${esc(e)}</span></li>`).join("")}
    </ul>`}

    <div class="sender-actions">
      <button class="primary" data-act="archive" data-key="${esc(s.senderKey)}">
        Archive ${fmt.format(s.actionableCount)}</button>
      <button data-act="read" data-key="${esc(s.senderKey)}">Read</button>
      <button data-act="protect" data-key="${esc(s.senderKey)}">Always protect</button>
      ${s.hasUnsubscribe ? `<button data-act="unsub" data-key="${esc(s.senderKey)}">Unsubscribe</button>` : ""}
    </div>
  </article>`;
}

function wireSenderCards() {
  for (const el of document.querySelectorAll("[data-act]")) {
    el.onclick = () => {
      const { act, key } = el.dataset;
      if (act === "archive") return runSenders([key], "archive");
      if (act === "read") return openReader(key);
      if (act === "protect") return protectSender(el, key);
      if (act === "unsub") return runUnsubscribe(el, key);
    };
  }
}

function emptyState(title, body) {
  return `<div class="empty">
    <h2>${esc(title)}</h2>
    <p class="lede">${esc(body)}</p>
    <button class="primary" id="emptyBack">Back to overview</button>
  </div>`;
}
const wireEmpty = () => { if ($("emptyBack")) $("emptyBack").onclick = () => goTab("overview"); };

// ── Focused review ───────────────────────────────────────────────────

function startReview(queue, state) {
  reviewQueue = queue;
  reviewIndex = 0;
  renderReview(state);
}

/**
 * One sender at a time. The evidence sits above the actions so the decision is
 * made with the reasons in view, and Archive is visually primary because it is
 * the reversible one.
 */
function renderReview(state) {
  show("review");
  const s = reviewQueue[reviewIndex];

  if (!s) {
    $("review").innerHTML = emptyState(
      "That's everything",
      "You have been through every sender in this list.",
    );
    wireEmpty();
    return;
  }

  const name = s.displayName || s.senderKey;
  const pct = ((reviewIndex) / reviewQueue.length) * 100;

  $("review").innerHTML = `
    <div class="review-progress">
      <span>${reviewIndex + 1} of ${reviewQueue.length}</span>
      <button class="link-btn" id="exitReview">Back to the list</button>
    </div>
    <div class="review-bar"><div style="width:${pct}%"></div></div>

    <article class="sender" style="margin-bottom:0">
      <div class="sender-top">
        <div>
          <div class="sender-name" style="font-size:1.15rem">${esc(name)}</div>
          <div class="sender-meta">${esc(s.category ?? "unsorted")} · ${mb(s.totalBytes)}</div>
        </div>
        <div class="sender-n">${fmt.format(s.actionableCount)}</div>
      </div>

      ${s.evidence.length === 0 ? "" : `
      <p class="hint" style="margin:14px 0 4px"><strong>Why Mailwarden thinks these are safe</strong></p>
      <ul class="evidence">
        ${s.evidence.map((e) => `<li><span class="mark" aria-hidden="true">✓</span><span>${esc(e)}</span></li>`).join("")}
      </ul>`}

      <div class="sender-actions" style="margin-top:18px">
        <button class="primary" id="revArchive">Archive all ${fmt.format(s.actionableCount)}</button>
        <button id="revKeep">Keep</button>
        <button id="revRead">Read one</button>
      </div>
      <div class="row" style="margin-top:8px">
        <button class="danger" id="revTrash" style="flex:1">Move all ${fmt.format(s.actionableCount)} to trash</button>
      </div>
      <p class="hint" style="margin-top:10px">
        Archive keeps everything in All Mail and is reversible for 30 days.
        Trash starts Gmail's 30-day deletion clock.
      </p>
    </article>

    <div class="review-nav">
      <button id="revPrev" ${reviewIndex === 0 ? "disabled" : ""}>← Previous</button>
      <button id="revNext">Skip →</button>
    </div>`;

  $("exitReview").onclick = () => goTab(state === "safe" ? "clean" : "review");
  $("revArchive").onclick = () => runSenders([s.senderKey], "archive", () => advance(state));
  $("revTrash").onclick = () => runSenders([s.senderKey], "trash", () => advance(state));
  $("revKeep").onclick = () => protectSender($("revKeep"), s.senderKey, () => advance(state));
  $("revRead").onclick = () => openReader(s.senderKey);
  $("revPrev").onclick = () => { reviewIndex = Math.max(0, reviewIndex - 1); renderReview(state); };
  $("revNext").onclick = () => advance(state);
}

function advance(state) {
  reviewIndex++;
  renderReview(state);
}

// ── Protected ────────────────────────────────────────────────────────

async function renderProtected() {
  show("protectedView");
  const o = overview;
  $("protectedView").innerHTML = `<p class="hint">Loading protected senders…</p>`;

  const { senders } = await api("/api/senders/state?state=protected");

  $("protectedView").innerHTML = `
    <h1>${fmt.format(o.protected.messages)} emails protected</h1>
    <p class="lede">
      Mailwarden left these alone. When it is not confident, it does not act —
      missing some clutter is an acceptable cost, touching something you needed is not.
    </p>

    ${o.protected.reasons.length === 0 ? "" : `
    <div class="card" style="padding-top:4px; padding-bottom:4px">
      ${o.protected.reasons.map((r) => `
        <div class="reason-row">
          <span>${esc(r.label)}</span>
          <span class="reason-n">${fmt.format(r.messages)}</span>
        </div>`).join("")}
    </div>`}

    <h2>Protected senders</h2>
    ${senders.length === 0
      ? `<p class="hint">No senders are protected at the moment.</p>`
      : senders.slice(0, 60).map((s) => `
      <article class="sender">
        <div class="sender-top">
          <div>
            <div class="sender-name">${esc(s.displayName || s.senderKey)}</div>
            <div class="sender-meta">${esc(s.category ?? "unsorted")} · ${mb(s.totalBytes)}</div>
          </div>
          <div class="sender-n">${fmt.format(s.messageCount)}</div>
        </div>
        <ul class="evidence held">
          <li><span class="mark" aria-hidden="true">🔒</span>
              <span>${esc(s.holdReason ?? "Held back by the safety rules.")}</span></li>
        </ul>
        <div class="sender-actions">
          <button data-act="read" data-key="${esc(s.senderKey)}">Read</button>
          ${s.userProtected === 1
            ? `<button data-act="unpin" data-key="${esc(s.senderKey)}">Stop protecting</button>`
            : `<button data-act="release" data-key="${esc(s.senderKey)}">Let me act on this</button>`}
        </div>
      </article>`).join("")}
    ${senders.length > 60 ? `<p class="hint">Showing the 60 largest of ${senders.length}.</p>` : ""}`;

  for (const el of document.querySelectorAll("[data-act]")) {
    el.onclick = () => {
      const { act, key } = el.dataset;
      if (act === "read") return openReader(key);
      if (act === "unpin") return setProtection(el, key, "auto");
      if (act === "release") return setProtection(el, key, "release");
    };
  }
}

// ── History ──────────────────────────────────────────────────────────

async function renderHistory() {
  show("history");
  $("history").innerHTML = `<p class="hint">Loading history…</p>`;
  const { batches } = await api("/api/batches");
  const done = batches.filter((b) => b.status === "done" || b.status === "undone");

  if (done.length === 0) {
    $("history").innerHTML = emptyState(
      "No cleanups yet",
      "Once you clean something, every run is recorded here with an undo button.",
    );
    wireEmpty();
    return;
  }

  $("history").innerHTML = `
    <h1>Cleanup history</h1>
    <p class="lede">
      ${fmt.format(overview.history.messagesCleaned)} emails cleaned across
      ${fmt.format(overview.history.cleanups)} run${overview.history.cleanups === 1 ? "" : "s"}.
      ${overview.history.undone > 0 ? `${overview.history.undone} undone.` : ""}
    </p>
    <div class="card" style="padding-top:4px; padding-bottom:4px">
      ${done.map((b) => `
        <div class="hist-row">
          <div>
            <div><strong>${fmt.format(b.message_count)}</strong>
              ${b.action === "trash" ? "trashed" : "archived"}</div>
            <div class="hint">${day(b.created_at)} · ${mb(b.bytes_freed)}
              ${b.status === "undone" ? " · undone" : ""}</div>
          </div>
          ${b.status === "done"
            ? `<button data-undo="${esc(b.id)}">Undo</button>`
            : `<span class="hint">reversed</span>`}
        </div>`).join("")}
    </div>`;

  for (const el of document.querySelectorAll("[data-undo]")) {
    el.onclick = () => undo(el.dataset.undo, el);
  }
}

// ── Unsubscribe ──────────────────────────────────────────────────────
//
// Deliberately its own section rather than a step inside cleanup. Unsubscribing
// tells a third party something about you, so it stays a separate, per-sender
// decision — and Mailwarden's identity is safe cleanup, not list management.

async function renderUnsub() {
  show("list");
  $("list").innerHTML = `<p class="hint">Loading senders with unsubscribe links…</p>`;

  const [safe, review] = await Promise.all([
    api("/api/senders/state?state=safe"),
    api("/api/senders/state?state=review"),
  ]);
  const all = [...safe.senders, ...review.senders]
    .filter((s) => s.hasUnsubscribe)
    .sort((a, b) => b.messageCount - a.messageCount);

  if (all.length === 0) {
    $("list").innerHTML = emptyState(
      "No senders advertise an unsubscribe link",
      "Mailwarden only offers this where a sender publishes a real unsubscribe header. Archiving them is the alternative.",
    );
    wireEmpty();
    return;
  }

  $("list").innerHTML = `
    <h1>Unsubscribe</h1>
    <p class="lede">
      ${all.length} senders publish a real unsubscribe link. One-click requests are
      sent for you; anything else opens so you can finish it yourself.
    </p>
    <div class="note">
      Mailwarden never sends email on your behalf — it does not ask Google for
      permission to send. Senders that only accept unsubscribes by email open in
      your mail client.
    </div>
    ${all.map((s) => `
      <article class="sender">
        <div class="sender-top">
          <div>
            <div class="sender-name">${esc(s.displayName || s.senderKey)}</div>
            <div class="sender-meta">${esc(s.category ?? "unsorted")} · ${fmt.format(s.messageCount)} emails</div>
          </div>
        </div>
        <div class="sender-actions">
          <button data-act="unsub" data-key="${esc(s.senderKey)}">Unsubscribe</button>
          <button data-act="read" data-key="${esc(s.senderKey)}">Read</button>
        </div>
      </article>`).join("")}`;
  wireSenderCards();
}

// ── Settings ─────────────────────────────────────────────────────────

async function renderSettings() {
  show("list");
  const me = await api("/api/me");
  const { limits } = await api("/api/safety/limits");

  $("list").innerHTML = `
    <h1>Settings</h1>

    <h2>Account</h2>
    <div class="card">
      <p style="margin:0 0 6px"><strong>${esc(me.user.email)}</strong></p>
      <p class="hint" style="margin:0">Plan: ${esc(me.user.plan)} · <a href="/pricing.html">See plans</a></p>
    </div>

    <h2>What Mailwarden will never touch</h2>
    <div class="card">
      <ul class="evidence">
        <li><span class="mark" aria-hidden="true">🔒</span><span>Anything you starred</span></li>
        <li><span class="mark" aria-hidden="true">🔒</span><span>Conversations you replied to</span></li>
        <li><span class="mark" aria-hidden="true">🔒</span><span>Receipts, order confirmations and invoices</span></li>
        <li><span class="mark" aria-hidden="true">🔒</span><span>Login codes, password resets and 2FA</span></li>
        <li><span class="mark" aria-hidden="true">🔒</span><span>Bank, payment and tax mail</span></li>
        <li><span class="mark" aria-hidden="true">🔒</span><span>Flights, hotels and bookings</span></li>
        <li><span class="mark" aria-hidden="true">🔒</span><span>Mail from the last ${limits.recencyProtectionDays} days</span></li>
        <li><span class="mark" aria-hidden="true">🔒</span><span>Anything it does not understand well enough</span></li>
      </ul>
      <p class="hint" style="margin:12px 0 0">
        Attachments and Gmail-important mail are never <em>trashed</em>; they can still be archived,
        which is reversible.
      </p>
    </div>

    <h2>Protected senders</h2>
    <div class="card">
      <p class="hint" style="margin:0">
        Pin any sender from the Clean or Protected list to protect it permanently.
        Domain-level rules (for example <code>@bank.com</code>) are not implemented yet.
      </p>
    </div>

    <h2>Privacy</h2>
    <div class="card">
      <ul class="evidence">
        <li><span class="mark" aria-hidden="true">✓</span><span>Mailwarden cannot permanently delete anything — Google does not grant it that ability</span></li>
        <li><span class="mark" aria-hidden="true">✓</span><span>Sorting uses headers only: sender, date, size, and Gmail's own labels</span></li>
        <li><span class="mark" aria-hidden="true">✓</span><span>Subjects are stored as a salted hash, never as text</span></li>
        <li><span class="mark" aria-hidden="true">✓</span><span>A message is fetched only when you open it, and is never saved</span></li>
        <li><span class="mark" aria-hidden="true">✓</span><span>No message content is ever sent to a model</span></li>
      </ul>
      <p class="hint" style="margin:12px 0 0">
        <a href="/api/audit">Your full audit log</a> records every action taken on your account.
      </p>
    </div>`;
}

// ── Actions ──────────────────────────────────────────────────────────

async function runSenders(senderKeys, action, after) {
  const planOnce = async (confirmed) => {
    try {
      return await api("/api/batches/plan", {
        method: "POST", body: { action, senderKeys, confirmed },
      });
    } catch (err) {
      if (err.status === 409) return err.data;   // a guard verdict, not a failure
      throw err;
    }
  };
  try {
    await confirmAndRun(await planOnce(false), () => planOnce(true), after);
  } catch (err) {
    if (err.status === 402) return upgradePrompt(err.data.message);
    alert(`Could not continue: ${err.message}`);
  }
}

/**
 * The consent gate. It reports the server's verdict rather than recomputing
 * anything, so what the user approves is exactly what will run.
 */
async function confirmAndRun(plan, replan, after) {
  const violations = plan.violations ?? [];
  const blocking = violations.filter((v) => v.severity === "block");

  const byCode = {};
  for (const e of plan.exclusions ?? []) {
    byCode[e.code] ??= { count: 0, reason: e.reason };
    byCode[e.code].count += e.messageCount;
  }

  $("confirmBody").innerHTML = `
    <p style="font-size:1.02rem; margin-bottom:10px">
      <strong>${fmt.format(plan.messageCount)}</strong> emails will be
      ${plan.action === "trash" ? "moved to trash" : "archived"}.
    </p>
    ${violations.filter((v) => v.severity === "confirm")
      .map((v) => `<div class="note warn">${esc(v.message)}</div>`).join("")}
    ${blocking.map((v) => `<div class="note danger">${esc(v.message)}</div>`).join("")}

    ${Object.keys(byCode).length === 0 ? "" : `
    <div class="note safe">
      <strong>Kept safe automatically</strong>
      <ul>${Object.values(byCode).map((g) =>
        `<li>${fmt.format(g.count)} — ${esc(g.reason)}</li>`).join("")}</ul>
    </div>`}

    ${plan.action === "trash" ? `<div class="note danger">
      <strong>Trash is the one action with a deadline.</strong> Gmail permanently
      removes trashed mail after 30 days and then nobody can recover it.
      Archive clears your inbox just as well and never expires.
    </div>` : ""}

    ${isDemo ? `<div class="note warn">Demo inbox: this stops before the Gmail call.</div>` : ""}
    <p class="hint">${plan.action === "trash"
      ? "You can restore it from Gmail's Trash, or undo the whole run below."
      : "Archived mail stays in All Mail and stays searchable."} You get an Undo button next.</p>`;

  const runnable = blocking.length === 0 && plan.messageCount > 0;
  $("reallyConfirm").disabled = !runnable;
  $("reallyConfirm").textContent = runnable
    ? (plan.action === "trash" ? "Move to trash" : "Archive them") : "Blocked";
  $("confirmDialog").showModal();

  $("reallyConfirm").onclick = async () => {
    $("reallyConfirm").disabled = true;
    try {
      const finalPlan = await replan();
      if (!finalPlan.batchId) throw new Error(finalPlan.violations?.[0]?.message ?? "Blocked.");
      const done = await api(`/api/batches/${finalPlan.batchId}/execute`, { method: "POST" });
      lastBatchId = finalPlan.batchId;
      $("confirmDialog").close();
      overview = await api("/api/overview");
      renderTabs();
      if (after) after();
      else showReceipt(done);
    } catch (err) {
      $("confirmDialog").close();
      if (err.status === 402) upgradePrompt(err.data.message);
      else if (err.status === 409) alert(`Stopped by the safety policy: ${err.data.message}`);
      else alert(`Could not complete: ${err.message}`);
    } finally {
      $("reallyConfirm").disabled = false;
    }
  };
}

$("cancelConfirm").onclick = () => $("confirmDialog").close();

function showReceipt(done) {
  show("receipt");
  $("receipt").innerHTML = `
    <h1>Cleanup complete</h1>
    <p class="lede">
      ${fmt.format(done.messageCount)} emails
      ${done.action === "trash" ? "moved to trash" : "archived"} ·
      ${mb(done.bytesFreed)} freed.
    </p>
    <div class="note safe">
      <strong>0 protected emails were touched.</strong>
      ${done.action === "trash"
        ? "Trashed mail stays in Gmail for 30 days — restore it there, or undo the whole run."
        : "Archived mail is still in All Mail and fully searchable. Nothing was deleted."}
    </div>
    <div class="row" style="margin-top:18px">
      <button class="primary big" id="rcDone">Back to overview</button>
      <button class="big" id="rcUndo">Undo this cleanup</button>
    </div>
    <p class="hint" id="rcNote" style="margin-top:12px"></p>`;

  $("rcDone").onclick = () => goTab("overview");
  $("rcUndo").onclick = () => undo(lastBatchId, $("rcUndo"));
}

/**
 * Undo reports what the server VERIFIED, not what it attempted. The server
 * reads Gmail back after restoring, so `restored` means confirmed-in-place.
 */
async function undo(batchId, button) {
  if (!batchId) return;
  button.disabled = true;
  button.textContent = "Undoing…";
  try {
    const r = await api(`/api/batches/${batchId}/undo`, { method: "POST" });
    const note = $("rcNote");
    const parts = [`Restored ${fmt.format(r.restored)} emails.`];
    if (r.mismatched) parts.push(`${fmt.format(r.mismatched)} did not match and were left alone.`);
    if (r.missing) parts.push(`${fmt.format(r.missing)} are no longer in Gmail.`);
    if (!r.verified) parts.push("We could not verify the result against Gmail.");
    const msg = parts.join(" ");
    if (note) note.textContent = msg; else alert(msg);
    button.textContent = "Undone";
    overview = await api("/api/overview");
    renderTabs();
  } catch (err) {
    button.disabled = false;
    button.textContent = "Undo";
    alert(`Could not undo: ${err.message}`);
  }
}

async function protectSender(button, senderKey, after) {
  button.disabled = true;
  try {
    await api("/api/senders/protection", { method: "POST", body: { senderKey, state: "pin" } });
    overview = await api("/api/overview");
    renderTabs();
    if (after) after(); else { button.textContent = "Protected"; }
  } catch (err) {
    button.disabled = false;
    alert(`Could not protect: ${err.message}`);
  }
}

async function setProtection(button, senderKey, state) {
  button.disabled = true;
  try {
    await api("/api/senders/protection", { method: "POST", body: { senderKey, state } });
    overview = await api("/api/overview");
    renderTabs();
    await renderProtected();
  } catch (err) {
    button.disabled = false;
    alert(`Could not change protection: ${err.message}`);
  }
}

/** Unsubscribe is per-sender and never bulk — it tells a third party about you. */
async function runUnsubscribe(button, senderKey) {
  button.disabled = true;
  button.textContent = "Unsubscribing…";
  try {
    const r = await api(`/api/senders/${encodeURIComponent(senderKey)}/unsubscribe`, { method: "POST" });
    if (r.url) window.open(r.url, "_blank", "noopener,noreferrer");
    button.textContent = r.status === "sent" ? "Unsubscribed" : "Open unsubscribe";
    button.disabled = r.status === "sent";
    alert(r.message);
  } catch (err) {
    button.disabled = false;
    button.textContent = "Unsubscribe";
    alert(`Could not unsubscribe: ${err.message}`);
  }
}

function upgradePrompt(message) {
  if (confirm(`${message}\n\nOpen the plans page?`)) window.location.href = "/pricing.html";
}

// ── Reading mail ─────────────────────────────────────────────────────
// Content is fetched live and never stored — not by the server, and not here
// beyond the open dialog.

async function openReader(senderKey) {
  readerSender = senderKey;
  $("readerTitle").textContent = senderKey;
  $("readerBody").innerHTML = `<p class="hint">Loading…</p>`;
  $("readerDialog").showModal();
  try {
    const { messages } = await api(`/api/senders/${encodeURIComponent(senderKey)}/messages?limit=20`);
    if (messages.length === 0) {
      $("readerBody").innerHTML = `<p class="hint">No messages found for this sender.</p>`;
      return;
    }
    $("readerBody").innerHTML = `
      <p class="hint" style="margin-top:0">Fetched from Gmail just now. Nothing here is saved.</p>
      ${messages.map((m) => `
        <button class="msg" data-msg="${esc(m.messageId)}">
          <span class="msg-sub">${m.unread ? "● " : ""}${esc(m.subject)}</span>
          <span class="msg-meta">${new Date(m.date).toLocaleDateString()} · ${mb(m.sizeBytes)}</span>
          <span class="msg-snip">${esc(m.snippet.slice(0, 130))}</span>
        </button>`).join("")}`;
    for (const el of document.querySelectorAll("[data-msg]")) {
      el.onclick = () => openMessage(el.dataset.msg);
    }
  } catch (err) {
    $("readerBody").innerHTML = `<p class="hint">Could not load: ${esc(err.message)}</p>`;
  }
}

async function openMessage(id) {
  $("readerBody").innerHTML = `<p class="hint">Loading message…</p>`;
  try {
    const m = await api(`/api/messages/${encodeURIComponent(id)}`);
    $("readerBody").innerHTML = `
      <button class="link-btn" id="backToList">← All messages from this sender</button>
      <h3 style="margin:12px 0 4px">${esc(m.subject)}</h3>
      <p class="hint" style="margin-bottom:12px">
        ${esc(m.from)} · ${new Date(m.date).toLocaleString()}
        ${m.convertedFromHtml ? " · shown as plain text" : ""}
      </p>
      <pre class="msg-body">${esc(m.text)}</pre>`;
    $("backToList").onclick = () => openReader(readerSender);
  } catch (err) {
    $("readerBody").innerHTML = `<p class="hint">Could not open: ${esc(err.message)}</p>`;
  }
}

$("closeReader").onclick = () => $("readerDialog").close();

// ── Boot ─────────────────────────────────────────────────────────────

(async () => {
  try {
    const me = await api("/api/me");
    isDemo = me.demo === true;
    if (isDemo) $("demoBanner").classList.remove("hidden");
    $("plan").textContent = `${me.user.email} · ${me.user.plan}`;
    if (me.account?.last_sync_at) {
      try { await loadOverview(); } catch (err) { errorScreen(err); }
    } else {
      show("scan");
    }
  } catch {
    window.location.href = "/";
  }
})();
