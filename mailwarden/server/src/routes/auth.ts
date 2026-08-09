import type { FastifyInstance } from "fastify";
import { google } from "googleapis";
import { config } from "../config.js";
import { audit, db, now } from "../db.js";
import { consentUrl, oauthClient } from "../gmail/client.js";
import { encryptToken, newId, signSession, verifySession } from "../lib/crypto.js";

const SESSION_COOKIE = "mw_session";

export function currentUserId(cookies: Record<string, string | undefined>): string | null {
  return verifySession(cookies[SESSION_COOKIE]);
}

export async function authRoutes(app: FastifyInstance): Promise<void> {
  /** Pre-consent explainer lives on the frontend; this is the redirect itself. */
  app.get("/auth/google", async (req, reply) => {
    const state = newId("st");
    reply.setCookie("mw_oauth_state", state, {
      httpOnly: true,
      sameSite: "lax",
      secure: config.isProd,
      path: "/",
      maxAge: 600,
    });
    return reply.redirect(consentUrl(state));
  });

  app.get<{ Querystring: { code?: string; state?: string; error?: string } }>(
    "/auth/google/callback",
    async (req, reply) => {
      const { code, state, error } = req.query;
      if (error) return reply.redirect(`/?error=${encodeURIComponent(error)}`);
      if (!code) return reply.redirect("/?error=missing_code");
      if (!state || state !== req.cookies["mw_oauth_state"]) {
        return reply.redirect("/?error=state_mismatch");
      }

      const client = oauthClient();
      const { tokens } = await client.getToken(code);
      client.setCredentials(tokens);

      if (!tokens.refresh_token) {
        // Google only issues a refresh token on first consent unless we force
        // prompt=consent, which we do. If it is still missing, the user must
        // revoke access at myaccount.google.com and reconnect.
        return reply.redirect("/?error=no_refresh_token");
      }

      const oauth2 = google.oauth2({ version: "v2", auth: client });
      const profile = await oauth2.userinfo.get();
      const email = profile.data.email;
      if (!email) return reply.redirect("/?error=no_email");

      const existing = db.prepare(`SELECT id FROM users WHERE email = ?`).get(email) as
        | { id: string }
        | undefined;

      const userId = existing?.id ?? newId("usr");
      if (!existing) {
        db.prepare(
          `INSERT INTO users (id, email, plan, created_at, updated_at) VALUES (?, ?, 'free', ?, ?)`,
        ).run(userId, email, now(), now());
      }

      const account = db
        .prepare(`SELECT id FROM accounts WHERE user_id = ? AND email = ?`)
        .get(userId, email) as { id: string } | undefined;

      const encrypted = encryptToken(tokens.refresh_token);
      if (account) {
        db.prepare(
          `UPDATE accounts SET refresh_token_enc = ?, sync_state = 'idle' WHERE id = ?`,
        ).run(encrypted, account.id);
      } else {
        db.prepare(
          `INSERT INTO accounts (id, user_id, email, refresh_token_enc, created_at)
           VALUES (?, ?, ?, ?, ?)`,
        ).run(newId("acc"), userId, email, encrypted, now());
      }

      audit(userId, "account.connected", { email });

      reply.setCookie(SESSION_COOKIE, signSession(userId), {
        httpOnly: true,
        sameSite: "lax",
        secure: config.isProd,
        path: "/",
        maxAge: 60 * 60 * 24 * 30,
      });
      reply.clearCookie("mw_oauth_state", { path: "/" });
      return reply.redirect("/app");
    },
  );

  app.post("/auth/logout", async (_req, reply) => {
    reply.clearCookie(SESSION_COOKIE, { path: "/" });
    return { ok: true };
  });

  /**
   * Full disconnect: revokes the token at Google and purges every trace.
   * Advertised on the button itself, and required for OAuth verification.
   */
  app.post("/auth/disconnect", async (req, reply) => {
    const userId = currentUserId(req.cookies);
    if (!userId) return reply.code(401).send({ error: "not_authenticated" });

    const accounts = db.prepare(`SELECT id FROM accounts WHERE user_id = ?`).all(userId) as {
      id: string;
    }[];

    for (const acc of accounts) {
      try {
        const row = db
          .prepare(`SELECT refresh_token_enc FROM accounts WHERE id = ?`)
          .get(acc.id) as { refresh_token_enc: string };
        const { decryptToken } = await import("../lib/crypto.js");
        await oauthClient().revokeToken(decryptToken(row.refresh_token_enc));
      } catch {
        // Revocation can fail if the user already revoked from Google's side.
        // Purge locally regardless — their data must not survive the request.
      }
    }

    audit(userId, "account.disconnected");
    db.prepare(`DELETE FROM users WHERE id = ?`).run(userId); // cascades
    reply.clearCookie(SESSION_COOKIE, { path: "/" });
    return { ok: true, purged: true };
  });
}
