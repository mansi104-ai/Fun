/**
 * Mailwarden sandbox client — /try.html.
 *
 * Renders a test inbox, posts the chosen message ids to /api/demo/run, and
 * prints the trace the server sent back.
 *
 * The rule this file follows, and the reason the page is worth anything:
 * NOTHING HERE DECIDES ANYTHING. Every category, confidence, reason, guard
 * name and hold reason on screen is a string the server produced by running
 * the real classifier and the real guard layer. This file knows how to lay out
 * a result; it does not know what the result should be. If it started
 * inferring — colouring a row by guessing which sender "looks protected", say —
 * the page would become an illustration of the safety model rather than an
 * observation of it, and the whole exercise would be worthless.
 *
 * Same CSP constraint as app.js: external file, never an inline <script>.
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

/** "412 days ago" reads as evidence; a date the reader has to subtract does not. */
const ago = (ts, now) => {
  const days = Math.max(0, Math.round((now - ts) / 86400000));
  if (days === 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 60) return `${days} days ago`;
  if (days < 730) return `${Math.round(days / 30)} months ago`;
  return `${(days / 365).toFixed(1)} years ago`;
};

let INBOX = [];
const selected = new Set();

// ── Step 1: the picker ───────────────────────────────────────────────────

const GROUPS = [
  {
    id: "bulk",
    title: "Everyday clutter",
    blurb: "Marketing, digests and social noise — the mail the product exists to clear.",
  },
  {
    id: "tricky",
    title: "The ones that look like clutter",
    blurb:
      "Every message here sits in a Gmail tab that cleanup tools sweep, and every one " +
      "of them is something you would be upset to lose. This is the half that matters.",
  },
];

function mailCard(m) {
  const tags = [
    ...m.labels.map((l) => l.replace("CATEGORY_", "")),
    ...(m.unread ? ["UNREAD"] : []),
    ...(m.starred ? ["STARRED"] : []),
    ...(m.important ? ["IMPORTANT"] : []),
    ...(m.hasAttachment ? ["ATTACHMENT"] : []),
    ...(m.hasUnsubscribe ? ["LIST-UNSUBSCRIBE"] : []),
  ];
  return `
    <button class="mail" type="button" data-id="${esc(m.id)}"
            aria-pressed="${selected.has(m.id)}">
      <span class="tick" aria-hidden="true">✓</span>
      <span>
        <span class="line">
          <span class="mail-from">${esc(m.senderName)}</span>
          <span class="mail-meta"> · ${esc(m.senderKey)}</span>
        </span>
        <span class="line mail-subject">${esc(m.subject)}</span>
        <span class="line mail-meta">${esc(m.ageDays)} days old · ${esc(m.sizeKb)} KB</span>
        <span class="line">${tags.map((t) => `<span class="tag">${esc(t)}</span>`).join("")}</span>
        <span class="line mail-note">${esc(m.note)}</span>
      </span>
    </button>`;
}

function renderPicker() {
  document.getElementById("picker").innerHTML = GROUPS.map((g) => `
    <div class="mail-group">
      <h3 style="margin-bottom:2px">${esc(g.title)}</h3>
      <p class="muted" style="margin-bottom:10px">${esc(g.blurb)}</p>
      <div class="mail-list">
        ${INBOX.filter((m) => m.group === g.id).map(mailCard).join("")}
      </div>
    </div>`).join("");
  syncSelectionNote();
}

function syncSelectionNote() {
  for (const el of document.querySelectorAll(".mail")) {
    el.setAttribute("aria-pressed", String(selected.has(el.dataset.id)));
  }
  const n = selected.size;
  document.getElementById("selection-note").textContent = n === 0
    ? "Nothing selected yet."
    : `${fmt.format(n)} message${n === 1 ? "" : "s"} in the test inbox.`;
  for (const b of document.querySelectorAll("[data-run]")) b.disabled = n === 0;
}

// ── Step 3: the trace ────────────────────────────────────────────────────

/** Stage 1 — what a sync would have written down, and what it threw away. */
function stageIngest(t) {
  const inbound = t.ingest.rows.filter((r) => !r.labels.split(",").includes("SENT"));
  const sent = t.ingest.rows.length - inbound.length;

  return `
    <div class="stage">
      <span class="stage-n">STAGE 1 / 4</span>
      <h2 style="margin-top:4px">What Mailwarden wrote down</h2>
      <p class="muted">
        This is the whole record kept for each message. There is no column for
        the body, and the subject is replaced by a salted hash on the way in —
        kept only so repeated templates from one sender are countable, and
        useless for reading anything back.
        ${sent ? `A reply of yours was found in ${fmt.format(sent)} thread${sent === 1 ? "" : "s"}; that matters at stage 3.` : ""}
      </p>
      <div class="scroll-x">
        <table>
          <thead><tr>
            <th>Subject (discarded)</th><th>Stored as</th><th>Received</th>
            <th>Size</th><th>Gmail labels</th>
          </tr></thead>
          <tbody>
            ${inbound.map((r) => `
              <tr>
                <td>${esc(r.subject)}</td>
                <td class="mono">${esc(r.subjectHash)}</td>
                <td>${esc(ago(r.internalDate, t.now))}</td>
                <td>${esc(kb(r.sizeBytes))}</td>
                <td class="mono">${esc(r.labels)}</td>
              </tr>`).join("")}
          </tbody>
        </table>
      </div>
    </div>`;
}

/** Stage 2 — the aggregate facts, and the verdict the classifier reached. */
function stageClassify(t) {
  const TIER = {
    heuristic: "settled by a local rule — never sent anywhere",
    "model-unavailable": "local rules declined; took the model-unavailable path",
    "too-small": "too little evidence to judge — left alone",
  };

  return `
    <div class="stage">
      <span class="stage-n">STAGE 2 / 4</span>
      <h2 style="margin-top:4px">What the classifier saw, and what it concluded</h2>
      <p class="muted">
        Decisions are made per <em>sender</em>, not per message, from counted
        facts only. The row below each verdict is the complete input — it is
        also the only thing that would ever be sent to a language model, which
        is why there is no subject and no text in it.
      </p>
      ${t.senders.map((s) => {
        const f = s.facts;
        const v = s.verdict;
        return `
        <div class="row">
          <div><strong>${esc(f.displayName || f.senderKey)}</strong>
            <span class="muted">· ${esc(f.senderKey)}</span></div>
          <div style="margin:4px 0 6px">
            <span class="${v.protectedSender ? "verdict-protected" : "verdict-clean"}">
              ${esc(v.category)}</span>
            <span class="muted">· ${esc(pct(v.confidence))} confidence ·
              ${v.protectedSender ? "protected" : "actionable"}</span>
          </div>
          <div style="font-size:.89rem">${esc(v.reason)}</div>
          <div class="mono muted" style="margin-top:6px">
            ${fmt.format(f.messageCount)} messages ·
            ${fmt.format(f.unreadCount)} unread ·
            ${fmt.format(f.distinctSubjectHashes)} distinct subject templates ·
            unsubscribe header: ${f.hasUnsubscribe ? "yes" : "no"} ·
            you have written back: ${f.userReplied ? "yes" : "no"}
          </div>
          <div class="muted" style="font-size:.8rem;margin-top:4px">
            ${esc(TIER[s.tier] || s.tier)}
          </div>
        </div>`;
      }).join("")}
    </div>`;
}

/** Stage 3 — the roster, including every guard that checked and let it pass. */
function stageGuards(t) {
  const fired = t.guards.filter((g) => g.fired);
  const idle = t.guards.filter((g) => !g.fired);

  const guardRow = (g) => `
    <div class="guard ${g.fired ? "hit" : "idle"}">
      <span class="guard-id">${esc(g.id)}</span>
      <div class="guard-body">
        <div class="guard-title">${esc(g.title)}
          <span class="chip ${g.fired ? (g.severity === "block" ? "block" : "held") : ""}">${esc(g.severity)}</span>
        </div>
        ${g.message ? `<div class="guard-detail">${esc(g.message)}</div>` : ""}
        ${g.hits.map((h) => `
          <div class="guard-detail">
            <strong>${esc(h.senderKey)}</strong> — ${fmt.format(h.messageCount)}
            message${h.messageCount === 1 ? "" : "s"} held. ${esc(h.reason)}
          </div>`).join("")}
        ${g.fired ? "" : `<div class="guard-detail">Checked. Nothing in this batch matched.</div>`}
      </div>
    </div>`;

  return `
    <div class="stage">
      <span class="stage-n">STAGE 3 / 4</span>
      <h2 style="margin-top:4px">The guardrails</h2>
      <p class="muted">
        Every change to a mailbox in Mailwarden goes through one function, and
        this is its full output — including the ${fmt.format(idle.length)} guards
        that found nothing to stop. A guard either narrows the batch, asks for a
        second confirmation, or refuses it outright.
      </p>
      ${fired.map(guardRow).join("")}
      ${idle.length ? `<h3 style="margin:18px 0 0">Also checked</h3>${idle.map(guardRow).join("")}` : ""}
    </div>`;
}

/** Stage 4 — the answer, per message, with the guard that produced it. */
function stageOutcome(t) {
  const byId = new Map(INBOX.map((m) => [m.id, m]));
  const name = (id) => {
    const m = byId.get(id);
    return m ? `${m.senderName} — ${m.subject}` : id;
  };

  const blocked = t.guards.some((g) => g.fired && g.severity === "block");

  const banner = blocked
    ? `<div class="callout danger">
         <strong>Refused.</strong> Nothing would move. The batch failed a
         blocking guard, and Mailwarden fails closed — it does not run the part
         of a batch that was legal.
       </div>`
    : t.outcome.requiresConfirmation
      ? `<div class="callout warn">
           <strong>Paused for confirmation.</strong> The batch is legal but
           unusually broad, so it needs a second, explicit yes. Nothing has been
           decided yet.
         </div>
         <p><button class="btn" type="button" data-confirm="${esc(t.action)}">
           Yes, ${esc(t.action)} them</button></p>`
      : `<div class="callout safe">${esc(t.outcome.reversal)}</div>`;

  return `
    <div class="stage">
      <span class="stage-n">STAGE 4 / 4</span>
      <h2 style="margin-top:4px">The result</h2>
      <p>
        <span class="count-pill">${fmt.format(t.outcome.moving.length)} would move</span>
        <span class="count-pill">${fmt.format(t.outcome.held.length)} held back</span>
        <span class="count-pill">${fmt.format(t.ingest.candidateCount)} considered</span>
      </p>
      ${banner}

      ${t.outcome.moving.length ? `
        <h3 style="margin-top:20px">Would be ${t.action === "trash" ? "moved to trash" : "archived"}</h3>
        ${t.outcome.moving.map((m) => `
          <div class="row"><span class="chip move">move</span> ${esc(name(m.id))}</div>`).join("")}
      ` : ""}

      ${t.outcome.held.length ? `
        <h3 style="margin-top:20px">Held back, and why</h3>
        ${t.outcome.held.map((h) => `
          <div class="row">
            <div>${esc(name(h.id))}</div>
            ${h.by.map((b) => `
              <div style="margin-top:4px">
                <span class="chip held">${esc(b.id)} ${esc(b.code)}</span>
                <span class="muted" style="font-size:.85rem">${esc(b.reason)}</span>
              </div>`).join("")}
          </div>`).join("")}
      ` : ""}
    </div>`;
}

function renderTrace(t) {
  const el = document.getElementById("result");
  el.className = "card";
  el.innerHTML =
    stageIngest(t) + stageClassify(t) + stageGuards(t) + stageOutcome(t);
  el.scrollIntoView({ behavior: "smooth", block: "start" });
}

// ── Wiring ───────────────────────────────────────────────────────────────

async function run(action, confirmed) {
  const el = document.getElementById("result");
  el.className = "card";
  el.innerHTML = `<p class="muted">Running the pipeline…</p>`;
  try {
    renderTrace(await api("/api/demo/run", {
      method: "POST",
      body: { ids: [...selected], action, confirmed },
    }));
  } catch (err) {
    el.innerHTML = `<p class="callout danger">Could not run the demo: ${esc(err.message)}</p>`;
  }
}

document.addEventListener("click", (e) => {
  const mail = e.target.closest(".mail");
  if (mail) {
    const id = mail.dataset.id;
    if (selected.has(id)) selected.delete(id);
    else selected.add(id);
    syncSelectionNote();
    return;
  }

  const pick = e.target.closest("[data-pick]");
  if (pick) {
    selected.clear();
    const which = pick.dataset.pick;
    for (const m of INBOX) {
      if (which === "all" || m.group === which) selected.add(m.id);
    }
    syncSelectionNote();
    return;
  }

  const runBtn = e.target.closest("[data-run]");
  if (runBtn) return void run(runBtn.dataset.run, false);

  // The confirm button re-runs the SAME request with confirmed:true rather
  // than executing a stored plan — mirroring the real app, where a clean plan
  // is never an authorisation on its own and everything is re-derived.
  const confirmBtn = e.target.closest("[data-confirm]");
  if (confirmBtn) return void run(confirmBtn.dataset.confirm, true);
});

api("/api/demo/inbox")
  .then((data) => {
    INBOX = data.messages;
    renderPicker();
    // Open on the interesting case rather than an empty inbox: a visitor who
    // has to assemble a batch before seeing anything mostly leaves instead.
    for (const m of INBOX) selected.add(m.id);
    syncSelectionNote();
  })
  .catch(() => {
    document.getElementById("picker").innerHTML =
      `<p class="callout danger">Could not load the test inbox. Reload the page to try again.</p>`;
  });
