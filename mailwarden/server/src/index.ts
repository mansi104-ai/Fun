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
