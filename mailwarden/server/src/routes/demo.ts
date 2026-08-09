import type { FastifyInstance } from "fastify";
import { config } from "../config.js";
import { audit, db } from "../db.js";
import { signSession } from "../lib/crypto.js";
import { seedDemoInbox } from "../demo/seed.js";

/**
 * Demo routes are registered ONLY when both conditions hold:
 *   NODE_ENV !== "production"   and   ENABLE_DEMO === "1"
 *
 * Two independent gates rather than one, because a single misconfigured env var
 * should not be able to expose a route that mints an authenticated session
 * without any credential check.
 */
export function demoEnabled(): boolean {
  return !config.isProd && process.env.ENABLE_DEMO === "1";
}

export async function demoRoutes(app: FastifyInstance): Promise<void> {
  if (!demoEnabled()) return;

  app.log.warn(
    "[demo] Demo mode is ENABLED. /auth/demo will mint sessions without credentials. " +
      "Never run this configuration in production.",
  );

  /**
   * Creates a synthetic inbox and signs the caller in to it.
   *
   * The demo account carries no Gmail token, so every mutating call fails at
   * the Gmail client rather than silently pretending to succeed — the UI is
   * fully explorable, but nothing claims to have moved mail that didn't.
   */
  app.get("/auth/demo", async (_req, reply) => {
    const { userId, email } = seedDemoInbox();
    audit(userId, "demo.session_created", { email });

    reply.setCookie("mw_session", signSession(userId), {
      httpOnly: true,
      sameSite: "lax",
      secure: false,
      path: "/",
      maxAge: 60 * 60 * 6,
    });
    return reply.redirect("/app?demo=1");
  });

  /** Clears every demo account, so repeated exploration doesn't accumulate. */
  app.post("/auth/demo/reset", async (_req, reply) => {
    const rows = db
      .prepare(`SELECT id FROM users WHERE email LIKE 'demo-%@mailwarden.local'`)
      .all() as { id: string }[];
    for (const r of rows) db.prepare(`DELETE FROM users WHERE id = ?`).run(r.id);
    reply.clearCookie("mw_session", { path: "/" });
    return { cleared: rows.length };
  });
}
