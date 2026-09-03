# Distribution & Outreach Funnel — MailWarden Article Series

*How Article 1 (and the four that follow) turn into portfolio content, build-in-public momentum, and actual freelance/client conversations.*

## The funnel, in order

**Medium → portfolio blog → Twitter/HN/Reddit build-in-public → video recordings → client/freelancer outreach → public reach.**

Each stage reuses the same material — nothing gets rewritten from scratch at each step, it gets re-cut for the platform.

---

## 1. Medium (the source article)

Publish in series order (1→5), roughly one every 5-7 days so each gets room to be found on its own before the next lands. Use Medium's own "Add to a publication" if you get access to a relevant one later (Better Programming, Level Up Coding, The Startup) — bigger built-in reach than your own follower count for articles 2 and 3 especially, since they're the most broadly technical.

Each article should end with the same two links: the live app (mailwarden.xyz) and the next article in the series once it's live (Article 1 already links forward — update that link once Article 2 publishes).

## 2. Portfolio blog — needs to exist first

I checked: `Portfolio_documents.github.io` is currently a single static `index.html` with no blog or writing section. Two options, in order of effort:

- **Fast (do this before Article 1 goes to Medium):** add a "Writing" section to the existing page — a short list of article titles, one-line summaries, and dates, each linking out to the Medium post. This is a 20-30 minute change, not a redesign.
- **Better, if there's time before Article 2:** a proper `/blog` or `/writing` route that either mirrors the article content directly (better SEO, you own the traffic) or at minimum hosts the same headline + diagram + a "read the full piece" link to Medium. Since it's a GitHub Pages static site, a handful of hand-written HTML pages (matching the site's current styling) would do it without adding a framework.

Either way, do this **before** Article 1 publishes on Medium — a client who clicks through from Medium to your portfolio and finds no trace of the series undercuts the exact thing the series is supposed to prove.

## 3. Build-in-public: Twitter, HN, Reddit

Each article yields 2-3 posts, not one link-drop:

- **Twitter:** the pull-quote as its own tweet (Article 1: *"23× fewer decisions for the user, ~100× cheaper inference — and it's the same fact."*), one of the diagrams posted natively as an image (not just linked), then the article link itself 1-2 days later once the first two have had time to earn their own engagement.
- **Hacker News:** Articles 2, 3, and 5 are the ones with real HN appeal — they're systems/safety-engineering content, not product marketing. Submit as `Show HN:` only if you're pairing it with something interactive; otherwise submit as a plain story link with a title that states the finding, not the product ("The one file that's allowed to touch your inbox" travels better on HN than "MailWarden's safety architecture").
- **Reddit:** r/programming or r/webdev for the architecture pieces (2, 3, 5), same disclosure-up-front norm your launch posts already used ("I built this, sharing the design decision because I think it's interesting on its own"). r/SaaS or r/EntrepreneurRideAlong for the more narrative pieces (1, 4) if you want founder-audience reach instead of engineer-audience reach.

## 4. Video recordings

Four clips are flagged across the series plan as genuinely worth recording, roughly in order of how easy they are to produce:

1. **Demo-mode walkthrough** (Article 1) — `ENABLE_DEMO=1`, the synthetic 13,000-email inbox, watching all four traps get caught live. Deterministic, no real Gmail account needed, easiest to record well.
2. **Sync-speed split-screen** (Article 2) — full sync vs. incremental sync side by side, 218.6s → 0.7s.
3. **Guard-rejection live** (Article 3) — trip a protected-sender guard inside a larger batch, show the UI narrow it and explain why.
4. **Smoke-test run** (Article 5) — `pnpm exec tsx src/smoke.ts`, 139 checks passing in the terminal.

These double as raw material for [[youtube-ai-channel]] if that channel gets going, and as standalone embeds inside the portfolio blog posts even before any channel exists — a 20-30 second clip embedded in a blog post does more for credibility than the same claim in prose.

## 5. Client / freelancer outreach — using the series as proof of work

Once 2-3 articles are live, stop pitching "I do AI engineering" cold and start pointing at the series instead. Three outreach angles, matched to what each article proves:

**A. Cold outreach to teams hiring for agentic/AI-safety work.** Lead with Article 3 (the guardrail chokepoint) or Article 4 (data minimization) — these are the two that read as "this person has actually shipped a production safety model," which is exactly what that hiring manager is trying to assess from a portfolio.

> Subject: A real guardrail chokepoint, not a pitch
>
> Hi [name] — saw [company] is building [agentic feature]. I wrote up the safety architecture behind a Gmail agent I built solo: one chokepoint every mutation passes through, 15 guards, re-validated at execute time so a stale plan can't act on stale state. [link to Article 3]
>
> Not pitching anything — just thought the TOCTOU-style re-validation pattern might be relevant to what you're building. Happy to talk through it if useful.

**B. Freelance-platform profiles (Upwork, Contra, Braintrust, etc.).** Link Article 2 or 5 directly in the profile "portfolio" section rather than just the live app — a hiring client skimming profiles reads "here's a real architecture decision and the bug it caused" as evidence much faster than a live demo they may not click into.

**C. Warm outreach to your existing network** (the same Peerlist/Twitter following that's already engaged with the launch posts). This is the easiest conversion path since they've already seen you ship — a simple "wrote up how the safety model actually works, if you know anyone hiring for this kind of thing I'd appreciate a pointer" post performs better here than a cold pitch would anywhere else.

## 6. Reach out in public and get clients

The compounding move: once 3+ articles exist, every future post (launch update, bug-fix note, a new feature) can reference back into the series instead of re-explaining from scratch — "same chokepoint from the safety-model piece, now also gates X" builds a body of work a reader can trust incrementally, rather than a single claim they have to take on faith. That accumulated, linkable proof-of-work is what turns "interesting Twitter account" into inbound client interest — it's a slower path than cold outreach, but it's the one that keeps working after any single outreach message stops being read.

---

## Suggested near-term sequence

1. Add the portfolio "Writing" section (30 min).
2. Publish Article 1 on Medium; same day, portfolio link goes live; same day, the pull-quote + diagram tweet + Medium link (3 tweets, spaced).
3. Record the demo-mode walkthrough clip and post it as a standalone tweet/reel within the week — it doesn't need to wait for Article 2.
4. Say the word when you're ready and I'll write Article 2 (sync + classification) so it's ready before the 5-7 day gap closes.
