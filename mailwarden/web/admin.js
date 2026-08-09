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
  await loadRequests();
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
