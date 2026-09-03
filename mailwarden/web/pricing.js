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
 * Prices come from the server, never from this page.
 *
 * A figure printed in HTML that disagrees with what the QR actually asks for is
 * the one discrepancy a buyer is guaranteed to notice, and the moment they stop
 * trusting anything else on the page. The markup carries a plausible default so
 * the page is readable before the fetch lands; the server's number wins.
 */
async function loadUpi() {
  try {
    const { available, plans } = await api("/api/billing/upi");
    if (plans?.backlog) {
      $("backlogPrice").innerHTML = `${inr(plans.backlog)} <small>once</small>`;
      $("upiStart").textContent = `Pay ${inr(plans.backlog)} with UPI`;
    }
    if (plans?.pro) {
      $("proPrice").innerHTML = `${inr(plans.pro)} <small>· per month</small>`;
      $("proStart").textContent = `Pay ${inr(plans.pro)} with UPI`;
    }
    if (!available) {
      $("upiStep1").hidden = true;
      $("proStart").hidden = true;
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
async function startUpi(plan, button) {
  const label = button.textContent;
  button.disabled = true;
  button.textContent = "Preparing…";
  try {
    const order = await api("/api/billing/upi/order", { method: "POST", body: { plan } });
    $("upiQr").src = order.qrDataUri;
    $("upiAmount").textContent = inr(order.amountInr);
    $("upiRef").textContent = order.reference;
    $("upiOpen").href = order.upiUri;
    $("upiStep1").hidden = true;
    $("upiStep2").hidden = false;
    // Both buttons drive the one QR panel, so scroll it into view — a Pro
    // buyer clicking at the bottom of the page would otherwise see nothing
    // happen and click again, minting a second reference for one payment.
    $("upiStep2").scrollIntoView({ behavior: "smooth", block: "center" });
  } catch (err) {
    button.disabled = false;
    button.textContent = label;
    if (err.status === 401) {
      // Sign-in is required so the plan attaches to a real inbox — and so the
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
    $("buyBacklog").classList.remove("hidden");
    $("buyBacklog").onclick = async (e) => {
      const b = e.currentTarget;
      b.disabled = true;
      b.textContent = "Opening checkout…";
      try {
        const { url } = await api("/api/billing/checkout", {
          method: "POST", body: { price: "backlog" },
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

$("upiStart").onclick = (e) => startUpi("backlog", e.currentTarget);
$("proStart").onclick = (e) => startUpi("pro", e.currentTarget);

$("waitForm").onsubmit = async (e) => {
  e.preventDefault();
  const msg = $("waitMsg");
  msg.textContent = "Sending…";
  try {
    await api("/api/access-request", {
      method: "POST",
      body: { email: $("waitEmail").value },
    });
    msg.textContent = "You're on the list — we'll write when card payment opens.";
    $("waitEmail").value = "";
  } catch (err) {
    msg.textContent = err.message || "That address did not look right.";
  }
};

loadUpi();
loadCard();
