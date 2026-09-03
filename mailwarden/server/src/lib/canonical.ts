/**
 * ONE HOST SERVES THE SITE.
 *
 * Extracted from the request hook so it can be tested without a socket. The
 * rule is deploy-critical in a way that is easy to get wrong and hard to
 * notice: exempt too little and Fly's health probe gets a 301, which marks the
 * machine unhealthy and rolls the release back; exempt too much and the site
 * answers on several hosts at once, which splits its own search ranking and
 * silently signs users out when they drift between them.
 */

/** Routes that must answer on ANY host, redirect rule or not. */
const HOST_AGNOSTIC = new Set([
  /**
   * Fly's health check reaches the machine directly and does not send the
   * public hostname. This is the single route where a redirect is a failure.
   */
  "/healthz",
]);

export interface HostRequest {
  /** Fastify 5 `request.hostname` — the host WITHOUT its port. */
  hostname: string;
  /** Path and query, as `request.url` gives it. */
  url: string;
}

/**
 * Where this request should be sent, or `null` to serve it here.
 *
 * `appUrl` is the source of truth for the canonical origin rather than a
 * hard-coded hostname, so the redirect target can never drift from the origin
 * the OAuth callback is built against — a mismatch there breaks sign-in for
 * everybody at once.
 */
export function canonicalRedirect(
  req: HostRequest,
  appUrl: string,
  isProd: boolean,
): string | null {
  // Development answers on localhost, 127.0.0.1, and whatever the LAN address
  // is. None of them are worth redirecting between.
  if (!isProd) return null;

  const path = req.url.split("?")[0] ?? req.url;
  if (HOST_AGNOSTIC.has(path)) return null;

  let canonical: URL;
  try {
    canonical = new URL(appUrl);
  } catch {
    // An unparseable APP_URL must not take the site down. Serving on the wrong
    // host is a ranking problem; redirecting into a malformed URL is an outage.
    return null;
  }

  if (req.hostname === canonical.hostname) return null;

  return new URL(req.url, canonical.origin).toString();
}
