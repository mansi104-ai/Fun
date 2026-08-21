/**
 * Operator console.
 *
 * Exists because reconciling payments with curl is how payments stop getting
 * reconciled. Every endpoint it calls is admin-gated server-side — this page
 * is a convenience, never the security boundary.
 */
const $ = (id) => document.getElementById(id);

const api = async (url, opts = {}) => {
  const hasBody = opts.body !== undefined && opts.body !== null;
  const res = await fetch(url, {
    ...opts,
    headers: hasBody ? { "Content-Type": "application/json" } : {},
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

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const when = (ts) => ts ? new Date(ts).toLocaleString(undefined,
  { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "—";

async function boot() {
  let me;
  try {
    me = await api("/api/me");
  } catch {
    window.location.href = "/auth/google";
    return;
  }
  $("who").textContent = `Signed in as ${me.user.email}`;

  try {
    await loadOrders();
  } catch (err) {
    if (err.status === 403 || err.status === 401) {
      $("gate").hidden = false;
      return;
    }
    throw err;
  }
  $("panel").hidden = false;
  await loadAnalytics(7);
  await loadRequests();
}

// ── Traffic ──────────────────────────────────────────────────────────

const pct = (n, of) => (of > 0 ? Math.round((n / of) * 100) : 0);

/**
 * Rows as bars, scaled to the largest value rather than to the total.
 *
 * Scaling to the total makes a healthy spread of ten referrers render as ten
 * identical slivers, which is the shape of "no information". Scaling to the
 * leader is what makes second and third place legible — the number is printed
 * beside every bar anyway, so the bar only has to carry the comparison.
 */
function bars(rows, label, value) {
  if (rows.length === 0) return `<p class="muted" style="margin:0">Nothing yet.</p>`;
  const top = Math.max(...rows.map(value));
  return rows.map((r) => `
    <div class="bar-row">
      <span title="${esc(label(r))}">${esc(label(r))}</span>
      <span class="bar"><i style="width:${pct(value(r), top)}%"></i></span>
      <span class="bar-n">${Number(value(r)).toLocaleString()}</span>
    </div>`).join("");
}

async function loadAnalytics(days) {
  for (const el of document.querySelectorAll("#ranges button")) {
    el.classList.toggle("primary", Number(el.dataset.days) === days);
    el.onclick = () => loadAnalytics(Number(el.dataset.days));
  }

  const box = $("analytics");
  box.innerHTML = `<p class="muted">Loading…</p>`;
  let a;
  try {
    a = await api(`/api/admin/analytics?days=${days}`);
  } catch (err) {
    box.innerHTML = `<p class="err">${esc(err.message)}</p>`;
    return;
  }

  const landed = a.funnel[0]?.count ?? 0;

  box.innerHTML = `
    <div class="stats">
      <div><div class="stat-n">${a.traffic.visitors.toLocaleString()}</div>
           <div class="stat-l">Visitors</div></div>
      <div><div class="stat-n">${a.traffic.pageviews.toLocaleString()}</div>
           <div class="stat-l">Pageviews</div></div>
      <div><div class="stat-n">${a.referrers.length.toLocaleString()}</div>
           <div class="stat-l">Referring sites</div></div>
    </div>

    <h3 style="font-size:.82rem; text-transform:uppercase; letter-spacing:.05em;
               color:var(--muted); margin:0 0 6px">Funnel</h3>
    ${a.funnel.map((f) => `
      <div class="bar-row">
        <span>${esc(f.step)}${f.source === "server"
          ? ` <span class="pill ok" style="font-size:.65rem">verified</span>` : ""}</span>
        <span class="bar"><i style="width:${pct(f.count, landed)}%"></i></span>
        <span class="bar-n">${f.count.toLocaleString()}${
          landed > 0 ? ` · ${pct(f.count, landed)}%` : ""}</span>
      </div>`).join("")}
    <p class="muted" style="font-size:.8rem; margin:6px 0 22px">
      Steps marked <b>verified</b> are counted from the server's own audit log as
      the action happens, so they cannot be inflated by anyone posting at the
      public event endpoint. The two web steps can.
    </p>

    <div class="panes">
      <div><h3>Pages</h3>${bars(a.pages, (r) => r.path, (r) => r.views)}</div>
      <div><h3>Referrers</h3>${bars(a.referrers, (r) => r.host, (r) => r.visitors)}</div>
      <div><h3>Campaign source</h3>${bars(a.sources, (r) => r.source, (r) => r.visitors)}</div>
      <div><h3>By day</h3>${bars(a.daily, (r) => r.day, (r) => r.visitors)}</div>
    </div>`;
}

async function loadOrders() {
  const { orders } = await api("/api/billing/upi/orders");
  const body = $("orders");

  if (orders.length === 0) {
    body.innerHTML = `<tr><td colspan="7" class="muted">No payments started yet.</td></tr>`;
    return;
  }

  body.innerHTML = orders.map((o) => {
    const done = o.status === "confirmed";
    return `<tr>
      <td class="ref">${esc(o.reference)}</td>
      <td>${esc(o.email)}</td>
      <td>${esc(o.plan)}</td>
      <td>₹${Number(o.amount_inr).toLocaleString("en-IN")}</td>
      <td class="muted">${when(o.created_at)}</td>
      <td><span class="pill ${done ? "ok" : "wait"}">${done ? "confirmed" : "awaiting payment"}</span></td>
      <td>${done ? "" : `
        <input placeholder="UTR / bank ref" data-utr="${esc(o.reference)}" />
        <button class="primary" data-confirm="${esc(o.reference)}">Confirm</button>`}</td>
    </tr>`;
  }).join("");

  for (const el of document.querySelectorAll("[data-confirm]")) {
    el.onclick = () => confirmOrder(el, el.dataset.confirm);
  }
}

async function confirmOrder(button, reference) {
  const utr = document.querySelector(`[data-utr="${CSS.escape(reference)}"]`)?.value?.trim() ?? "";
  // The UTR is the only durable evidence linking a bank line to a granted seat.
  // Refusing to proceed without it is deliberate: a confirmation with no
  // reference is unauditable, and this is the one place money meets access.
  if (!utr) {
    alert("Paste the bank reference (UTR) first — it is the only record linking the payment to this seat.");
    return;
  }
  button.disabled = true;
  button.textContent = "Confirming…";
  try {
    const r = await api("/api/billing/upi/confirm", {
      method: "POST",
      body: { reference, utr },
    });
    alert(r.reason);
    await loadOrders();
  } catch (err) {
    button.disabled = false;
    button.textContent = "Confirm";
    alert(err.message || "Could not confirm.");
  }
}

async function loadRequests() {
  try {
    const { requests } = await api("/api/access-request/list");
    $("requests").innerHTML = requests.length === 0
      ? `<tr><td colspan="3" class="muted">Nobody waiting.</td></tr>`
      : requests.map((r) => `<tr>
          <td>${esc(r.email)}</td>
          <td class="muted">${when(r.created_at)}</td>
          <td>${r.invited_at
            ? `<span class="pill ok">invited</span>`
            : `<span class="pill wait">not yet</span>`}</td>
        </tr>`).join("");
  } catch (err) {
    $("requests").innerHTML = `<tr><td colspan="3" class="err">${esc(err.message)}</td></tr>`;
  }
}

boot();
