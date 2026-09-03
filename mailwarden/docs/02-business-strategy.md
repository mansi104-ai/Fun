# Monetisation & Business Strategy

## 0. The Honest Constraint, Stated First

**You cannot open a public paid funnel today.** Google OAuth verification for restricted scopes takes 4–6 weeks, and CASA Tier 2 takes another 1–3 weeks after that. Any plan that assumes public signups this week is wrong.

**But you can take money today**, because an unverified app can serve **100 users in Testing mode immediately** — real inboxes, real cleanups, real payments. The entire day-one strategy is built on that 100-user allowance, and it is a genuinely good position: scarcity you can describe honestly, a small enough cohort to support personally, and cash that arrives before you spend a rupee on compliance.

---

## 1. Price Ladder

| Plan | Price | What it is |
|---|---|---|
| **Free** | ₹0 | Full scan, full classification, **1,000 messages cleaned per month**, 3 unsubscribes. No card. |
| **Backlog Pass** | **₹299 once** | 50,000 messages and 50 unsubscribes, 60 days. The job. |
| **Pro** | **₹149/month** | Scheduled re-scans, 25,000 messages and 25 unsubscribes a month, 5 accounts. The habit. |

> **Superseded 3 September 2026.** The table above is current. The dollar
> pricing this section used to carry — $19/yr Starter, $39/yr Pro, $49 Founding
> 100 — was retired, for three reasons worth keeping:
>
> 1. **The audience is Indian and the price was a straight currency
>    conversion.** ₹1,499/month is what $19 became, and it is not a number this
>    market pays for a mail utility.
> 2. **Metering by "cleanup" was the wrong unit.** A batch is not something
>    anybody experiences; a mailbox of 5,400 promotional messages is. Volume is
>    both what the user consumes and what costs us to serve.
> 3. **Founding 100 rested on a condition that has now expired.** It was sold
>    on Google's 100-user Testing cap — "the scarcity is real, not
>    manufactured". Verification cleared, so it is retired rather than
>    converted into invented scarcity. Zero seats had been sold.
>
> §115 below is the reason for the two-product shape: cleanup is a job, not a
> habit. The Backlog Pass is priced as the job, Pro as the habit, and the free
> tier refills monthly at roughly a month of ordinary promotional mail — so an
> inbox that is under control is never charged for, and only a backlog is.

**Why ₹299 for the pass:** Clean Email is $29.99/yr and Mailstrom is $59.99/yr — roughly ₹2,500 and ₹5,000. At ₹299 once, the switching decision stops being a decision. We do not compete on features at the entry tier: we compete on trust and on the sender-level UX, and we price so that trying us is cheaper than thinking about it.

**Why the pass is sized at 50,000, not tightly metered:** the validated reference inbox was 6,010 messages, so the pass is eight times the largest mailbox actually measured. A pass that runs out mid-cleanup sends the buyer back to a payment queue a human clears by hand, at the exact moment their intent is highest. One payment, one confirmation, job done is worth more than the few rupees a tighter cap earns.

**Why Pro is monthly and the pass is not:** this is a job people do a few times a year, not daily — so charging monthly for the *job* invites cancellation the moment the inbox looks clean, and deserves it. Pro bills monthly because scheduled re-scan is a service that runs monthly. The distinction is the whole pricing argument: charge once for the thing that finishes, and recurringly only for the thing that recurs.

---

## 2. The Day-One Money Play

> **Superseded 3 September 2026 — kept as the record of why the founding tier
> existed.** OAuth verification has cleared, so the 100-user cap that made
> "only 100 exist" a true statement is gone, and the tier is retired with zero
> seats sold. The reasoning below is still the right reasoning; the constraint
> it was answering no longer applies. CASA Tier 2 now has to be funded from
> Backlog Pass volume instead — at ₹299, that is roughly 150–500 sales rather
> than 11–37, which is a materially harder first milestone and should be
> planned for as such.


**The Founding 100 lifetime deal is the entire revenue plan for month one**, and it is not a growth hack — it is exactly matched to the constraint. The 100-user cap is imposed by Google, so "only 100 exist" is a true statement, and it is the rare scarcity claim you can make without embarrassment.

```
100 seats × $49 = $4,900
```

That single number covers CASA Tier 2 ($540–$1,800), a domain, a year of hosting, and the Stripe fees, with several thousand left over. **Compliance is funded by customers rather than out of pocket, before you have spent anything.** That is the whole reason to run the founding tier at $49 instead of shipping straight to $19/yr.

### Today, in order

1. **Buy the domain and stand up the landing page.** The waitlist form needs no OAuth, no verification, no approval. It can be live in an hour.
2. **Open the Google Cloud project and add yourself as a test user.** Free, instant.
3. **Run Mailwarden on your own inbox.** Screenshot the receipt — "4,312 emails archived, 1.2 GB freed." That screenshot is the ad.
4. **Post that screenshot with the founding offer** to r/gmail, r/productivity, Hacker News (Show HN), and Indie Hackers. Lead with the number and the undo guarantee, not the technology.
5. **Take payment through a Stripe payment link** before the app is even wired to Stripe. Manually add each buyer as an OAuth test user and grant Pro. Manual onboarding is *correct* at n=100: it produces the conversations that fix the product.

### The rest of week one

6. **Submit OAuth verification on day 2–3.** It is free, it is the long pole, and the clock should run while you sell.
7. **Talk to every founding member personally.** Ask one question: *"What did you expect to happen that didn't?"* The answer is your iteration 41–50 backlog.

---

## 3. Unit Economics

The sender-level architecture is what makes the margin work. Cost is driven by **sender count**, not message count, so a 100,000-message inbox costs barely more to classify than a 10,000-message one.

Per full scan of a typical inbox (~300 senders, of which heuristics resolve ~65%, leaving ~105 senders → ~3 model requests at 50/batch):

| Model | Input | Output | Cost / scan |
|---|---|---|---|
| `claude-sonnet-5` ($3/$15 per Mtok) | ~20K | ~6K | **~$0.15** |
| `claude-haiku-4-5` ($1/$5 per Mtok) | ~20K | ~6K | **~$0.05** |
| Either, via the Batch API (50% off) | — | — | **~$0.075 / ~$0.025** |

With prompt caching on the frozen taxonomy prompt, repeat scans drop further.

**Annual COGS per paying user**, assuming a monthly re-scan (12 scans/yr):

- Sonnet 5: **~$1.80/yr** against $19 revenue → **90% gross margin**
- Haiku 4.5: **~$0.60/yr** against $19 revenue → **97% gross margin**

Add hosting (~$0.30/user/yr at scale) and Stripe (~$0.85 on a $19 annual charge) and you are still above **85% gross margin at the entry price**. That is what buys the room to price under Clean Email.

> **Re-check against the ₹ pricing (3 September 2026).** The margin conclusion
> survives the repricing — classification is per *sender* and cached against a
> bucketed fingerprint, so it does not scale with the message counts the new
> tiers meter, and UPI carries no processor fee at all where Stripe took ~3.5%.
> What does *not* survive is the LTV arithmetic in §2 and §4: a ₹299 pass is
> about a sixth of a $49 seat, and a free tier that refills 1,000 messages a
> month means most users never buy a second time. Volume has to make up the
> difference, and the numbers below have not been rebuilt for that.

**Start on Sonnet 5, measure, then decide.** Sender classification from aggregate statistics is not a hard reasoning task, so Haiku 4.5 may well match it — but prove that on your own eval set before switching. A misclassification here costs a support ticket and a refund, which is worth far more than $0.10.

**Free-tier COGS is ~$0**, because the free tier runs on OpenRouter's free models. The 50-request/day ceiling caps ~8 free scans per day globally, which is a real growth constraint to watch — the fix is to buy $10 of OpenRouter credit to lift the ceiling to 1,000/day, not to degrade the free tier.

---

## 4. Growth, in Priority Order

**1 · Comparison SEO.** People search "Clean Email alternative" and "is Unroll.me safe" with clear purchase intent. Build `/vs/clean-email`, `/vs/unroll-me`, `/vs/trimbox`, `/gmail-storage-full`. Competitors run this exact playbook against each other; the pages rank and they convert. Be scrupulously fair in them — the credibility is the conversion mechanism.

**2 · The receipt screenshot.** Every completed cleanup produces a shareable number. Make the receipt beautiful and add a one-tap share. This is the cheapest acquisition channel you have and it costs nothing to build.

**3 · Chrome extension (iteration 51).** "Clean this sender" inside Gmail. The Chrome Web Store is a search surface with genuine intent, and the extension shortens time-to-value from minutes to seconds.

**4 · Product Hunt — but only after iteration 40.** Launching while capped at 100 users converts a launch-day traffic spike into a waitlist and a wasted shot. You get one good PH launch; spend it when the funnel is open.

**5 · Privacy-adjacent newsletters and creators.** The Unroll.me story gives this audience a reason to care. Affiliate at 30% first year.

**Do not buy ads until CAC < ⅓ LTV is proven organically.** At ₹299 the CAC ceiling is about **₹100** — far below what any paid channel delivers, so paid acquisition is off the table against the Backlog Pass alone. It only becomes arguable once Pro retention is measured: a Pro subscriber who stays six months is ₹894, which lifts the ceiling to ~₹300. **Measure Pro retention before spending anything on ads.** Until then this is an organic-only product, which the repricing made more true, not less.

---

## 5. Realistic Trajectory

| Phase | Users | ARR | Milestone |
|---|---|---|---|
| Month 1 | 100 founding | ~~**~$4,900 one-time**~~ **n/a — tier retired, 0 sold** | Product validated; CASA **not** funded, see §2 |
| Month 2–3 | Verification clears | — | Cap removed, funnel opens, SEO pages indexing |
| Month 4–6 | 500–1,500 paid | $10K–30K | Comparison pages ranking, extension shipped |
| Month 7–12 | 3,000–8,000 paid | $60K–160K | Paid acquisition working, Pro mix rising |

Treat everything past month 3 as a planning scenario, not a forecast. The variable that actually decides it is **free→paid conversion rate**, which you will not know until the founding cohort has run. Instrument it from iteration 22 and let it govern spend.

---

## 6. What Kills This Business

Ranked by probability × severity:

1. **Google rejects verification, or CASA drags.** *Mitigation:* apply early, keep scopes minimal, never request `mail.google.com`, run the self-scan before booking a lab. This is the #1 risk and it is largely in your control.
2. **One high-profile "it deleted my email" incident.** *Mitigation:* the architecture already prevents it — we cannot permanently delete, protected categories are locked server-side, and every batch is reversible. Keep those guarantees absolute even when a user asks you to relax them.
3. **Google ships this natively.** Gmail already nudges toward storage cleanup. *Mitigation:* they will not build the trust-and-consent layer, and they have no incentive to help you leave Google One. Real risk; not existential.
4. **Free-tier abuse burns the OpenRouter budget.** *Mitigation:* per-user rate limits, one free scan per account, email verification before scan.
5. **Churn after the one-time job is done.** The deepest structural risk — inbox cleanup is a *job*, not a *habit*. *Mitigation:* this is precisely what Phase 5 (scheduled re-scans, weekly digest, unsubscribe verification) exists to solve. Convert a one-off cleanup into ongoing maintenance, or accept ~60% annual churn and price for it.

---

## 7. What I'd Do Differently If You Have Less Time Than Money

~~If you can spend ~$2,000 up front, skip the founding-100 lifetime tier.~~ **Moot as of 3 September 2026** — the founding tier is retired and no seats were sold, so no long-term LTV was traded away for immediate cash. The trade-off the paragraph warned about was avoided by not taking it.
