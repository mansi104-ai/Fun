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

const inr = (n) => `₹${Number(n).toLocaleString("en-IN")}`;

/**
 * Seat availability comes from the server, never hard-coded. "Only 100 exist"
 * is a promise; a page claiming "12 left" while the database disagrees turns
 * the most persuasive line on the page into the least trustworthy one.
 */
async function loadSeats() {
  try {
    const { founding } = await api("/api/billing/prices");
    if (founding.remaining <= 0) {
      $("seats").textContent = "All 100 seats claimed";
      $("upiStart").disabled = true;
      $("upiStart").textContent = "Sold out";
    } else {
      $("seats").textContent = `${founding.remaining} of ${founding.total} seats left`;
    }
  } catch {
    $("seats").textContent = "Founding 100";
  }
}

async function loadUpi() {
  try {
    const { available, amountInr } = await api("/api/billing/upi");
    if (amountInr) $("heroPrice").innerHTML = `${inr(amountInr)} <small>once — not per year</small>`;
    if (!available) {
      $("upiStep1").hidden = true;
      $("upiUnavailable").classList.remove("hidden");
    }
  } catch {
    /* leave the default copy in place */
  }
}

/**
 * Creates the order and renders the QR.
 *
 * The payee id never reaches this page as text — it exists only inside the
 * signed-in response, encoded in the QR and the deep link. A UPI id printed on
 * a public page gets scraped and gets used to impersonate the payee.
 */
async function startUpi() {
  const button = $("upiStart");
  button.disabled = true;
  button.textContent = "Preparing…";
  try {
    const order = await api("/api/billing/upi/order", {
      method: "POST",
      body: { plan: "founding" },
    });
    $("upiQr").src = order.qrDataUri;
    $("upiAmount").textContent = inr(order.amountInr);
    $("upiRef").textContent = order.reference;
    $("upiOpen").href = order.upiUri;
    $("upiStep1").hidden = true;
    $("upiStep2").hidden = false;
  } catch (err) {
    button.disabled = false;
    button.textContent = "Pay with UPI";
    if (err.status === 401) {
      // Sign-in is required so the seat attaches to a real inbox — and so the
      // payee id is never handed to an anonymous visitor.
      window.location.href = "/auth/google";
      return;
    }
    alert(err.message || "Could not start the payment.");
  }
}

/** Card checkout, shown only if Stripe is actually configured. */
async function loadCard() {
  try {
    const { enabled } = await api("/api/billing/prices");
    if (!enabled) return;
    $("intlState").textContent = "open";
    $("buyFounding").classList.remove("hidden");
    $("buyFounding").onclick = async (e) => {
      const b = e.currentTarget;
      b.disabled = true;
      b.textContent = "Opening checkout…";
      try {
        const { url } = await api("/api/billing/checkout", {
          method: "POST", body: { price: "founding" },
        });
        window.location.href = url;
      } catch (err) {
        b.disabled = false;
        b.textContent = "Pay by card";
        if (err.status === 401) return void (window.location.href = "/auth/google");
        alert(err.message || "Could not start checkout.");
      }
    };
  } catch {
    /* card checkout stays hidden */
  }
}

$("upiStart").onclick = startUpi;

$("waitForm").onsubmit = async (e) => {
  e.preventDefault();
  const msg = $("waitMsg");
  msg.textContent = "Sending…";
  try {
    const r = await api("/api/access-request", {
      method: "POST",
      body: { email: $("waitEmail").value },
    });
    msg.textContent = `You're on the list — ${r.waiting} ahead of you. We'll email you.`;
    $("waitEmail").value = "";
  } catch (err) {
    msg.textContent = err.message || "That address did not look right.";
  }
};

loadSeats();
loadUpi();
loadCard();
