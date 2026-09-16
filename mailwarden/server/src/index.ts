import { fileURLToPath } from "node:url";
import path from "node:path";
import Fastify from "fastify";
import cookie from "@fastify/cookie";
import fastifyStatic from "@fastify/static";
import { config } from "./config.js";
import { canonicalRedirect } from "./lib/canonical.js";
import { authRoutes } from "./routes/auth.js";
import { analyticsRoutes } from "./routes/analytics.js";
import { apiRoutes } from "./routes/api.js";
import { billingRoutes } from "./routes/billing.js";
import { demoRoutes } from "./routes/demo.js";
import { sandboxRoutes } from "./routes/sandbox.js";
import { pruneWebEvents } from "./analytics.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.resolve(here, "../../web");

const app = Fastify({
  logger: { level: config.isProd ? "info" : "debug" },
  trustProxy: config.isProd,
});

/**
 * Treat an empty JSON body as `{}` rather than rejecting the request.
 *
 * Fastify's default parser answers `Content-Type: application/json` with a
 * zero-length body with FST_ERR_CTP_EMPTY_JSON_BODY — a 400 raised before the
 * handler runs. Every bodyless POST here is legitimate (start a scan, execute a
 * batch, undo one), and a client that sets the header anyway is being tidy, not
 * malformed. This shipped: the scan button 400'd and hung on "Connecting…".
 *
 * Malformed JSON still fails, loudly. Only the empty case is forgiven.
 */
/** Stripe verifies its signature against the exact bytes it sent. */
const RAW_BODY_ROUTES = new Set(["/api/billing/webhook"]);

app.addContentTypeParser(
  "application/json",
  { parseAs: "string" },
  (req, body, done) => {
    // Parsing and re-serialising changes the bytes — key order, whitespace,
    // unicode escapes — and any change invalidates the HMAC. The webhook
    // handler therefore receives the untouched string. Getting this wrong
    // fails closed (every webhook rejected), which looks exactly like a
    // customer who paid and never received their plan.
    if (RAW_BODY_ROUTES.has(req.url.split("?")[0] ?? "")) return done(null, body);

    const text = (body as string).trim();
    if (text.length === 0) return done(null, {});
    try {
      done(null, JSON.parse(text));
    } catch (err) {
      // Without an explicit statusCode Fastify reports a client's malformed
      // body as a 500, which blames the server for the caller's mistake and
      // pollutes error monitoring.
      done(Object.assign(err as Error, { statusCode: 400 }), undefined);
    }
  },
);

await app.register(cookie, { secret: config.sessionSecret });
await app.register(fastifyStatic, { root: webRoot, prefix: "/" });

/**
 * ONE HOST SERVES THE SITE. Everything else is a permanent redirect to it.
 *
 * The app answers on at least three names — `mailwarden.xyz`,
 * `www.mailwarden.xyz` and `mailwarden.fly.dev` — and Fly will happily add
 * more. Serving the same pages on all of them costs twice: every canonical tag
 * names one host, so a page answering on a second is duplicate content
 * advertising the first; and a session cookie set on one host is not sent to
 * another, so a user who drifts between them is silently signed out mid-task.
 *
 * The rule itself lives in lib/canonical.ts, where it can be tested without a
 * socket — see smoke §21. `hostname` excludes the port in Fastify 5, and
 * `trustProxy` is on in production, so this reads the forwarded host rather
 * than the machine's.
 */
app.addHook("onRequest", async (req, reply) => {
  const target = canonicalRedirect(req, config.appUrl, config.isProd);
  if (target) return reply.redirect(target, 301);
});

app.addHook("onSend", async (_req, reply) => {
  reply.header("X-Content-Type-Options", "nosniff");
  reply.header("Referrer-Policy", "strict-origin-when-cross-origin");
  reply.header("X-Frame-Options", "DENY");
  reply.header(
    "Content-Security-Policy",
    "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'",
  );
  if (config.isProd) {
    reply.header("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  }
});

app.get("/healthz", async () => ({ ok: true }));

await app.register(authRoutes);
await app.register(demoRoutes);
await app.register(sandboxRoutes);
await app.register(apiRoutes);
await app.register(billingRoutes);
await app.register(analyticsRoutes);

/**
 * Analytics retention, enforced by the app rather than by remembering to run
 * something. `unref` so a pending timer never holds the process open during a
 * deploy — Fly stops containers on a clock, and a hung shutdown reads as a
 * failed release.
 */
const pruned = pruneWebEvents();
if (pruned > 0) app.log.info(`[analytics] pruned ${pruned} events past retention`);
setInterval(() => pruneWebEvents(), 24 * 60 * 60 * 1000).unref();

app.get("/app", (_req, reply) => reply.sendFile("app.html"));

await app.listen({ port: config.port, host: "0.0.0.0" });
app.log.info(`Mailwarden listening on ${config.appUrl}`);
