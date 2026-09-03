# MailWarden Content Series — Architecture Deep-Dive (5 Articles)

*Grounded in the real `server/src` codebase and internal docs (`docs/06-safety-model.md`, `docs/07-agent-architecture.md`, `docs/09-brand.md`) — every number and code claim below is from your actual repo, not invented for the post.*

## Why this order

Your architecture already breaks into five self-contained ideas, each with its own real numbers, its own real bug story, and its own natural visual. That's the whole content strategy: don't write "MailWarden's architecture" as one giant post — each idea below is a complete Medium article, a complete portfolio post, and a complete Twitter thread on its own, and each one doubles as proof-of-work for freelance/client outreach (this is what "I can build production-grade agentic systems with real safety guarantees" looks like, shown rather than claimed).

| # | Article | The one idea | Real numbers to anchor it |
|---|---|---|---|
| 1 | Why I stopped trusting full-access inbox tools | Sender-level decisions + never-delete scope + consent-as-interaction | 261 senders from 6,010 messages; `gmail.modify` can't delete |
| 2 | The architecture of an agent people can trust with their data | Reference design (UI / agent / backend), Clean tab as case study | Written in AI-architect voice, not founder voice — see below |
| 3 | The one file that's allowed to touch your inbox | The guardrail chokepoint + TOCTOU | 15 guards; 40% scale-anomaly threshold; the un-releasable "replied-to" rule |
| 4 | What your AI cleanup tool shouldn't know about you | Data minimization as a safety property, not compliance | CASA Tier 2 ($540–1,800/yr) vs Tier 3 (~$4,500/yr); salted subject hashes |
| 5 | 139 tests, 3 real bugs, and what's still broken | Testing discipline + radical honesty about gaps | 139 offline + 23 e2e checks; the 33%-of-mailbox reply-ratio bug; the 240px CSS bug |

---

## Article 1 — "Why I Stopped Trusting Full-Access Gmail Cleanup Tools (And Built My Own)"

**Status: written in full — delivered separately as `mailwarden-medium-article-1.md`.**

- **Text:** origin story → the three decisions (sender-level, never-delete, consent-as-interaction) → the 18k→3k receipt → honest beta framing → CTA.
- **Images (2, delivered):** "Message-level vs. sender-level" comparison graphic (40,000 emails vs. ~200 decisions); "The three decisions" pillar graphic.
- **Screen recording (for the portfolio/video cut, not required for Medium):** the demo-mode walkthrough from your own README — `ENABLE_DEMO=1`, the synthetic 13,000-email inbox with the four traps (airline in Promotions, a bank, an OTP sender, a replied-to colleague), watching the guardrails lock all four live. This is the single best 90-second demo you have because it's deterministic and needs no real Gmail account.

## Article 2 — "The Architecture of an AI Agent People Can Actually Trust With Their Data"

**Status: written in full — delivered as `mailwarden-medium-article-2.md`.** Reframed at your request to be written **solely in an AI-architect voice** — third-person reference-design writing, not the founder-narrative voice of Article 1. It takes one real, shipped piece of MailWarden (the **Clean tab** — the three-queue Clean/Review/Protected system) as a fully worked case study, then generalizes the pattern so a reader could use it as a blueprint for a completely different product (file cleanup, subscription management, a code-refactoring agent — anything where software gets write access to something that matters).

- **Text:** three layers, each solving one of the three problems every "AI agent with write access" product faces — (1) UI: confidence surfaced as distinct queues, evidence over generated prose, guard-accurate counts; (2) classification agent: cheap-tiered classification, content-minimal projections to any model, aggregate to the unit the user thinks in; (3) guardrail backend: single mutation chokepoint enforced by a source-scanning test, three guard outcomes (block/confirm/exclude) instead of a binary allow/deny, the TOCTOU re-validation rule, an undo ledger recorded before mutation. Closes with the full 7-step request lifecycle traced end to end, and a "building this for something that isn't email" generalization section.
- **Images (2, delivered):** a three-layer reference-architecture diagram (UI → Classification Agent → Guardrail Backend, with the guard-accurate-counts feedback loop back to the UI) and a guard-taxonomy diagram (block / confirm / exclude as three distinct outcomes, not a binary).
- **Screen recording:** the guard-rejection demo originally flagged for Article 3 fits just as well here — trip `PROTECTED_CATEGORY` inside a larger batch from the Clean tab and show the UI narrow it with a stated reason, which is the exclude-outcome claim made visible.

## (Originally-planned Article 2, now folded into the series as a later piece) — "How 6,010 Emails Become 261 Decisions"

Still worth writing — the sync + classification numbers piece (218.6s→0.7s sync, 51% resolved free, $0.05–$0.15/scan, the reply-ratio bug) — just no longer next in the queue now that Article 2's slot went to the reference-architecture piece. Slot it in as Article 3 or later; the rest of the original series (guardrail chokepoint, data minimization, testing/honesty) still holds, minus the guardrail deep-dive material that Article 2 already covers from the "AI architect" angle — that piece should now focus on what Article 2 didn't: the specific 15 named guards, the un-releasable replied-to rule, and the message-level-guard-gap bug story, rather than re-explaining the chokepoint concept itself.

## Article 3 — "The One File That's Allowed to Touch Your Inbox"

The safety-model piece, framed around the chokepoint rather than a guard-by-guard list (a list of 15 guards is reference material, not a story — the chokepoint is the story).

- **Text:** "there is exactly one path from a click to a mailbox change" → block/confirm/exclude as three outcomes because collapsing them makes either a nagging or unsafe product → the TOCTOU rule (a clean plan is not an authorization to execute) → the un-releasable rule ("replied-to" can't be overridden by the user, on purpose) → the message-level-guard gap discovered only after the first real cleanup (sender-level guards left every message from an actionable sender actionable, including the one with the boarding pass).
- **Images:** the guard hierarchy (sender-level → message-level → batch-level) as a layered diagram; the consent-loop sequence diagram from `docs/07` §8, redrawn.
- **Screen recording:** attempt to clean a sender that trips `PROTECTED_CATEGORY` or `REPLIED_SENDER` inside a larger batch, and show the UI narrowing the batch and stating exactly why — "protection narrows a batch, it never cancels one" is much more convincing shown than claimed.

## Article 4 — "What Your AI Cleanup Tool Shouldn't Know About You"

The privacy/data-minimization piece — this is the one most likely to travel outside your existing audience, since "what does the AI agent that reads my email actually see" is a broader, more searchable anxiety than inbox clutter itself.

- **Text:** metadata-only sync (`format: "metadata"`, explicit header allowlist) → salted subject hashes instead of plaintext → the content-free projection sent to the LLM (domain, counts, rates, ratios — never a subject, body, or address) → why this wasn't a compliance add-on but fell out of the sender-level design for free → the CASA Tier cost story (~$540–1,800/yr at Tier 2 vs. ~$4,500/yr at Tier 3, and the tier is a direct consequence of the scope decision) → the failure-posture table (every failure mode degrades toward doing less, never more).
- **Images:** a "what's stored vs. what's not" diagram (subject hash / no body / no recipient) and a "what reaches the LLM" diagram, side by side.
- **Screen recording:** not essential here — this article leans on the failure-posture table and the cost numbers more than a live demo. A static callout-card graphic works better than video.

## Article 5 — "139 Tests, 3 Real Bugs, and What's Still Broken"

The wrap-up/credibility piece, and the one to time closest to any client outreach push — it's the article that reads most like "here's how I actually work," which is what freelance/client prospects are evaluating you on.

- **Text:** the `smoke.ts` invariant suite (139 offline checks that fail the build if `messages.delete`/`batchDelete`/`mail.google.com` ever appear, or if a second caller of `batchModify` shows up) → three real bugs in your own words: the reply-ratio bug, the message-level-guard gap, the 240px mobile CSS bug (`flex-basis` following the main axis) and how you caught it (measuring `scrollWidth`/`clientWidth`, not eyeballing a screenshot) → the honest known-gaps table from `docs/07 §11` (undo never run against live Gmail, SQLite/single-instance, no scheduled re-scan yet, no Stripe yet) → why shipping the gaps list publicly is itself the trust move, not a liability.
- **Images:** a simple before/after of the CSS bug (240px-tall input vs. fixed), and a "known gaps" honesty-card graphic.
- **Screen recording:** running `pnpm exec tsx src/smoke.ts` live and watching 139 checks pass in the terminal — genuinely compelling as a 20-second clip, and it's the single most "prove it" piece of content in the whole series.

---

## How this maps to your funnel

1. **Medium** — full articles, in this order, roughly one every 5-7 days so each has room to be found on its own.
2. **Portfolio blog** — your `Portfolio_documents.github.io` site is currently a single static `index.html` with no blog section; cross-posting means either adding a `/blog` (or `/writing`) section that links out to (or mirrors) each Medium post, or a simple "Writing" list with dates and one-line summaries. Worth doing before Article 1 goes up on Medium, since a client who clicks through from Medium to your portfolio and finds no trace of it undercuts the whole point.
3. **Twitter/HN/Reddit, build-in-public** — each article yields 2-3 tweets (the pull-quote, a diagram, a "here's the bug I found" post) rather than one "new blog post" link-drop, spread across the days around each Medium publish. r/programming, r/webdev or r/SaaS can take the more technical articles (2, 3, 5) natively, framed as "I built X, here's the safety model" — same disclosure-up-front norms your launch posts already used.
4. **Video recordings** — the three flagged above (demo-mode walkthrough, sync-speed split-screen, guard-rejection live, smoke-test run) are your highest-leverage clips; they can also be cut down into Shorts/reels per [[youtube-ai-channel]] channel plan, or used standalone even without the full channel launching first.
5. **Outreach to clients/freelancers** — once 2-3 articles are live, the series itself becomes the outreach asset: instead of a cold "I do AI engineering," you link the safety-model article to anyone hiring for agentic/AI-safety work. It's demonstrated rigor, not a claim.

## Next steps

- Article 1 is done — copy/diagrams delivered.
- Say the word and I'll write Article 2 next (sync + classification), or start on the portfolio `/blog` section first so Article 1 has somewhere to land on your own site before it goes to Medium.
