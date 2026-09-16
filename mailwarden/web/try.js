/**
 * Mailwarden sandbox client — /try.html.
 *
 * Renders a sample library and a test inbox, posts the inbox's message ids to
 * /api/demo/run, and draws the trace the server sent back.
 *
 * The rule this file follows, and the reason the page is worth anything:
 * NOTHING HERE DECIDES ANYTHING. Every category, confidence, reason, guard
 * name, hold reason and bar length on screen comes from a value the server
 * produced by running the real classifier and the real guard layer. This file
 * knows how to lay out a result; it does not know what the result should be.
 * If it started inferring — colouring a row by guessing which sender "looks
 * protected", or drawing a bar from a number it made up — the page would become
 * an illustration of the safety model rather than an observation of it.
 *
 * Same CSP constraint as app.js: external file, never an inline <script>. The
 * charts are hand-built from CSS boxes for the same reason — `default-src
 * 'self'` blocks every charting library on every CDN, and a bar chart with
 * text labels is more legible in CSS than in a viewBox anyway.
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

/** "412 days ago" reads as evidence; a date the reader has to subtract does not. */
const ago = (ts, now) => {
  const days = Math.max(0, Math.round((now - ts) / 86400000));
  if (days === 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 60) return `${days} days ago`;
  if (days < 730) return `${Math.round(days / 30)} months ago`;
  return `${(days / 365).toFixed(1)} years ago`;
};

let LIBRARY = [];
/** Insertion-ordered, so the inbox reads in the order the visitor built it. */
const inbox = new Set();

const byId = (id) => LIBRARY.find((m) => m.id === id);

// ── Step 1: the library and the inbox ────────────────────────────────────

const GROUPS = [
  { id: "bulk", title: "Everyday clutter",
    blurb: "Marketing, digests and social noise — the mail the product exists to clear." },
  { id: "tricky", title: "The ones that look like clutter",
    blurb: "Each of these sits in a Gmail tab that cleanup tools sweep, and each is " +
           "something you would be upset to lose. This is the half that matters." },
];

const tagsFor = (m) => [
  ...m.labels.map((l) => l.replace("CATEGORY_", "")),
  ...(m.unread ? ["UNREAD"] : []),
  ...(m.starred ? ["STARRED"] : []),
  ...(m.important ? ["IMPORTANT"] : []),
  ...(m.hasAttachment ? ["ATTACHMENT"] : []),
  ...(m.hasUnsubscribe ? ["LIST-UNSUBSCRIBE"] : []),
];

function libraryCard(m) {
  const added = inbox.has(m.id);
  return `
    <div class="mail ${added ? "added" : ""}">
      <span>
        <span class="line mail-from">${esc(m.senderName)}
          <span class="mail-meta"> · ${esc(m.senderKey)}</span></span>
        <span class="line mail-subject">${esc(m.subject)}</span>
        <span class="line mail-meta">${esc(m.ageDays)} days old · ${esc(m.sizeKb)} KB</span>
        <span class="line mail-note">${esc(m.note)}</span>
      </span>
      <button class="mini ${added ? "" : "solid"}" type="button"
              data-add="${esc(m.id)}" ${added ? "disabled" : ""}>
        ${added ? "Added" : "Add"}
      </button>
    </div>`;
}

function inboxCard(m) {
  return `
    <div class="mail">
      <span>
        <span class="line mail-from">${esc(m.senderName)}
          <span class="mail-meta"> · ${esc(m.senderKey)}</span></span>
        <span class="line mail-subject">${esc(m.subject)}</span>
        <span class="line mail-body">${esc(m.body)}</span>
        <span class="line">${tagsFor(m).map((t) => `<span class="tag">${esc(t)}</span>`).join("")}</span>
      </span>
      <button class="mini" type="button" data-remove="${esc(m.id)}"
              aria-label="Remove ${esc(m.subject)} from the test inbox">Remove</button>
    </div>`;
}

function renderLibrary() {
  document.getElementById("library").innerHTML = GROUPS.map((g) => `
    <div>
      <h4 style="margin:12px 0 2px">${esc(g.title)}</h4>
      <p class="muted" style="margin-bottom:9px">${esc(g.blurb)}</p>
      <div class="mail-list">
        ${LIBRARY.filter((m) => m.group === g.id).map(libraryCard).join("")}
      </div>
    </div>`).join("");
}

function renderInbox() {
  const items = [...inbox].map(byId).filter(Boolean);
  document.getElementById("inbox").innerHTML = items.length
    ? `<div class="mail-list">${items.map(inboxCard).join("")}</div>`
    : `<p class="empty">Empty. Add a few samples on the left — the full body text
         is shown here, so you can see exactly what gets redacted next.</p>`;

  const n = inbox.size;
  document.getElementById("inbox-count").textContent = n ? `(${fmt.format(n)})` : "";
  document.getElementById("selection-note").textContent = n === 0
    ? "Nothing in the inbox yet."
    : `${fmt.format(n)} ${plural(n, "message", "messages")} ready.`;
  for (const b of document.querySelectorAll("[data-run]")) b.disabled = n === 0;
}

const renderPanes = () => { renderLibrary(); renderInbox(); };

// ── Charts ───────────────────────────────────────────────────────────────

/**
 * A redaction bar whose width tracks the length of the value it replaces, so
 * the shape of the message survives and the content does not.
 *
 * The withheld text is genuinely not in this element — no hidden span, nothing
 * to reveal in the inspector. On a page arguing about data minimisation, a
 * black rectangle painted over real text would be the wrong joke.
 */
const redactionBar = (text, cap = 30) => {
  const width = Math.min(100, Math.max(12, (String(text).length / cap) * 100));
  return `<span class="bar" style="width:${width.toFixed(0)}%"></span>`;
};

/** One stacked bar. Part-to-whole of two segments, both directly labelled. */
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
         aria-label="${fmt.format(held)} of ${fmt.format(total)} messages protected, ${fmt.format(moved)} cleaned">
      ${held ? `<span class="s-held" style="width:${w(held)}" title="${fmt.format(held)} protected"></span>` : ""}
      ${moved ? `<span class="s-moved" style="width:${w(moved)}" title="${fmt.format(moved)} cleaned"></span>` : ""}
    </div>`;
}

/**
 * Horizontal bars, one hue for every bar.
 *
 * The guards are nominal categories, so shading them by value would burn the
 * only free channel re-encoding the length the bar already shows. Sorted by
 * magnitude, each bar carries its own number, and the guard roster underneath
 * is the table view of the same data.
 */
function guardBars(guards, held) {
  const hit = guards
    .filter((g) => g.hits.length)
    .map((g) => ({
      id: g.id, title: g.title,
      n: g.hits.reduce((sum, h) => sum + h.messageCount, 0),
    }))
    .sort((a, b) => b.n - a.n);

  if (!hit.length) return "";
  const max = Math.max(...hit.map((g) => g.n));

  /*
   * These bars do NOT decompose the held pile, and the heading must not imply
   * they do. A message can trip several guards at once — the Amazon receipt is
   * both a protected category and Gmail-important — so the bars sum to more
   * than the number of messages held. Saying so is cheaper than a reader
   * finding the discrepancy and distrusting every other number on the page.
   */
  const sum = hit.reduce((a, g) => a + g.n, 0);
  const overlap = sum - held;

  return `
    <h3 style="margin:20px 0 0">What each guardrail objected to</h3>
    ${overlap > 0 ? `<p class="muted" style="margin:2px 0 0">
        ${fmt.format(overlap)} of these are the same ${plural(overlap, "message", "messages")}
        counted twice — ${plural(overlap, "it trips", "they trip")} more than one guard,
        so the bars total more than the ${fmt.format(held)} held.
      </p>` : ""}
    <div class="bars">
      ${hit.map((g) => `
        <div class="bar-row" title="${esc(g.id)} ${esc(g.title)}: ${fmt.format(g.n)} ${plural(g.n, "message", "messages")}">
          <span class="bar-label"><b>${esc(g.id)}</b> ${esc(g.title)}</span>
          <span class="bar-track"><span class="bar-fill"
                style="width:${((g.n / max) * 100).toFixed(1)}%"></span></span>
          <span class="bar-n">${fmt.format(g.n)}</span>
        </div>`).join("")}
    </div>`;
}

// ── Stage 1: redaction ───────────────────────────────────────────────────

function stageRedaction(t) {
  const stored = t.ingest.rows.filter((r) => !r.labels.split(",").includes("SENT"));
  const r = t.redaction;

  const pair = (row) => {
    const m = byId(row.id);
    if (!m) return "";
    return `
      <div class="redact-pair">
        <div class="doc">
          <div class="doc-title">In your mailbox</div>
          <div class="field"><span class="field-k">From</span>
            <span class="field-v">${esc(m.senderName)} &lt;${esc(m.senderKey)}&gt;</span></div>
          <div class="field"><span class="field-k">Subject</span>
            <span class="field-v">${esc(m.subject)}</span></div>
          <div class="field"><span class="field-k">Body</span>
            <span class="field-v">${esc(m.body)}</span></div>
        </div>

        <div class="arrow-col" aria-hidden="true">→</div>

        <div class="doc kept">
          <div class="doc-title">What Mailwarden kept</div>
          <div class="field"><span class="field-k">From</span>
            <span class="field-v">${esc(row.senderKey)}
              <span class="verdict-note">Kept — the sender is the unit of every decision.</span>
            </span></div>
          <div class="field"><span class="field-k">Subject</span>
            <span class="field-v">${redactionBar(m.subject)}
              <span class="mono">${esc(row.subjectHash)}</span>
              <span class="verdict-note">Read, salted-hashed, plaintext dropped. Counts repeated templates; reads back as nothing.</span>
            </span></div>
          <div class="field"><span class="field-k">Body</span>
            <span class="field-v">${redactionBar(m.body, 60)}
              <span class="verdict-note">Never requested. <code>format: ${esc(r.fetchFormat)}</code> cannot return one.</span>
            </span></div>
          <div class="field"><span class="field-k">Envelope</span>
            <span class="field-v mono">${esc(row.labels)} · ${esc(kb(row.sizeBytes))} · ${esc(ago(row.internalDate, t.now))}</span></div>
        </div>
      </div>`;
  };

  return `
    <div class="stage">
      <span class="stage-n">STAGE 1 / 4</span>
      <h2 style="margin-top:4px">What gets redacted before anything is stored</h2>
      <p class="muted">
        Mailwarden asks Gmail for <code>format: ${esc(r.fetchFormat)}</code> and
        exactly ${fmt.format(r.headersRequested.length)} headers —
        ${r.headersRequested.map((h) => `<code>${esc(h)}</code>`).join(", ")}.
        That is the narrowest read the Gmail API offers: bodies and attachments
        are never transferred at all, and no recipient header is requested.
        Of what does arrive, ${r.discarded.map((d) => `<code>${esc(d)}</code>`).join(" and ")}
        is hashed and the readable version thrown away.
      </p>
      <p class="muted">
        You can check this one yourself: the sample bodies on the left came from
        the catalogue, and the response that drew everything below has no body
        field in it at all. Open your network tab and look at
        <code>/api/demo/run</code>.
      </p>
      ${stored.map(pair).join("")}
    </div>`;
}

// ── Stage 2: classification ──────────────────────────────────────────────

function stageClassify(t) {
  const TIER = {
    heuristic: "settled by a local rule — never sent anywhere",
    "model-unavailable": "local rules declined; took the model-unavailable path",
    "too-small": "too little evidence to judge — left alone",
  };

  return `
    <div class="stage">
      <span class="stage-n">STAGE 2 / 4</span>
      <h2 style="margin-top:4px">What the classifier was allowed to see</h2>
      <p class="muted">
        Decisions are made per <em>sender</em>, not per message, from counted
        facts only. The line under each verdict is the complete input — and the
        complete answer to "what would you send a language model?" There is no
        subject and no prose in it, because by this point neither exists.
      </p>
      ${t.senders.map((s) => {
        const f = s.facts;
        const v = s.verdict;
        return `
        <div class="row">
          <div><strong>${esc(f.displayName || f.senderKey)}</strong>
            <span class="muted">· ${esc(f.senderKey)}</span></div>
          <div style="margin:4px 0 6px">
            <span class="${v.protectedSender ? "verdict-protected" : "verdict-clean"}">${esc(v.category)}</span>
            <span class="muted">· ${esc(pct(v.confidence))} confidence ·
              ${v.protectedSender ? "protected" : "actionable"}</span>
          </div>
          <div style="font-size:.89rem">${esc(v.reason)}</div>
          <div class="mono muted" style="margin-top:6px">
            ${fmt.format(f.messageCount)} ${plural(f.messageCount, "message", "messages")} ·
            ${fmt.format(f.unreadCount)} unread ·
            ${fmt.format(f.distinctSubjectHashes)} distinct subject ${plural(f.distinctSubjectHashes, "template", "templates")} ·
            unsubscribe header: ${f.hasUnsubscribe ? "yes" : "no"} ·
            you have written back: ${f.userReplied ? "yes" : "no"}
          </div>
          <div class="muted" style="font-size:.8rem;margin-top:4px">${esc(TIER[s.tier] || s.tier)}</div>
        </div>`;
      }).join("")}
    </div>`;
}

// ── Stage 3: the guard layer ─────────────────────────────────────────────

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
          <div class="guard-detail">
            <strong>${esc(h.senderKey)}</strong> — ${fmt.format(h.messageCount)}
            ${plural(h.messageCount, "message", "messages")} held. ${esc(h.reason)}
          </div>`).join("")}
        ${g.fired ? "" : `<div class="guard-detail">Checked. Nothing in this batch matched.</div>`}
      </div>
    </div>`;

  return `
    <div class="stage">
      <span class="stage-n">STAGE 3 / 4</span>
      <h2 style="margin-top:4px">The guardrails</h2>
      <p class="muted">
        Every change to a mailbox goes through one function, and this is its full
        output — including the ${fmt.format(idle.length)} guards that found
        nothing to stop. A guard either narrows the batch, asks for a second
        confirmation, or refuses it outright.
      </p>
      ${guardBars(t.guards, t.outcome.held.length)}
      ${fired.map(guardRow).join("")}
      ${idle.length ? `
        <details class="more">
          <summary>${fmt.format(idle.length)} more guards ran and matched nothing</summary>
          ${idle.map(guardRow).join("")}
        </details>` : ""}
    </div>`;
}

// ── Stage 4: the outcome ─────────────────────────────────────────────────

function stageOutcome(t) {
  const name = (id) => {
    const m = byId(id);
    return m ? `${m.senderName} — ${m.subject}` : id;
  };

  const blocked = t.guards.some((g) => g.fired && g.severity === "block");
  const moved = t.outcome.moving.length;
  const held = t.outcome.held.length;

  const banner = blocked
    ? `<div class="callout danger">
         <strong>Refused.</strong> Nothing would move. The batch failed a
         blocking guard, and Mailwarden fails closed — it does not run the part
         of a batch that was legal.
       </div>`
    : t.outcome.requiresConfirmation
      ? `<div class="callout" style="border-color:var(--held-ink);color:var(--text)">
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

      <div class="tiles">
        <div class="tile held">
          <div class="tile-n">${fmt.format(held)}</div>
          <div class="tile-k">held back by a guardrail</div>
        </div>
        <div class="tile ${blocked ? "refused" : ""}">
          <div class="tile-n">${blocked ? "0" : fmt.format(moved)}</div>
          <div class="tile-k">${blocked ? "refused — nothing moves" : `would be ${t.action === "trash" ? "trashed" : "archived"}`}</div>
        </div>
        <div class="tile">
          <div class="tile-n">${fmt.format(t.ingest.candidateCount)}</div>
          <div class="tile-k">considered in total</div>
        </div>
      </div>

      ${blocked ? "" : splitBar(held, moved)}
      ${banner}

      ${moved && !blocked ? `
        <h3 style="margin-top:20px">Would be ${t.action === "trash" ? "moved to trash" : "archived"}</h3>
        ${t.outcome.moving.map((m) => `<div class="row">${esc(name(m.id))}</div>`).join("")}
      ` : ""}

      ${held ? `
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
  el.innerHTML = stageRedaction(t) + stageClassify(t) + stageGuards(t) + stageOutcome(t);
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
      body: { ids: [...inbox], action, confirmed },
    }));
  } catch (err) {
    el.innerHTML = `<p class="callout danger">Could not run the demo: ${esc(err.message)}</p>`;
  }
}

document.addEventListener("click", (e) => {
  const add = e.target.closest("[data-add]");
  if (add) { inbox.add(add.dataset.add); return void renderPanes(); }

  const remove = e.target.closest("[data-remove]");
  if (remove) { inbox.delete(remove.dataset.remove); return void renderPanes(); }

  const pick = e.target.closest("[data-pick]");
  if (pick) {
    inbox.clear();
    if (pick.dataset.pick === "all") for (const m of LIBRARY) inbox.add(m.id);
    return void renderPanes();
  }

  const runBtn = e.target.closest("[data-run]");
  if (runBtn) return void run(runBtn.dataset.run, false);

  // The confirm button re-runs the SAME request with confirmed:true rather than
  // executing a stored plan — mirroring the real app, where a clean plan is
  // never an authorisation on its own and everything is re-derived.
  const confirmBtn = e.target.closest("[data-confirm]");
  if (confirmBtn) return void run(confirmBtn.dataset.confirm, true);
});

api("/api/demo/inbox")
  .then((data) => {
    LIBRARY = data.messages;
    // Open on the interesting case rather than an empty inbox: a visitor who has
    // to assemble a batch before seeing anything mostly leaves instead. They can
    // still empty it and build their own.
    for (const m of LIBRARY) inbox.add(m.id);
    renderPanes();
  })
  .catch(() => {
    document.getElementById("library").innerHTML =
      `<p class="callout danger">Could not load the samples. Reload the page to try again.</p>`;
  });
