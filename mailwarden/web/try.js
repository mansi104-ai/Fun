/**
 * Mailwarden sandbox client — /try.html.
 *
 * NOTHING HERE DECIDES ANYTHING. Every category, confidence, reason, guard
 * name, hold reason and bar length comes from a value the server produced by
 * running the real classifier and the real guard layer. This file lays out a
 * result; it does not know what the result should be.
 *
 * Same CSP constraint as app.js: external file, never an inline <script>. The
 * charts are CSS boxes for the same reason — `default-src 'self'` blocks every
 * charting library on every CDN.
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
    throw Object.assign(new Error(data.message || data.error || res.statusText), { status: res.status });
  }
  return data;
};

const fmt = new Intl.NumberFormat();
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const kb = (b) => `${Math.max(1, Math.round(b / 1024))} KB`;
const pct = (n) => `${Math.round(n * 100)}%`;
const plural = (n, one, many) => (n === 1 ? one : many);

const ago = (ts, now) => {
  const days = Math.max(0, Math.round((now - ts) / 86400000));
  if (days === 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 60) return `${days}d ago`;
  if (days < 730) return `${Math.round(days / 30)}mo ago`;
  return `${(days / 365).toFixed(1)}y ago`;
};

let LIBRARY = [];
let LIMITS = { maxCustom: 10, maxTotal: 30, maxSubject: 300 };

const inbox = new Set();

/**
 * Messages the visitor wrote. Each carries a `body`, and `payload()` strips it
 * before anything is sent — that omission is the claim this page makes, in the
 * one place a reader can check it.
 */
const drafts = new Map();
let draftSeq = 0;

const byId = (id) => drafts.get(id) ?? LIBRARY.find((m) => m.id === id);
const inboxItems = () => [...[...inbox].map(byId), ...drafts.values()].filter(Boolean);

/** Exactly the fields Gmail would hand the server. Note the absent body. */
const payload = (d) => ({
  id: d.id, senderKey: d.senderKey, senderName: d.senderName, subject: d.subject,
  ageDays: d.ageDays, sizeKb: d.sizeKb, labels: d.labels, unread: d.unread,
  hasUnsubscribe: d.hasUnsubscribe, starred: d.starred, hasAttachment: d.hasAttachment,
  important: d.important, youRepliedInThread: d.youRepliedInThread,
});

// ── Panes ────────────────────────────────────────────────────────────────

const GROUPS = [
  { id: "bulk", title: "Clutter" },
  { id: "tricky", title: "Looks like clutter" },
];

const tagsFor = (m) => [
  ...m.labels.map((l) => l.replace("CATEGORY_", "")),
  ...(m.unread ? ["UNREAD"] : []),
  ...(m.starred ? ["STARRED"] : []),
  ...(m.important ? ["IMPORTANT"] : []),
  ...(m.hasAttachment ? ["ATTACHMENT"] : []),
  ...(m.hasUnsubscribe ? ["UNSUB"] : []),
];

function libraryCard(m) {
  const added = inbox.has(m.id);
  return `
    <div class="mail ${added ? "added" : ""}">
      <span>
        <span class="line mail-from">${esc(m.senderName)}</span>
        <span class="line mail-subject">${esc(m.subject)}</span>
        <span class="line mail-meta">${esc(m.senderKey)} · ${esc(m.ageDays)}d · ${esc(m.sizeKb)} KB</span>
      </span>
      <button class="mini ${added ? "" : "solid"}" type="button"
              data-add="${esc(m.id)}" ${added ? "disabled" : ""}>${added ? "Added" : "Add"}</button>
    </div>`;
}

function inboxCard(m) {
  return `
    <div class="mail">
      <span>
        <span class="line mail-from">${esc(m.senderName)}
          ${m.custom ? `<span class="tag">YOURS</span>` : ""}</span>
        <span class="line mail-subject">${esc(m.subject) || "<em class='mail-meta'>(no subject)</em>"}</span>
        <span class="line mail-meta">${esc(m.senderKey)}</span>
        ${m.body ? `<span class="line mail-body">${esc(m.body)}</span>` : ""}
        <span class="line">${tagsFor(m).map((t) => `<span class="tag">${esc(t)}</span>`).join("")}</span>
      </span>
      <button class="mini" type="button" data-remove="${esc(m.id)}"
              aria-label="Remove ${esc(m.subject || "untitled message")}">Remove</button>
    </div>`;
}

function renderLibrary() {
  document.getElementById("library").innerHTML = GROUPS.map((g) => `
    <div class="group-h">${esc(g.title)}</div>
    <div class="mail-list">
      ${LIBRARY.filter((m) => m.group === g.id).map(libraryCard).join("")}
    </div>`).join("");
}

function renderInbox() {
  const items = inboxItems();
  document.getElementById("inbox").innerHTML = items.length
    ? `<div class="mail-list">${items.map(inboxCard).join("")}</div>`
    : `<p class="empty">Empty</p>`;

  const n = items.length;
  document.getElementById("inbox-count").textContent = n ? `(${fmt.format(n)})` : "";
  document.getElementById("selection-note").textContent =
    n === 0 ? "" : `${fmt.format(n)} ${plural(n, "message", "messages")}`;
  for (const b of document.querySelectorAll("[data-run]")) b.disabled = n === 0;

  const addBtn = document.getElementById("draft-add");
  if (addBtn) addBtn.disabled = drafts.size >= LIMITS.maxCustom;
}

// ── Compose ──────────────────────────────────────────────────────────────

/** The field list is the metadata Gmail returns — the form is the disclosure. */
const CATEGORIES = [
  ["", "Primary"],
  ["CATEGORY_PROMOTIONS", "Promotions"],
  ["CATEGORY_SOCIAL", "Social"],
  ["CATEGORY_UPDATES", "Updates"],
  ["CATEGORY_FORUMS", "Forums"],
];

const FLAGS = [
  ["unread", "Unread"],
  ["hasUnsubscribe", "Unsubscribe header"],
  ["starred", "Starred"],
  ["hasAttachment", "Attachment"],
  ["important", "Important"],
  ["youRepliedInThread", "You replied"],
];

function composeForm() {
  return `
    <h3 style="margin:0 0 10px">Write your own</h3>

    <div class="form-grid">
      <label class="f"><span>From</span>
        <input id="d-name" type="text" placeholder="Acme Deals" maxlength="120"></label>
      <label class="f"><span>Address</span>
        <input id="d-email" type="text" placeholder="deals@acme.com" maxlength="200"
               inputmode="email" autocomplete="off"></label>
      <label class="f"><span>Subject</span>
        <input id="d-subject" type="text" placeholder="50% off everything"
               maxlength="${LIMITS.maxSubject}"></label>
      <label class="f"><span>Tab</span>
        <select id="d-cat">
          ${CATEGORIES.map(([v, t]) => `<option value="${v}">${esc(t)}</option>`).join("")}
        </select></label>
      <label class="f"><span>Days old</span>
        <input id="d-age" type="number" value="90" min="0" max="5000"></label>
      <label class="f"><span>Size (KB)</span>
        <input id="d-size" type="number" value="80" min="1" max="50000"></label>
    </div>

    <fieldset class="flags">
      ${FLAGS.map(([k, label]) => `
        <label class="flag">
          <input type="checkbox" data-flag="${k}" ${k === "unread" ? "checked" : ""}>
          <span>${esc(label)}</span>
        </label>`).join("")}
    </fieldset>

    <div class="stays">
      <label class="f"><span>Body <b class="stays-tag">not sent</b></span>
        <textarea id="d-body" rows="2" placeholder="Never leaves your browser."></textarea></label>
    </div>

    <div class="btn-row" style="margin-top:12px">
      <button class="btn" type="button" id="draft-add">Add to inbox</button>
      <span class="muted" id="draft-error" role="alert"></span>
    </div>`;
}

/** Mirrors the server's check so a typo is a sentence, not a silently dropped row. */
const EMAIL = /^[^\s@,;<>"]{1,64}@[^\s@.,;<>"]{1,63}(?:\.[^\s@.,;<>"]{1,63})+$/;

function readDraft() {
  const val = (id) => (document.getElementById(id)?.value ?? "").trim();
  const email = val("d-email").toLowerCase();
  if (!EMAIL.test(email)) return { error: "Needs a valid sender address." };

  const cat = val("d-cat");
  const flags = {};
  for (const el of document.querySelectorAll("[data-flag]")) flags[el.dataset.flag] = el.checked;

  return {
    draft: {
      id: `custom-${++draftSeq}${Math.random().toString(36).slice(2, 8)}`,
      senderKey: email,
      senderName: val("d-name") || email,
      subject: val("d-subject"),
      body: val("d-body"),
      ageDays: Math.max(0, Math.min(5000, Number(val("d-age")) || 0)),
      sizeKb: Math.max(1, Math.min(50000, Number(val("d-size")) || 1)),
      labels: cat ? [cat] : [],
      ...flags,
      custom: true,
    },
  };
}

function renderCompose() {
  const el = document.getElementById("compose");
  // Rendered once: re-rendering on every add would wipe a half-typed draft.
  if (el && !el.dataset.ready) { el.innerHTML = composeForm(); el.dataset.ready = "1"; }
}

const renderPanes = () => { renderLibrary(); renderInbox(); renderCompose(); };

// ── Charts ───────────────────────────────────────────────────────────────

/** The withheld text is genuinely not in this element — nothing to reveal. */
const redactionBar = (text, cap = 30) => {
  const w = Math.min(100, Math.max(12, (String(text).length / cap) * 100));
  return `<span class="bar" style="width:${w.toFixed(0)}%"></span>`;
};

function splitBar(held, moved) {
  const total = held + moved;
  if (total === 0) return "";
  const w = (n) => `${((n / total) * 100).toFixed(1)}%`;
  return `
    <div class="keys">
      <span class="key held"><i></i>${fmt.format(held)} protected</span>
      <span class="key moved"><i></i>${fmt.format(moved)} cleaned</span>
    </div>
    <div class="split" role="img"
         aria-label="${fmt.format(held)} of ${fmt.format(total)} protected, ${fmt.format(moved)} cleaned">
      ${held ? `<span class="s-held" style="width:${w(held)}" title="${fmt.format(held)} protected"></span>` : ""}
      ${moved ? `<span class="s-moved" style="width:${w(moved)}" title="${fmt.format(moved)} cleaned"></span>` : ""}
    </div>`;
}

function guardBars(guards, held) {
  const hit = guards
    .filter((g) => g.hits.length)
    .map((g) => ({ id: g.id, title: g.title, n: g.hits.reduce((s, h) => s + h.messageCount, 0) }))
    .sort((a, b) => b.n - a.n);
  if (!hit.length) return "";

  const max = Math.max(...hit.map((g) => g.n));
  // These do not decompose the held pile: a message can trip several guards, so
  // the bars sum to more than the number held. Saying so is cheaper than a
  // reader finding the discrepancy and distrusting every other number here.
  const overlap = hit.reduce((a, g) => a + g.n, 0) - held;

  return `
    ${overlap > 0 ? `<p class="note" style="margin:0 0 4px">${fmt.format(overlap)}
       counted twice — some messages trip more than one guard.</p>` : ""}
    <div class="bars">
      ${hit.map((g) => `
        <div class="bar-row" title="${esc(g.id)} ${esc(g.title)}: ${fmt.format(g.n)}">
          <span class="bar-label"><b>${esc(g.id)}</b> ${esc(g.title)}</span>
          <span class="bar-track"><span class="bar-fill" style="width:${((g.n / max) * 100).toFixed(1)}%"></span></span>
          <span class="bar-n">${fmt.format(g.n)}</span>
        </div>`).join("")}
    </div>`;
}

// ── Result stages ────────────────────────────────────────────────────────

function stageRedaction(t) {
  const stored = t.ingest.rows.filter((r) => !r.labels.split(",").includes("SENT"));
  const r = t.redaction;

  const pair = (row) => {
    const m = byId(row.id);
    if (!m) return "";
    return `
      <div class="redact-pair">
        <div class="doc">
          <div class="field"><span class="field-k">From</span>
            <span class="field-v">${esc(m.senderName)} &lt;${esc(m.senderKey)}&gt;</span></div>
          <div class="field"><span class="field-k">Subject</span>
            <span class="field-v">${esc(m.subject)}</span></div>
          <div class="field"><span class="field-k">Body</span>
            <span class="field-v">${esc(m.body) || `<span class="note">(none)</span>`}</span></div>
        </div>
        <div class="arrow-col" aria-hidden="true">→</div>
        <div class="doc kept">
          <div class="field"><span class="field-k">From</span>
            <span class="field-v">${esc(row.senderKey)}</span></div>
          <div class="field"><span class="field-k">Subject</span>
            <span class="field-v">${redactionBar(m.subject)}
              <span class="mono">${esc(row.subjectHash)}</span>
              <span class="line note">hashed</span></span></div>
          <div class="field"><span class="field-k">Body</span>
            <span class="field-v">${m.body ? redactionBar(m.body, 60) : ""}
              <span class="line note">${m.custom ? "never left your browser" : "never requested"}</span></span></div>
          <div class="field"><span class="field-k">Rest</span>
            <span class="field-v mono">${esc(row.labels)} · ${esc(kb(row.sizeBytes))} · ${esc(ago(row.internalDate, t.now))}</span></div>
        </div>
      </div>`;
  };

  return `
    <div class="stage">
      <h2>Stored</h2>
      <p class="note" style="margin:-8px 0 12px">
        <code>format: ${esc(r.fetchFormat)}</code> ·
        ${r.headersRequested.map((h) => `<code>${esc(h)}</code>`).join(" ")}
      </p>
      ${stored.map(pair).join("")}
    </div>`;
}

function stageClassify(t) {
  return `
    <div class="stage">
      <h2>Senders</h2>
      ${t.senders.map(({ facts: f, verdict: v }) => `
        <div class="row">
          <div><strong>${esc(f.displayName || f.senderKey)}</strong>
            <span class="muted">· ${esc(f.senderKey)}</span></div>
          <div style="margin:3px 0 5px">
            <span class="${v.protectedSender ? "verdict-protected" : "verdict-clean"}">${esc(v.category)}</span>
            <span class="muted">· ${esc(pct(v.confidence))} ·
              ${v.protectedSender ? "protected" : "actionable"}</span>
          </div>
          <div style="font-size:.88rem">${esc(v.reason)}</div>
          <div class="mono muted" style="margin-top:5px">
            ${fmt.format(f.messageCount)} ${plural(f.messageCount, "msg", "msgs")} ·
            ${fmt.format(f.unreadCount)} unread ·
            ${fmt.format(f.distinctSubjectHashes)} ${plural(f.distinctSubjectHashes, "template", "templates")} ·
            unsub ${f.hasUnsubscribe ? "yes" : "no"} ·
            replied ${f.userReplied ? "yes" : "no"}
          </div>
        </div>`).join("")}
    </div>`;
}

function stageGuards(t) {
  const fired = t.guards.filter((g) => g.fired);
  const idle = t.guards.filter((g) => !g.fired);

  const guardRow = (g) => `
    <div class="guard ${g.fired ? "hit" : "idle"}">
      <span class="guard-id">${esc(g.id)}</span>
      <div class="guard-body">
        <div class="guard-title">${esc(g.title)}
          <span class="chip ${g.fired && g.severity === "block" ? "block" : g.fired ? "held" : ""}">${esc(g.severity)}</span>
        </div>
        ${g.message ? `<div class="guard-detail">${esc(g.message)}</div>` : ""}
        ${g.hits.map((h) => `
          <div class="guard-detail"><strong>${esc(h.senderKey)}</strong> —
            ${fmt.format(h.messageCount)} held. ${esc(h.reason)}</div>`).join("")}
      </div>
    </div>`;

  return `
    <div class="stage">
      <h2>Guardrails</h2>
      ${guardBars(t.guards, t.outcome.held.length)}
      ${fired.map(guardRow).join("")}
      ${idle.length ? `
        <details class="more">
          <summary>${fmt.format(idle.length)} more checked, no match</summary>
          ${idle.map(guardRow).join("")}
        </details>` : ""}
    </div>`;
}

function stageOutcome(t) {
  const name = (id) => {
    const m = byId(id);
    return m ? `${m.senderName} — ${m.subject || "(no subject)"}` : id;
  };

  const blocked = t.guards.some((g) => g.fired && g.severity === "block");
  const moved = t.outcome.moving.length;
  const held = t.outcome.held.length;

  const banner = blocked
    ? `<div class="callout danger"><strong>Refused.</strong> Nothing moves.</div>`
    : t.outcome.requiresConfirmation
      ? `<div class="callout" style="border-color:var(--held-ink)">
           <strong>Needs confirmation.</strong> Nothing decided yet.
           <p style="margin:8px 0 0"><button class="btn" type="button"
              data-confirm="${esc(t.action)}">Yes, ${esc(t.action)}</button></p>
         </div>`
      : `<div class="callout safe">${esc(t.outcome.reversal)}</div>`;

  return `
    <div class="stage">
      <h2>Result</h2>
      <div class="tiles">
        <div class="tile held"><div class="tile-n">${fmt.format(held)}</div>
          <div class="tile-k">held back</div></div>
        <div class="tile ${blocked ? "refused" : ""}">
          <div class="tile-n">${blocked ? "0" : fmt.format(moved)}</div>
          <div class="tile-k">${blocked ? "refused" : t.action === "trash" ? "trashed" : "archived"}</div></div>
        <div class="tile"><div class="tile-n">${fmt.format(t.ingest.candidateCount)}</div>
          <div class="tile-k">considered</div></div>
      </div>
      ${blocked ? "" : splitBar(held, moved)}
      ${banner}
      ${moved && !blocked ? `
        <h3>${t.action === "trash" ? "Trashed" : "Archived"}</h3>
        ${t.outcome.moving.map((m) => `<div class="row">${esc(name(m.id))}</div>`).join("")}` : ""}
      ${held ? `
        <h3 style="margin-top:18px">Held back</h3>
        ${t.outcome.held.map((h) => `
          <div class="row">
            <div>${esc(name(h.id))}</div>
            ${h.by.map((b) => `
              <div style="margin-top:3px">
                <span class="chip held">${esc(b.id)} ${esc(b.code)}</span>
                <span class="muted" style="font-size:.84rem">${esc(b.reason)}</span>
              </div>`).join("")}
          </div>`).join("")}` : ""}
    </div>`;
}

function renderTrace(t) {
  const el = document.getElementById("result");
  el.className = "card";
  el.innerHTML = stageRedaction(t) + stageClassify(t) + stageGuards(t) + stageOutcome(t);
  el.scrollIntoView({ behavior: "smooth", block: "start" });
}

// ── Wiring ───────────────────────────────────────────────────────────────

async function run(action, confirmed) {
  const el = document.getElementById("result");
  el.className = "card";
  el.innerHTML = `<p class="muted">Running…</p>`;
  try {
    renderTrace(await api("/api/demo/run", {
      method: "POST",
      body: { ids: [...inbox], custom: [...drafts.values()].map(payload), action, confirmed },
    }));
  } catch (err) {
    el.innerHTML = `<p class="callout danger">${esc(err.message)}</p>`;
  }
}

document.addEventListener("click", (e) => {
  const add = e.target.closest("[data-add]");
  if (add) { inbox.add(add.dataset.add); return void renderPanes(); }

  const remove = e.target.closest("[data-remove]");
  if (remove) {
    inbox.delete(remove.dataset.remove);
    drafts.delete(remove.dataset.remove);
    return void renderPanes();
  }

  const pick = e.target.closest("[data-pick]");
  if (pick) {
    if (pick.dataset.pick === "all") for (const m of LIBRARY) inbox.add(m.id);
    else { inbox.clear(); drafts.clear(); }
    return void renderPanes();
  }

  if (e.target.closest("#draft-add")) {
    const { draft, error } = readDraft();
    const slot = document.getElementById("draft-error");
    if (error) { slot.textContent = error; return; }
    slot.textContent = "";
    drafts.set(draft.id, draft);
    for (const id of ["d-name", "d-email", "d-subject", "d-body"]) {
      const f = document.getElementById(id);
      if (f) f.value = "";
    }
    return void renderInbox();
  }

  const runBtn = e.target.closest("[data-run]");
  if (runBtn) return void run(runBtn.dataset.run, false);

  // Re-runs the same request rather than executing a stored plan, mirroring the
  // real app: a clean plan is never an authorisation on its own.
  const confirmBtn = e.target.closest("[data-confirm]");
  if (confirmBtn) return void run(confirmBtn.dataset.confirm, true);
});

/**
 * The catch covers the FETCH only, never the render.
 *
 * With `renderPanes()` inside the success handler, any bug in rendering landed
 * in the same catch and told the visitor "could not load samples" — blaming
 * the network for a fault in this file, which is the kind of error message
 * that costs an afternoon. A render fault now surfaces as an unhandled
 * rejection in the console, where it belongs.
 */
api("/api/demo/inbox").then(
  (data) => {
    LIBRARY = data.messages;
    if (data.limits) LIMITS = { ...LIMITS, ...data.limits };
    return true;
  },
  () => false,
).then((loaded) => {
  if (!loaded) {
    document.getElementById("library").innerHTML =
      `<p class="callout danger">Could not load samples. Reload to retry.</p>`;
    return;
  }
  renderPanes();
});
