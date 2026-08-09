/**
 * Mailwarden app client.
 *
 * This lives in its own file rather than inline in app.html for a hard reason,
 * not a stylistic one: the production CSP is `default-src 'self'` with no
 * script-src, which blocks inline scripts outright. Inlined, this code silently
 * did nothing in production — the page rendered, every asset returned 200, and
 * not one API call was ever made.
 *
 * Do NOT move it back into the HTML, and do NOT "fix" a future CSP violation by
 * adding 'unsafe-inline'. smoke.ts fails the build if an inline <script> with a
 * body reappears in web/.
 */
const $ = (id) => document.getElementById(id);

/**
 * The Content-Type header is set ONLY when there is a body to describe.
 *
 * Sending `Content-Type: application/json` with an empty body makes Fastify
 * reject the request outright with FST_ERR_CTP_EMPTY_JSON_BODY — a 400 before
 * the handler ever runs. Every bodyless POST in this app hit that: starting a
 * scan, executing a batch, and undoing one. The scan button simply hung on
 * "Connecting…" because the rejection was never surfaced.
 */
const api = async (url, opts = {}) => {
  const hasBody = opts.body !== undefined && opts.body !== null;
  const res = await fetch(url, {
    ...opts,
    headers: {
      ...(hasBody ? { "Content-Type": "application/json" } : {}),
      ...(opts.headers ?? {}),
    },
    body: hasBody ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.message || data.error || res.statusText), { data, status: res.status });
  return data;
};

const fmt = new Intl.NumberFormat();
const esc = (s) => String(s).replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const mb = (b) => b >= 1073741824 ? `${(b / 1073741824).toFixed(1)} GB` : `${Math.round(b / 1048576)} MB`;
const since = (ts) => ts ? new Date(ts).toLocaleDateString(undefined, { month: "short", year: "numeric" }) : "—";

const show = (id) => {
  for (const s of ["scan", "home", "job", "receipt", "review"]) $(s).classList.add("hidden");
  $(id).classList.remove("hidden");
  $("tray").classList.add("hidden");
  window.scrollTo({ top: 0, behavior: "instant" });
};

let senders = [];
let selection = new Map();
let showAll = false;
let lastBatchId = null;
let currentRecipe = null;
let isDemo = false;
let categories = [];
let currentCat = null;
/** Sender keys the user unticked in the current category. Narrows only. */
let excluded = new Set();
let reviewCat = "";

// ── Screen 1: scan ───────────────────────────────────────────────────
$("startScan").onclick = async () => {
  $("startScan").disabled = true;
  $("scanProgress").classList.remove("hidden");
  $("ticker").textContent = "Starting…";
  try {
    const res = await api("/api/scan", { method: "POST" });
    // A scan already running is not an error — reattach to it rather than
    // telling the user nothing happened.
    if (res.alreadyRunning) $("ticker").textContent = "A scan is already running — reattaching…";
    streamProgress();
  } catch (err) {
    // Never leave the button dead with a spinner. An unreported failure here
    // is indistinguishable from a hang, which is exactly how the empty-body
    // 400 stayed invisible.
    $("bar").style.width = "0";
    $("ticker").textContent = `Could not start the scan: ${err.message}`;
    $("startScan").disabled = false;
    $("startScan").textContent = "Try again";
  }
};

function renderProgress(p) {
  // An incremental pass finishes in seconds and touches a handful of messages,
  // so a 0–25,000 bar would sit at 0% and read as a hang. Different job,
  // different indicator.
  if (p.mode === "incremental") {
    $("bar").style.width = p.done ? "100%" : "60%";
    $("ticker").textContent = p.done
      ? `Up to date — ${fmt.format(p.added ?? 0)} new, ${fmt.format(p.updated ?? 0)} changed.`
      : "Checking what's changed since last time…";
    return;
  }
  $("bar").style.width = `${p.done ? 100 : Math.min(98, (p.scanned / 25000) * 100)}%`;
  $("ticker").textContent = p.done
    ? "Grouping senders…"
    : `${fmt.format(p.scanned)} messages · ${mb(p.bytes)} attributed`;
}

function streamProgress() {
  if (typeof EventSource === "undefined") return pollProgress();
  const es = new EventSource("/api/scan/stream");
  es.onmessage = async (event) => {
    const p = JSON.parse(event.data);
    renderProgress(p);
    if (p.done && p.state !== "running") {
      es.close();
      if (p.error) { $("ticker").textContent = `Scan failed: ${p.error}`; return; }
      await loadHome();
    }
  };
  es.onerror = () => { es.close(); pollProgress(); };
}

async function pollProgress() {
  const p = await api("/api/scan/progress");
  renderProgress(p);
  if (p.done && p.state !== "running") {
    if (p.error) { $("ticker").textContent = `Scan failed: ${p.error}`; return; }
    return loadHome();
  }
  setTimeout(pollProgress, 1200);
}

// ── Screen 2: categories + the tool grid ─────────────────────────────
async function loadHome() {
  const [cats, { recipes }] = await Promise.all([
    api("/api/categories"),
    api("/api/recipes"),
  ]);

  categories = cats.categories;
  const inbox = cats.inbox;

  $("stats").innerHTML = `
    <div class="stat"><div class="n">${fmt.format(inbox.messages)}</div><div class="l">emails scanned</div></div>
    <div class="stat"><div class="n">${mb(inbox.bytes)}</div><div class="l">storage used</div></div>
    <div class="stat"><div class="n">${fmt.format(cats.cleanableTotal)}</div><div class="l">safe to clean</div></div>`;

  renderCategoryPicker();
  renderCategoryList();

  $("tiles").innerHTML = recipes.map(tileHtml).join("");
  for (const el of document.querySelectorAll("[data-recipe]")) {
    el.onclick = () => openJob(el.dataset.recipe);
  }
  show("home");
}

/**
 * The dropdown. Split into two optgroups so the protected categories are
 * visible and explained rather than quietly missing — a user who cannot find
 * "Banking" in the list assumes we failed to scan it.
 */
function renderCategoryPicker() {
  const present = categories.filter((c) => c.totalMessages > 0);
  const open = present.filter((c) => !c.isProtected);
  const held = present.filter((c) => c.isProtected);

  const opt = (c) => {
    const tail = c.cleanableMessages > 0
      ? `${fmt.format(c.cleanableMessages)} to clean`
      : c.isProtected ? "protected" : "nothing to clean";
    return `<option value="${c.id}">${c.icon}  ${esc(c.label)} — ${fmt.format(c.totalMessages)} emails · ${tail}</option>`;
  };

  $("catSelect").innerHTML =
    (open.length ? `<optgroup label="Safe to clean">${open.map(opt).join("")}</optgroup>` : "") +
    (held.length ? `<optgroup label="Protected — shown for reference">${held.map(opt).join("")}</optgroup>` : "") ||
    `<option value="">Nothing scanned yet</option>`;

  // Default to whichever category has the most to clean: the fastest win.
  if (!currentCat || !present.some((c) => c.id === currentCat)) {
    currentCat = (open.slice().sort((a, b) => b.cleanableMessages - a.cleanableMessages)[0]
      ?? present[0])?.id ?? null;
  }
  if (currentCat) $("catSelect").value = currentCat;
  renderCategoryPanel();
}

$("catSelect").onchange = (e) => {
  currentCat = e.target.value;
  excluded.clear();          // a new category starts with everything ticked
  renderCategoryPanel();
};

function currentCategory() {
  return categories.find((c) => c.id === currentCat) ?? null;
}

/** Sender keys currently ticked, i.e. what a run would actually target. */
function includedSenders(c) {
  return c.senders.filter((s) => s.cleanableCount > 0 && !excluded.has(s.senderKey));
}

function renderCategoryPanel() {
  const c = currentCategory();
  if (!c) {
    $("catPanel").innerHTML = `<p class="sub" style="margin:0">Run a scan to see your categories.</p>`;
    return;
  }

  const picked = includedSenders(c);
  const count = picked.reduce((s, x) => s + x.cleanableCount, 0);
  const bytes = picked.reduce((s, x) => s + Math.round(x.totalBytes * (x.cleanableCount / (x.messageCount || 1))), 0);
  const partial = picked.length !== c.cleanableSenders;

  const heldNote = c.heldMessages > 0
    ? `<div class="safe-box">
         <b>${fmt.format(c.heldMessages)}</b> of these are being kept safe automatically:
         <ul style="margin:7px 0 0; padding-left:19px">
           ${c.heldReasons.map((r) => `<li>${esc(r)}</li>`).join("")}
         </ul>
       </div>` : "";

  const splitNote = c.needsSplit
    ? `<div class="warn-box">This category is larger than one safe batch. Untick some senders
       below and run it in a couple of passes.</div>` : "";

  const body = c.isProtected
    ? `<div class="safe-box" style="margin-top:18px">
         Mailwarden never bulk-cleans this category — it is where receipts, codes,
         tickets and bank mail live. To act on one specific sender, open
         <b>Review sender by sender</b> and release it there.
       </div>`
    : count === 0
      ? `<div class="cat-num">Nothing to clean</div>
         <div class="cat-sub">${c.totalMessages > 0
            ? "Everything here is protected, too recent, or unticked below."
            : "No senders landed in this category."}</div>`
      : `<div class="cat-num">${fmt.format(count)} emails</div>
         <div class="cat-sub">
           from ${picked.length} sender${picked.length === 1 ? "" : "s"} · frees about ${mb(bytes)}
           ${partial ? ` · <b>${c.cleanableSenders - picked.length} unticked</b>` : ""}
         </div>
         <div class="cat-actions">
           <button class="primary big-btn" id="catArchive">Archive ${fmt.format(count)} emails</button>
           <button class="big-btn danger" id="catTrash">Move to trash instead</button>
         </div>
         <p class="excl" style="margin-top:11px">Reversible for 30 days. Nothing is permanently deleted.</p>`;

  $("catPanel").innerHTML = `
    <div class="cat-head">
      <span class="icon">${c.icon}</span>
      <div>
        <h2>${esc(c.label)}</h2>
        <p>${esc(c.blurb)}</p>
      </div>
    </div>
    ${body}
    ${splitNote}
    ${heldNote}
    ${senderPickerHtml(c)}`;

  if ($("catArchive")) $("catArchive").onclick = () => runCategory(c.id, "archive");
  if ($("catTrash")) $("catTrash").onclick = () => runCategory(c.id, "trash");
  wireSenderPicker();
}

/**
 * Per-sender ticks inside a category. Unticking can only ever *narrow* the
 * batch — the server recomputes membership and intersects, so this control
 * cannot be used to pull in a sender the category does not contain.
 */
function senderPickerHtml(c) {
  if (c.senders.length === 0) return "";
  const rows = c.senders.map((s) => {
    const held = s.cleanableCount === 0;
    const unreadPct = s.messageCount ? Math.round((s.unreadCount / s.messageCount) * 100) : 0;
    const detail = held
      ? esc(s.holdReason ?? "Held back by the safety rules.")
      : `${fmt.format(s.cleanableCount)} of ${fmt.format(s.messageCount)} · ${mb(s.totalBytes)} · ${unreadPct}% unread`;
    return `
      <label class="pick ${held ? "held" : ""}">
        <input type="checkbox" data-sender="${esc(s.senderKey)}"
               ${held ? "disabled" : excluded.has(s.senderKey) ? "" : "checked"} />
        <span class="who"><b>${esc(s.displayName || s.senderKey)}</b><span>${detail}</span></span>
      </label>`;
  }).join("");

  return `
    <details class="senders-pick">
      <summary><span>Choose which senders (${c.senderCount})</span></summary>
      <div class="pick-tools">
        <button id="pickAll">Tick all</button>
        <button id="pickNone">Untick all</button>
      </div>
      <div class="pick-list">${rows}</div>
    </details>`;
}

function wireSenderPicker() {
  for (const el of document.querySelectorAll("[data-sender]")) {
    el.onchange = () => {
      if (el.checked) excluded.delete(el.dataset.sender);
      else excluded.add(el.dataset.sender);
      refreshPanelHeader();
    };
  }
  const c = currentCategory();
  if ($("pickAll")) $("pickAll").onclick = () => { excluded.clear(); reopenPanel(); };
  if ($("pickNone")) $("pickNone").onclick = () => {
    for (const s of c.senders) if (s.cleanableCount > 0) excluded.add(s.senderKey);
    reopenPanel();
  };
}

/** Keeps the picker expanded across a re-render so the list doesn't collapse. */
function reopenPanel() {
  renderCategoryPanel();
  const d = document.querySelector("details.senders-pick");
  if (d) d.open = true;
}

/**
 * Updates only the headline numbers on a tick, rather than re-rendering — a
 * full re-render would close the picker and lose the user's scroll position.
 */
function refreshPanelHeader() {
  const c = currentCategory();
  if (!c) return;
  const picked = includedSenders(c);
  const count = picked.reduce((s, x) => s + x.cleanableCount, 0);
  const num = document.querySelector(".cat-num");
  const sub = document.querySelector(".cat-sub");
  if (num) num.textContent = count === 0 ? "Nothing selected" : `${fmt.format(count)} emails`;
  if (sub) {
    const unticked = c.cleanableSenders - picked.length;
    sub.innerHTML = `from ${picked.length} sender${picked.length === 1 ? "" : "s"}` +
      (unticked > 0 ? ` · <b>${unticked} unticked</b>` : "");
  }
  for (const id of ["catArchive", "catTrash"]) {
    const b = $(id);
    if (!b) continue;
    b.disabled = count === 0;
    if (id === "catArchive") b.textContent = `Archive ${fmt.format(count)} emails`;
  }
}

async function runCategory(id, action) {
  const c = currentCategory();
  const keys = includedSenders(c).map((s) => s.senderKey);
  if (keys.length === 0) return;

  const planOnce = async (confirmed) => {
    try {
      return await api(`/api/categories/${id}/plan`, {
        method: "POST", body: { action, senderKeys: keys, confirmed },
      });
    } catch (err) {
      if (err.status === 409) return err.data;   // guard verdict, not a failure
      throw err;
    }
  };

  try {
    await confirmAndRun(await planOnce(false), () => planOnce(true));
  } catch (err) {
    alert(err.status === 402 ? err.data.message : `Something went wrong: ${err.message}`);
  }
}

/** The browsable list. Every category appears, protected ones included. */
function renderCategoryList() {
  const present = categories.filter((c) => c.totalMessages > 0);
  $("catList").innerHTML = present.map((c) => `
    <button class="cat-row ${c.isProtected ? "locked" : ""}" data-cat="${c.id}">
      <span class="ic">${c.icon}</span>
      <span class="lb">${esc(c.label)}<small>${fmt.format(c.totalMessages)} emails · ${c.senderCount} sender${c.senderCount === 1 ? "" : "s"} · ${mb(c.totalBytes)}</small></span>
      <span class="rt">${c.isProtected
        ? `<b>Protected</b><small>kept safe</small>`
        : c.cleanableMessages > 0
          ? `<b>${fmt.format(c.cleanableMessages)}</b><small>can be cleaned</small>`
          : `<b style="color:var(--muted);font-weight:500">—</b><small>nothing to clean</small>`}</span>
    </button>`).join("");

  for (const el of document.querySelectorAll("[data-cat]")) {
    el.onclick = () => {
      currentCat = el.dataset.cat;
      excluded.clear();
      $("catSelect").value = currentCat;
      renderCategoryPanel();
      $("catPanel").scrollIntoView({ behavior: "smooth", block: "center" });
    };
  }
}

function tileHtml(r) {
  const empty = r.messageCount === 0;
  return `
  <button class="tile ${empty ? "empty" : ""}" data-recipe="${r.id}" ${empty ? "disabled" : ""}>
    <div class="icon">${r.icon}</div>
    <div class="title">${esc(r.title)}</div>
    <div class="blurb">${esc(r.blurb)}</div>
    <div class="count">${empty ? "Nothing found" : fmt.format(r.messageCount) + " emails"}</div>
    ${empty ? "" : `<div class="meta">${mb(r.bytes)} · ${r.senderCount} sender${r.senderCount === 1 ? "" : "s"}</div>`}
  </button>`;
}

// ── Screen 3: one job, one button ────────────────────────────────────
async function openJob(recipeId) {
  const { recipes } = await api("/api/recipes");
  const r = recipes.find((x) => x.id === recipeId);
  if (!r) return;
  currentRecipe = r;

  $("jobIcon").textContent = r.icon;
  $("jobCount").textContent = `${fmt.format(r.messageCount)} emails`;
  $("jobSub").textContent = `${r.blurb} Frees about ${mb(r.bytes)}.`;
  $("jobSenders").innerHTML =
    r.sampleSenders.map((s) => `<div class="sender-line"><span>${esc(s)}</span></div>`).join("") +
    (r.senderCount > r.sampleSenders.length
      ? `<div class="sender-line"><span class="excl">and ${r.senderCount - r.sampleSenders.length} more sender(s)</span></div>`
      : "");
  $("jobNotes").innerHTML = `
    <div class="safe-box">
      Receipts, boarding passes, login codes, bank mail, and anyone you've replied
      to are protected and excluded automatically — even if they look like
      marketing. Mail from the last 7 days is left alone too.
    </div>`;
  $("jobRun").textContent = `Archive ${fmt.format(r.messageCount)} emails`;
  $("jobRun").disabled = false;
  show("job");
}

$("jobBack").onclick = () => loadHome();

$("jobRun").onclick = async () => {
  if (!currentRecipe) return;
  $("jobRun").disabled = true;
  try {
    const plan = await planRecipe(currentRecipe.id, false);
    await confirmAndRun(plan, () => planRecipe(currentRecipe.id, true));
  } catch (err) {
    alert(err.status === 402 ? err.data.message : `Something went wrong: ${err.message}`);
  } finally {
    $("jobRun").disabled = false;
  }
};

async function planRecipe(id, confirmed) {
  try {
    return await api(`/api/recipes/${id}/plan`, { method: "POST", body: { confirmed } });
  } catch (err) {
    if (err.status === 409) return err.data;   // guard verdict, not a failure
    throw err;
  }
}

/**
 * The consent gate. The server has already applied the guardrails; this screen
 * reports the server's own verdict rather than recomputing anything locally.
 */
async function confirmAndRun(plan, replan) {
  const exclusions = plan.exclusions ?? [];
  const violations = plan.violations ?? [];
  const blocking = violations.filter((v) => v.severity === "block");

  const byCode = {};
  for (const e of exclusions) {
    byCode[e.code] ??= { count: 0, senders: 0, reason: e.reason };
    byCode[e.code].count += e.messageCount;
    byCode[e.code].senders += 1;
  }

  $("confirmBody").innerHTML = `
    <div style="font-size:1.05rem; margin-bottom:6px">
      <strong>${fmt.format(plan.messageCount)}</strong> emails will be ${plan.action === "trash" ? "moved to trash" : "archived"}.
    </div>
    ${violations.filter((v) => v.severity === "confirm").map((v) => `<div class="warn-box">${esc(v.message)}</div>`).join("")}
    ${blocking.map((v) => `<div class="warn-box" style="border-left-color:var(--danger)">${esc(v.message)}</div>`).join("")}
    ${Object.entries(byCode).map(([, g]) =>
      `<div class="excl"><b>Kept safe:</b> ${fmt.format(g.count)} email(s) from ${g.senders} sender(s) — ${esc(g.reason)}</div>`).join("")}
    ${isDemo ? `<div class="warn-box">Demo inbox: this will stop at the Gmail call, because no mailbox is connected.</div>` : ""}
    <p class="excl" style="margin-top:14px">
      ${plan.action === "trash"
        ? "Trash stays in Gmail for 30 days and you can restore it there."
        : "Archived mail stays in All Mail and remains fully searchable."}
      You'll get an Undo button next.</p>`;

  const runnable = blocking.length === 0 && plan.messageCount > 0;
  $("reallyConfirm").disabled = !runnable;
  $("reallyConfirm").textContent = runnable ? `Yes, ${plan.action} them` : "Blocked";
  $("confirmDialog").showModal();

  $("reallyConfirm").onclick = async () => {
    $("reallyConfirm").disabled = true;
    try {
      // Re-plan with confirmed:true so the server re-runs its own guards.
      const finalPlan = await replan();
      if (!finalPlan.batchId) throw new Error(finalPlan.violations?.[0]?.message ?? "Blocked.");
      const done = await api(`/api/batches/${finalPlan.batchId}/execute`, { method: "POST" });
      lastBatchId = finalPlan.batchId;
      $("confirmDialog").close();
      showReceipt(done.messageCount, done.bytesFreed, done.action);
    } catch (err) {
      $("confirmDialog").close();
      if (err.status === 402) alert(err.data.message);
      else if (err.status === 409) alert(`Blocked by the safety policy: ${err.data.message}`);
      else alert(`Could not complete: ${err.message}`);
    } finally {
      $("reallyConfirm").disabled = false;
    }
  };
}

$("cancelConfirm").onclick = () => $("confirmDialog").close();

// ── Screen 4: receipt ────────────────────────────────────────────────
function showReceipt(messages, bytes, action) {
  $("receiptCount").textContent = `${fmt.format(messages)} emails ${action === "trash" ? "trashed" : "archived"}`;
  $("receiptDetail").textContent = `${mb(bytes)} of Gmail storage reclaimed.`;
  $("receiptNote").textContent = action === "trash"
    ? "Trashed mail stays in Gmail for 30 days — restore it there, or undo the whole batch below."
    : "Archived mail is still in All Mail and fully searchable. Nothing was deleted.";
  $("undoBtn").disabled = false;
  $("undoBtn").textContent = "Undo everything";
  selection.clear();
  show("receipt");
}

$("undoBtn").onclick = async () => {
  if (!lastBatchId) return;
  $("undoBtn").disabled = true;
  const { restored, failed } = await api(`/api/batches/${lastBatchId}/undo`, { method: "POST" });
  $("receiptNote").textContent = failed
    ? `Restored ${fmt.format(restored)} emails. ${fmt.format(failed)} could not be restored — they are still in Gmail under All Mail or Trash.`
    : `Restored ${fmt.format(restored)} emails to where they were.`;
  $("undoBtn").textContent = failed ? "Retry undo" : "Undone";
  $("undoBtn").disabled = !failed;
};

$("doneBtn").onclick = () => loadHome();

// ── Advanced: sender by sender ───────────────────────────────────────
$("toAdvanced").onclick = () => loadSenders();
$("advBack").onclick = () => loadHome();

async function loadSenders() {
  senders = (await api("/api/senders")).senders;
  // Deep-linking straight here skips loadHome, so make sure we have the labels.
  if (categories.length === 0) categories = (await api("/api/categories")).categories;
  const total = senders.reduce((s, x) => s + x.messageCount, 0);
  $("reviewTitle").textContent = `${fmt.format(senders.length)} senders`;
  $("reviewSub").textContent = `${fmt.format(total)} emails. Decide once per sender — everything is reversible for 30 days.`;

  // Same category vocabulary as the home screen, so the two views agree.
  const counts = new Map();
  for (const s of senders) {
    const k = s.category ?? "unknown";
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  $("revCat").innerHTML =
    `<option value="">All categories (${senders.length} senders)</option>` +
    categories
      .filter((c) => counts.has(c.id))
      .map((c) => `<option value="${c.id}">${c.icon}  ${esc(c.label)} — ${counts.get(c.id)} senders</option>`)
      .join("");
  $("revCat").value = reviewCat;

  show("review");
  renderSenders();
  renderTray();
}

$("revCat").onchange = (e) => { reviewCat = e.target.value; renderSenders(); };

function renderSenders() {
  let list = showAll ? senders : senders.filter((s) => s.suggested || s.protected);
  if (reviewCat) list = list.filter((s) => (s.category ?? "unknown") === reviewCat);
  $("senders").innerHTML = list.map(cardHtml).join("");

  for (const el of document.querySelectorAll("[data-act]")) {
    el.onclick = () => {
      const { key, act } = el.dataset;
      if (act === "keep") selection.delete(key); else selection.set(key, act);
      renderSenders(); renderTray();
    };
  }
  for (const el of document.querySelectorAll("[data-pin]")) {
    el.onclick = async () => {
      const { key, pin } = el.dataset;
      el.disabled = true;
      await api("/api/senders/protection", { method: "POST", body: { senderKey: key, state: pin } });
      if (pin === "pin") selection.delete(key);
      senders = (await api("/api/senders")).senders;
      renderSenders(); renderTray();
    };
  }
}

function cardHtml(s) {
  const chosen = selection.get(s.senderKey);
  const unreadPct = s.messageCount ? Math.round((s.unreadCount / s.messageCount) * 100) : 0;
  const pin = s.userProtected === 1
    ? `<button data-key="${s.senderKey}" data-pin="auto">Unpin</button>`
    : `<button data-key="${s.senderKey}" data-pin="pin">Pin as protected</button>`;
  const release = s.protected && s.userProtected !== 1 && s.category !== "personal"
    ? `<button data-key="${s.senderKey}" data-pin="release">Let me act on this</button>` : "";

  const controls = s.protected
    ? `<span class="lock-note">Locked — nothing here will be touched in bulk.</span>
       <div class="actions" style="margin-top:8px">${release}${pin}</div>`
    : `<div class="actions">
         <button data-key="${s.senderKey}" data-act="keep">Keep</button>
         <button data-key="${s.senderKey}" data-act="archive">Archive all ${fmt.format(s.messageCount)}</button>
         <button data-key="${s.senderKey}" data-act="trash" class="danger">Trash all ${fmt.format(s.messageCount)}</button>
         ${pin}
       </div>`;

  return `
  <div class="card ${chosen ? "selected" : ""} ${s.protected ? "locked" : ""}">
    <div class="card-top">
      <span class="name">${esc(s.displayName || s.senderKey)}</span>
      <span class="tags">
        <span class="tag ${s.protected ? "protected" : ""}">${esc(s.category ?? "unknown")}</span>
        ${s.protected ? '<span class="tag protected">protected</span>' : ""}
        ${chosen ? `<span class="tag">${chosen}</span>` : ""}
      </span>
    </div>
    <div class="stats-line">${fmt.format(s.messageCount)} emails · ${mb(s.totalBytes)} · ${unreadPct}% unread · since ${since(s.firstSeen)}</div>
    <div class="reason">${esc(s.reason ?? "")}</div>
    ${controls}
  </div>`;
}

$("filterSuggested").onclick = () => { showAll = false; renderSenders(); };
$("filterAll").onclick = () => { showAll = true; renderSenders(); };
$("selectSuggested").onclick = () => {
  // Respects the category filter — "select all suggested" while looking at one
  // category must not silently reach into the others.
  for (const s of senders) {
    if (reviewCat && (s.category ?? "unknown") !== reviewCat) continue;
    if (s.suggested && !s.protected) selection.set(s.senderKey, "archive");
  }
  renderSenders(); renderTray();
};
$("clearSel").onclick = () => { selection.clear(); renderSenders(); renderTray(); };

function renderTray() {
  if (selection.size === 0 || $("review").classList.contains("hidden")) {
    return $("tray").classList.add("hidden");
  }
  const chosen = senders.filter((s) => selection.has(s.senderKey));
  const messages = chosen.reduce((sum, s) => sum + s.messageCount, 0);
  const archiving = chosen.filter((s) => selection.get(s.senderKey) === "archive").length;
  $("trayText").innerHTML =
    `<strong>${fmt.format(messages)} emails</strong> from ${chosen.length} senders` +
    `<br><span style="color:var(--muted); font-size:.85rem">${archiving} to archive, ${chosen.length - archiving} to trash · nothing permanently deleted</span>`;
  $("tray").classList.remove("hidden");
}

$("confirmBtn").onclick = async () => {
  const groups = { archive: [], trash: [] };
  for (const [key, act] of selection) groups[act].push(key);
  const action = groups.trash.length > 0 && groups.archive.length === 0 ? "trash" : "archive";
  const keys = groups[action];
  if (keys.length === 0) return;

  const planOnce = async (confirmed) => {
    try {
      return await api("/api/batches/plan", { method: "POST", body: { action, senderKeys: keys, confirmed } });
    } catch (err) {
      if (err.status === 409) return err.data;
      throw err;
    }
  };

  try {
    await confirmAndRun(await planOnce(false), () => planOnce(true));
  } catch (err) {
    alert(err.status === 402 ? err.data.message : `Something went wrong: ${err.message}`);
  }
};

// ── Boot ─────────────────────────────────────────────────────────────
(async () => {
  try {
    const me = await api("/api/me");
    isDemo = me.demo === true;
    if (isDemo) $("demoBanner").classList.remove("hidden");
    $("plan").textContent = `${me.user.email} · ${me.user.plan}`;
    if (me.account?.last_sync_at) await loadHome();
    else show("scan");
  } catch {
    location.href = "/";
  }
})();
