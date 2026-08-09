/**
 * Landing page: request a seat.
 *
 * External file because the production CSP blocks inline scripts.
 */
const form = document.getElementById("inviteForm");
const msg = document.getElementById("inviteMsg");

form.onsubmit = async (e) => {
  e.preventDefault();
  const email = document.getElementById("inviteEmail").value;
  msg.textContent = "Sending…";
  try {
    const res = await fetch("/api/access-request", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.message || data.error || "That address did not look right.");
    // Say what happens next and roughly when. "We'll be in touch" is where
    // leads go to be forgotten.
    msg.innerHTML =
      `<b>You're on the list.</b> ${data.waiting} ahead of you. ` +
      `We add seats by hand — you'll get an email with a link and a heads-up ` +
      `about Google's "unverified app" warning, which is just the review still running.`;
    form.hidden = true;
  } catch (err) {
    msg.textContent = err.message;
  }
};
