/**
 * Pricing page client.
 *
 * External file, not inline: the production CSP is `default-src 'self'` with no
 * script-src, so an inline script silently never executes. That shipped once.
 * smoke.ts fails the build if an inline <script> reappears in web/.
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

/**
 * Seat availability is read from the server, never hard-coded. "Only 100 exist"
 * is a promise; a page that says "12 left" while the database disagrees turns
 * the most persuasive line on the page into the least trustworthy one.
 */
async function loadPrices() {
  try {
    const { enabled, founding } = await api("/api/billing/prices");
    const seats = $("seats");

    if (founding.remaining <= 0) {
      seats.textContent = "All 100 seats claimed";
      $("buyFounding").disabled = true;
      $("buyFounding").textContent = "Sold out — request access below";
    } else {
      seats.textContent = `${founding.remaining} of ${founding.total} seats left`;
    }

    if (!enabled) {
      // Say so plainly rather than letting someone click into a dead end.
      for (const b of document.querySelectorAll(".btn[data-price], #buyFounding")) {
        b.disabled = true;
      }
      $("buyFounding").textContent = "Checkout opens shortly";
      seats.textContent = "Founding 100 — opening soon";
    }
  } catch {
    $("seats").textContent = "Founding 100";
  }
}

async function buy(price, button) {
  const original = button.textContent;
  button.disabled = true;
  button.textContent = "Opening checkout…";
  try {
    const { url } = await api("/api/billing/checkout", { method: "POST", body: { price } });
    window.location.href = url;
  } catch (err) {
    button.disabled = false;
    button.textContent = original;
    if (err.status === 401) {
      // Checkout needs an account so the webhook can attribute the payment.
      window.location.href = "/auth/google";
      return;
    }
    alert(err.message || "Could not start checkout.");
  }
}

$("buyFounding").onclick = (e) => buy("founding", e.currentTarget);
for (const b of document.querySelectorAll("[data-price]")) {
  b.onclick = (e) => buy(e.currentTarget.dataset.price, e.currentTarget);
}

$("waitForm").onsubmit = async (e) => {
  e.preventDefault();
  const msg = $("waitMsg");
  msg.textContent = "Sending…";
  try {
    const r = await api("/api/access-request", {
      method: "POST",
      body: { email: $("waitEmail").value },
    });
    msg.textContent = `You're on the list — ${r.waiting} ahead of the next opening. We'll email you.`;
    $("waitEmail").value = "";
  } catch (err) {
    msg.textContent = err.message || "That address did not look right.";
  }
};

/**
 * Direct payment (UPI). Shown only when the server has a payee configured —
 * advertising a payment channel that is not set up is worse than not offering
 * one, because it fails after the buyer has already decided to pay.
 */
async function loadDirect() {
  try {
    const d = await api("/api/billing/direct");
    if (!d.enabled) return;

    $("directAmount").textContent = `₹${Number(d.amountInr).toLocaleString("en-IN")}`;
    $("directUpi").textContent = d.upiId;
    // The deep link only resolves on a device with a UPI app installed; on
    // desktop the id above is the fallback, which is why both are shown.
    $("directPay").href = d.upiUri;
    $("directCard").classList.remove("hidden");
  } catch {
    /* direct pay simply stays hidden */
  }
}

loadPrices();
loadDirect();
