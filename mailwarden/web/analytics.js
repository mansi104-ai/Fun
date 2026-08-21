/**
 * Mailwarden analytics client.
 *
 * Sends a pageview, plus clicks on anything carrying `data-evt`. That is the
 * whole feature. It reads no storage, sets no cookie, and has no identity of
 * its own — the server derives a rotating visitor hash from the request it
 * already receives, so there is nothing here to persist or to clear.
 *
 * Deliberately NOT a module and deliberately not bundled with the page's own
 * script: if this file fails to parse, the page it is measuring must still
 * work. Nothing else imports it and nothing waits on it.
 *
 * Same-origin only. The CSP is `default-src 'self'`, so this could not reach a
 * third party even if a later edit tried to make it.
 */
(function () {
  var ENDPOINT = "/api/e";

  function send(name) {
    var payload = JSON.stringify({
      name: name,
      path: location.pathname,
      // The query string is sent so the server can pick out utm_source. It
      // reduces it to a slug and discards the rest; nothing else is stored.
      query: location.search,
      ref: document.referrer || "",
    });

    // sendBeacon survives the page being closed mid-request, which is exactly
    // when an outbound-link click needs to be recorded. It is also fire-and-
    // forget: no response, no promise, nothing for the page to await.
    try {
      if (navigator.sendBeacon) {
        navigator.sendBeacon(ENDPOINT, new Blob([payload], { type: "application/json" }));
        return;
      }
    } catch (e) {
      /* fall through to fetch */
    }

    try {
      fetch(ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: payload,
        keepalive: true,
      }).catch(function () {});
    } catch (e) {
      /* Analytics must never break a page. There is no retry and no report. */
    }
  }

  /**
   * The one global. Page scripts need it for events a click listener cannot
   * see — "the invite request was accepted" is a different fact from "the
   * button was pressed", and only the page knows which happened.
   */
  window.mwTrack = send;

  send("pageview");

  /**
   * One delegated listener rather than a listener per element, so markup added
   * later is picked up without re-wiring — and so a page with no tagged
   * elements costs exactly one registration.
   */
  document.addEventListener(
    "click",
    function (event) {
      var el = event.target && event.target.closest && event.target.closest("[data-evt]");
      if (el) send(el.getAttribute("data-evt"));
    },
    { capture: true, passive: true },
  );
})();
