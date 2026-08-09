# Mailwarden

Sender-level Gmail cleanup with consent-gated, fully reversible batch actions.

> **Clean Email** makes you the architect.
> **Unroll.me** makes you the product.
> **Mailwarden** makes ~200 decisions on your behalf, shows you every one before
> it happens, and can undo all of them.

## The three decisions everything follows from

**1 · The unit of decision is the sender, not the message.** A 40,000-message
inbox is ~200–400 distinct bulk senders. One decision per sender resolves
hundreds of emails. This is simultaneously better UX (people hold ~200 opinions,
not 40,000) and ~100× cheaper inference — which is what makes a genuinely useful
free tier survivable on OpenRouter's 50-request/day ceiling.

**2 · Nothing is ever permanently deleted.** We use `gmail.modify`, which can
archive, label, and trash but *cannot* permanently delete. Trash sits in Gmail
for 30 days and the user can restore it from Gmail itself. One decision buys
three wins: a real undo guarantee, CASA Tier 2 (~$540–$1,800/yr) instead of
Tier 3 (~$4,500/yr), and a marketing claim no full-access competitor can make.

**3 · Consent is the interaction model, not a checkbox.** Every batch is
preview → explicit approve → execute → receipt. Nothing moves without a click on
a screen showing exactly what will move, and `batch_items` records every
message's prior labels so the action reverses exactly.

## Read these first

| Doc | Why |
|---|---|
| [docs/03 — Compliance & launch path](docs/03-compliance-and-launch-path.md) | **Start here.** Decides whether and when you can take money. |
| [docs/00 — Competitive analysis](docs/00-competitive-analysis.md) | Who we're beating and on what. |
| [docs/02 — Business strategy](docs/02-business-strategy.md) | Pricing, unit economics, day-one revenue plan. |
| [docs/01 — 70-iteration roadmap](docs/01-roadmap-70-iterations.md) | Build order. Revenue is possible at iteration 22. |
| [docs/04 — UI design spec](docs/04-ui-design-spec.md) | The three screens and the interaction rules. |
| [docs/05 — Deployment runbook](docs/05-deployment-runbook.md) | Setup, Google Cloud, verification, launch. |
| [docs/06 — Safety model](docs/06-safety-model.md) | Every guardrail, why it exists, and how it's enforced. |

## See it working in 30 seconds — no Google account needed

```bash
cd server && pnpm install
ENABLE_DEMO=1 GOOGLE_CLIENT_ID=x GOOGLE_CLIENT_SECRET=x pnpm dev
# open http://localhost:8080/auth/demo
```

Seeds a synthetic 13,000-email inbox — including the traps: an airline filed
under Promotions, a bank, an OTP sender, and a colleague you replied to. Watch
the guardrails lock all four while the tiles stay clickable.

## Quick start (real inbox)

```bash
cd server
pnpm install                  # use pnpm — npm is broken on this machine, see docs/05
cp ../.env.example ../.env    # fill in GOOGLE_CLIENT_ID / SECRET at minimum
pnpm exec tsx src/smoke.ts    # 47 offline safety checks, no keys needed
pnpm dev                      # http://localhost:8080
```

## The interface

Two layers, because "powerful" and "easy" are different jobs:

**One-click tiles** (default). A grid of named jobs — *Marketing you never
open*, *Social notifications*, *Biggest storage users* — each showing a live
count. Pick one, see exactly what happens, press one button. No configuration,
the way iLovePDF has one page per job.

Every tile's number is **guard-accurate**: it comes from running the real safety
policy in dry-run, so the count on the tile is exactly what will happen. A tile
that promises 2,341 and delivers 1,800 destroys trust faster than one that never
existed.

**Sender-by-sender review** (advanced). The full 300-card surface for people who
want it, one click away.

## Architecture

```
web/index.html          Landing + pre-consent explainer
web/app.html            Three screens: Scan → Review → Receipt

server/src/
  config.ts             Env, scopes (gmail.modify only — never mail.google.com)
  db.ts                 Schema. No bodies, no plaintext subjects, no recipients.
  lib/crypto.ts         AES-256-GCM refresh-token encryption, session HMAC
  lib/entitlements.ts   Server-enforced plan gates
  gmail/client.ts       OAuth client, From-header parsing
  gmail/sync.ts         Metadata-only sync → per-sender aggregation
  gmail/executor.ts     plan → execute → undo (batchModify)
  classify/
    taxonomy.ts         Categories; which are protected vs actionable
    heuristics.ts       Deterministic tier — resolves most senders for free
    llm.ts              Batched sender-level tier; OpenRouter (free) / Claude (paid)
    index.ts            Two-tier orchestration
  routes/               auth.ts, api.ts
  smoke.ts              Offline test of the safety-critical paths
```

### Classification is two-tier on purpose

Deterministic heuristics resolve the bulk of senders offline and for free. Only
the genuinely ambiguous remainder reaches a model, batched 50 senders per
request. On a typical inbox that's ~3 model calls instead of tens of thousands
— roughly **$0.05–$0.15 per full scan**, and it degrades to heuristics-only
rather than failing when the LLM budget is exhausted.

Protective rules run first and win. A false "security" costs the user nothing;
a false "promotional" costs them a password reset.

### What reaches a third-party model

Only aggregate, content-free sender statistics: domain, display name, message
count, unread rate, date span, whether a `List-Unsubscribe` header is present,
Gmail's own category labels, and a subject-*template* ratio derived from salted
hashes. **Never a subject line, a body, or a recipient address.** That isn't a
compromise made for compliance — it falls out of the sender-level architecture
for free.

## Guardrails

There is exactly one path from a click to a mailbox change, and it passes
through [`safety/policy.ts`](server/src/safety/policy.ts). `batchModify` is
called from one file, which cannot reach it without a guard verdict — and a
test scans the source to keep that true.

Guards produce three outcomes: **exclude** (drop those senders, report why, run
the rest), **confirm** (legal but unusual, needs a second approval), **block**
(fail closed). Protection narrows a batch; it never cancels one.

The rule that matters most: **a clean plan is not an authorisation to execute.**
`executeBatch` re-derives every block guard from current state, because a sender
can be reclassified or pinned between planning and execution. Full spec in
[docs/06](docs/06-safety-model.md).

## Status

Typecheck clean. **48/48 offline checks pass** (`pnpm exec tsx src/smoke.ts`) —
protective heuristics, every guardrail in both directions, TOCTOU
re-validation, plan persistence, entitlement gating, and a source scan for
forbidden Gmail APIs. Server boots and serves; auth gating and security headers
verified.

Everything requiring live Google credentials (OAuth round-trip, real sync,
`batchModify`) is **unverified** — that's the only place the guardrails haven't
run end to end. Stripe, the unsubscribe engine, and scheduled re-scans are not
implemented; see [docs/05 §6](docs/05-deployment-runbook.md) for the honest gap
list and [docs/01](docs/01-roadmap-70-iterations.md) for per-iteration status.
