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
  if (window.mwTrack) window.mwTrack("invite_submit");
  try {
    const res = await fetch("/api/access-request", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.message || data.error || "That address did not look right.");
    if (window.mwTrack) window.mwTrack("invite_ok");
    msg.innerHTML = "<b>You're on the list.</b> We'll email you when your seat is ready.";
    form.hidden = true;
  } catch (err) {
    msg.textContent = err.message;
  }
};
