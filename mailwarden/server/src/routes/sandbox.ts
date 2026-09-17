import type { FastifyInstance } from "fastify";
import { CUSTOM_LIMITS, SANDBOX_INBOX, buildInbox } from "../sandbox/catalog.js";
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
 *   - no Gmail call is possible — there is no account and no token in scope;
 *   - the model tier is never invoked, so an anonymous caller cannot spend
 *     budget (see the note in sandbox/run.ts);
 *   - the request is bounded: catalogue picks resolve against a fixed list,
 *     visitor-written messages are capped and field-validated in
 *     `parseCustom`, and the combined inbox is truncated to
 *     CUSTOM_LIMITS.maxTotal.
 *
 * Which leaves CPU as the only cost, bounded at a few dozen messages of pure
 * in-memory work per request.
 *
 * A NOTE ON ACCEPTING VISITOR-WRITTEN MAIL
 *
 * This route originally took ids only, on the reasoning that accepting whole
 * messages would turn it into a "classify arbitrary text" API. Letting people
 * write their own test email is worth more than that caution was, and it does
 * not actually cost it: what the client sends is the same METADATA Gmail hands
 * us — sender, subject, age, size, labels, a handful of flags — and never a
 * body, because the pipeline's input type has nowhere to put one. A visitor
 * can type a password into the body field on /try.html, watch it redacted, and
 * confirm in their network tab that it was never in the request at all. That
 * is a better argument than refusing the feature was.
 */
export async function sandboxRoutes(app: FastifyInstance): Promise<void> {
  /** The samples a visitor picks from, and the ceilings the compose form obeys. */
  app.get("/api/demo/inbox", async (_req, reply) => {
    reply.header("Cache-Control", "public, max-age=3600");
    return { messages: SANDBOX_INBOX, limits: CUSTOM_LIMITS };
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
  app.post<{
    Body: { ids?: unknown; custom?: unknown; action?: unknown; confirmed?: unknown };
  }>(
    "/api/demo/run",
    async (req, reply) => {
      const picked = buildInbox(req.body?.ids, req.body?.custom);
      if (picked.length === 0) {
        return reply.code(400).send({ error: "no_messages_selected" });
      }

      const action = typeof req.body?.action === "string" ? req.body.action : "archive";
      return runSandbox(picked, action, req.body?.confirmed === true);
    },
  );
}
