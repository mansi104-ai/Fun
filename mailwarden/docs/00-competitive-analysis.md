# Competitive Analysis — Inbox Cleaning Market (Aug 2026)

## 1. The Landscape

| Product | Price | Model | Scope used | Core weakness we exploit |
|---|---|---|---|---|
| **Unroll.me** | Free | **Sells your data.** Owned by NielsenIQ (ex-Slice Intelligence); scans full email bodies, sells anonymised purchase data to market researchers. | Full read | Toxic trust. Every "best alternative" article leads with the privacy scandal. Free but morally disqualified for anyone who reads the fine print. |
| **Clean Email** | $29.99/yr (1 acct), $9.99/mo, Pro $99.99/yr | Subscription | Full access | Powerful but **you are the architect** — huge rule surface, steep setup. Users must design their own cleanup. High cognitive load. |
| **Mailstrom** | $59.99/yr (bundles Chuck Pro iOS) | Subscription | **Metadata-only** | Strongest privacy story in market, but 2× Clean Email's price and metadata-only limits smart categorisation. |
| **Trimbox** | Freemium, aggressive | Subscription | Full access | **Best attack surface.** Reviews consistently cite: paywall after ~3 unsubscribes, "free tier feels misleading", unsubscribe errors, billing/currency bugs, nag-spam to upgrade. |
| **SaneBox** | ~$99/yr | Subscription | Full access | Filtering/triage, not bulk cleanup. Adjacent, not direct. |
| **Superhuman / Shortwave** | $30/mo / $20+/mo | Full email client | Full access | Different job-to-be-done: *replacing* Gmail, not cleaning it. 10-30× our price point. |

## 2. What Every Competitor Gets Wrong

Reading across review corpora, four failure modes repeat:

**(a) The bait-and-switch free tier.** Trimbox's dominant complaint. Users invest 10 minutes connecting an inbox, watch it scan, get a result — then hit a wall before a single action completes. The value was demonstrated but never *delivered*. This produces refund requests and 1-star reviews, not conversions.

**(b) Irreversible actions on a fuzzy signal.** "Delete all promotions" is terrifying because promotions contain receipts, boarding passes, and password resets. Users who have been burned once never return. Nobody has made the *undo* the headline feature.

**(c) Per-email cognitive load.** Clean Email surfaces thousands of messages and asks the user to build rules. But nobody has 3,000 opinions — they have about 200, one per *sender*. The unit of decision is wrong.

**(d) Privacy as fine print.** Unroll.me poisoned the well. Mailstrom is the only one that made privacy architectural, and it charges a premium for it.

## 3. Our Wedge — Four Decisions

### 3.1 Sender-level decisions, not email-level
A 40,000-message inbox is typically **150–400 distinct bulk senders**. We aggregate first, then ask for one decision per sender that resolves hundreds of emails. This is simultaneously:
- **Better UX** — 200 decisions instead of 40,000, and the user actually holds an opinion about each.
- **~100× cheaper inference** — we classify 200 senders, not 40,000 emails. This is what makes a genuinely useful free tier survivable on a 50-request/day budget (see `03-compliance`).

This is the single most important design decision in the product. Everything else follows from it.

### 3.2 Nothing is ever permanently deleted
We use `gmail.modify` and only ever **archive, label, or trash**. Trash sits in Gmail for 30 days and the user can restore from Gmail itself even if they cancel us. We never request `https://mail.google.com/`.

Three wins from one decision:
- Kills failure mode (b) — every action has a 30-day undo, and we say so on the button.
- Keeps us in **CASA Tier 2 (~$540–$1,800/yr)** instead of Tier 3 (~$4,500/yr).
- Lets us market "we are structurally incapable of losing your email" — a claim no full-access competitor can make.

### 3.3 The free tier must complete a real job
Trimbox's mistake is paywalling mid-job. Ours: the free tier **fully cleans your single largest problem** — the user picks their worst sender cohort and we execute it end to end, real archives, real numbers. They see the inbox count drop. *Then* we charge for the other 190 senders and for it staying clean.

You convert on delivered value, not withheld value. Free users become the marketing channel ("it archived 4,300 emails in 90 seconds") instead of the refund queue.

### 3.4 Consent is the interaction model, not a checkbox
Every batch is a **preview → explicit approve → execute → receipt** loop. Nothing moves without a click on a screen showing exactly what will move. The receipt is permanent and reversible. This directly serves the user's requirement ("by consent of the owner") and is also our CASA/OAuth review narrative.

## 4. Positioning

> **Clean Email** makes you the architect.
> **Unroll.me** makes you the product.
> **Mailwarden** makes ~200 decisions on your behalf, shows you every one before it happens, and can undo all of them.

**Price:** ₹299 once for the Backlog Pass — against Clean Email at $29.99/yr (~₹2,500) and Mailstrom at $59.99/yr (~₹5,000), switching is not a decision anybody has to think about. ₹149/month Pro adds the ongoing automation. We win on price at entry and on trust throughout.

The shape matters as much as the number. Every competitor here sells a subscription for a job that ends, which is why their churn is what it is. We charge once for the backlog and monthly only for the re-scan that genuinely recurs — see docs/02 §1.

## 5. Risks in This Analysis

- Pricing figures are from Aug-2026 secondary sources (comparison blogs, several published by competitors themselves — Mailstrom and Clean Email both run "alternatives" content marketing and are not neutral). **Verify pricing directly on each vendor's site before committing to our price ladder.**
- Trimbox complaint patterns are from review aggregators; they skew negative by nature. The *pattern* (paywall timing) is well-corroborated across independent sources; individual claims are not verified.
- Unroll.me's data practices are widely reported and were the subject of an FTC action, but confirm current practice before naming them in public marketing copy. **Attack the category practice, not the named company, in ads** — safer and just as effective.

## Sources
- [Best Unroll.me Alternatives 2026 — Mailstrom](https://mailstrom.co/articles/best-unroll-me-alternatives-2026/)
- [Unroll.me vs Clean Email — Leave Me Alone](https://leavemealone.com/blog/unroll-me-vs-clean-email/)
- [Clean Email Pricing 2026](https://mymarky.com/blog/clean-email-pricing-2026-plans-compared)
- [Best Trimbox Alternative — Clean Email](https://clean.email/blog/clean-email-alternatives/best-trimbox-alternative)
- [Trimbox Chrome extension reviews](https://chrome-stats.com/d/com.trimbox.app/reviews)
- [Trimbox Alternatives — againstdata](https://againstdata.com/blog/trimbox-alternatives)
- [Superhuman vs Shortwave — CMDK](https://cmdk.email/post/superhuman-vs-shortwave/)
