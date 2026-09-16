import type { FastifyInstance } from "fastify";
import { SANDBOX_INBOX, resolve } from "../sandbox/catalog.js";
import { runSandbox } from "../sandbox/run.js";

/**
 * THE PUBLIC SANDBOX — /try.html talks to these two routes.
 *
 * Not to be confused with routes/demo.ts. That one mints a session without a
 * credential and is gated behind two independent env checks because it must
 * never run in production. This one ships TO production on purpose: it is the
 * answer to "why should I believe your safety claims before I hand you my
 * mailbox?", and an answer that only exists on localhost persuades nobody.
 *
 * It is safe to expose because of what it cannot do, not because of who can
 * call it:
 *
 *   - no session is read or written, and no cookie is set;
 *   - nothing is written to the database, so there is no state to poison;
 *   - the message catalogue is server-side and the client sends only ids, so
 *     the request body cannot grow the work beyond a fixed, small bound;
 *   - no Gmail call is possible — there is no account and no token in scope;
 *   - the model tier is never invoked, so an anonymous caller cannot spend
 *     budget (see the note in sandbox/run.ts).
 *
 * Which leaves CPU as the only cost, bounded at roughly fifteen messages of
 * pure in-memory work per request.
 */
export async function sandboxRoutes(app: FastifyInstance): Promise<void> {
  /** The inbox a visitor picks from. Static — cache it at the edge. */
  app.get("/api/demo/inbox", async (_req, reply) => {
    reply.header("Cache-Control", "public, max-age=3600");
    return { messages: SANDBOX_INBOX };
  });

  /**
   * Runs the real pipeline over the chosen messages and returns the trace.
   *
   * `action` is passed through UNVALIDATED, deliberately. The page offers
   * "Delete permanently" as a third button, and the honest way to show that
   * Mailwarden refuses it is to let the request reach the guard layer and be
   * blocked by G1 — not to grey the button out client-side and ask to be
   * believed. Anything that is not `archive` or `trash` fails closed there.
   */
  app.post<{ Body: { ids?: unknown; action?: unknown; confirmed?: unknown } }>(
    "/api/demo/run",
    async (req, reply) => {
      const picked = resolve(req.body?.ids);
      if (picked.length === 0) {
        return reply.code(400).send({ error: "no_messages_selected" });
      }

      const action = typeof req.body?.action === "string" ? req.body.action : "archive";
      return runSandbox(picked, action, req.body?.confirmed === true);
    },
  );
}
