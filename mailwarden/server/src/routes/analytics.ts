import type { FastifyInstance } from "fastify";

import { analyticsSummary, recordWebEvent } from "../analytics.js";
import { db } from "../db.js";
import { isAdmin } from "../lib/billing.js";
import { currentUserId } from "./auth.js";

/**
 * Kept in its own file rather than folded into api.ts for one reason: `/api/e`
 * is the only route in the app that accepts a write from someone with no
 * account and no session. That property deserves to be visible in the file
 * tree, not buried among forty account-scoped handlers where the next person
 * adding a route might copy the wrong neighbour.
 *
 * Everything that makes it safe to expose lives in analytics.ts: a fixed event
 * vocabulary, a fixed path list, a per-visitor rate ceiling, and the rule that
 * the server derives every field it stores rather than trusting one.
 */
export async function analyticsRoutes(app: FastifyInstance): Promise<void> {
  /**
   * Public event sink.
   *
   * Always answers 204, whether the event was stored or dropped. A tracker that
   * reports which payloads it rejected can be probed for its allowlist, and the
   * browser has nothing useful to do with the answer either way — sendBeacon
   * cannot read a response at all.
   */
  app.post<{ Body: { name?: string; path?: string; query?: string; ref?: string } }>(
    "/api/e",
    async (req, reply) => {
      const body = req.body ?? {};
      recordWebEvent({
        name: String(body.name ?? ""),
        path: typeof body.path === "string" ? body.path.slice(0, 200) : undefined,
        query: typeof body.query === "string" ? body.query.slice(0, 500) : undefined,
        // The client's own value, not the Referer header: on a same-page event
        // the header points at us, which would erase the acquisition source.
        referrer: typeof body.ref === "string" ? body.ref.slice(0, 500) : undefined,
        ip: req.ip,
        userAgent: String(req.headers["user-agent"] ?? ""),
        selfHost: req.hostname,
      });
      return reply.code(204).send();
    },
  );

  /**
   * The operator's dashboard feed.
   *
   * Gated on ADMIN_EMAIL exactly like the payment queue — and for the same
   * reason: the operator is normally on the free plan, so any plan-based gate
   * locks them out and hands the data to paying customers instead.
   */
  app.get<{ Querystring: { days?: string } }>("/api/admin/analytics", async (req, reply) => {
    const userId = currentUserId(req.cookies);
    if (!userId) return reply.code(401).send({ error: "not_authenticated" });
    const me = db.prepare(`SELECT email FROM users WHERE id = ?`).get(userId) as
      | { email: string }
      | undefined;
    if (!isAdmin(me?.email)) return reply.code(403).send({ error: "forbidden" });

    const days = Math.min(90, Math.max(1, Number(req.query.days ?? 7) || 7));
    return analyticsSummary(days);
  });
}
