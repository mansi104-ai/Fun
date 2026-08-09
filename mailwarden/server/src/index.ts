import { fileURLToPath } from "node:url";
import path from "node:path";
import Fastify from "fastify";
import cookie from "@fastify/cookie";
import fastifyStatic from "@fastify/static";
import { config } from "./config.js";
import { authRoutes } from "./routes/auth.js";
import { apiRoutes } from "./routes/api.js";
import { demoRoutes } from "./routes/demo.js";

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
app.addContentTypeParser(
  "application/json",
  { parseAs: "string" },
  (_req, body, done) => {
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
await app.register(apiRoutes);

app.get("/app", (_req, reply) => reply.sendFile("app.html"));

await app.listen({ port: config.port, host: "0.0.0.0" });
app.log.info(`Mailwarden listening on ${config.appUrl}`);
