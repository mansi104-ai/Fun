# Launch Checklist — first revenue

Everything technical is built and deployed. What remains is account setup that
requires your identity, and outreach that requires your voice.

**Time to first possible sale: about 45 minutes of setup, then it depends on
who you talk to.**

---

## The strategic correction

You do **not** need to wait for Google verification to make money.

| | |
|---|---|
| Google OAuth verification | **free**, 4–6 weeks, needed to go past 100 users |
| CASA Tier 2 security assessment | **$540–$1,800/yr**, needed to go past 100 users |
| **Testing mode** | **free, today, 100 real users** |

Those 100 seats are not a waitlist. They are a business you can run tonight.

**At $49 a seat, CASA is covered by 11–37 customers.** Not 100. You are about a
dozen sales from being fully funded, and every one of those sales can happen
before Google finishes anything.

The 100-user cap is also the most honest scarcity claim you will ever get to
make. "Only 100 exist" is true, imposed on you rather than invented, and you can
say exactly why on the page.

---

## Step 0 — how much you actually lose to fees

Measured against the funding target of ~$1,800 (37 founding seats at $49):

| Method | Fee per $49 seat | Total on 37 sales | Setup cost |
|---|---|---|---|
| **UPI (India)** | **₹0** | **₹0** | none |
| Stripe / Razorpay India | ~2% + 18% GST on the fee | ~$50 | GST registration, current account, business docs |
| Stripe (US rates) | $1.72 (3.5%) | ~$64 | US entity — Stripe Atlas is $500 |
| Lemon Squeezy / Paddle | $2.95 (6%) | ~$109 | none; they are merchant of record |

**The spread between card processors is about $50 across your entire funding
target.** That is not worth optimising. Pick whichever you can actually open an
account with fastest.

**UPI is the real saving, and it is 100%.** It has zero merchant discount rate
in India by regulation.

### Why manual UPI works here and normally would not

Manual payment means you confirm each one by hand, which is usually a bad trade.
It is fine here for one specific reason: **every buyer must already be added to
the Google Test users list manually.** You are in the loop for all 100 sales
whether you like it or not, so reconciling a UPI reference adds seconds to a
step that already exists.

This stops making sense the moment you outgrow the 100-seat cap — which is
exactly the point where Stripe's automation starts earning its 3.5%.

### Setting up UPI

```bash
flyctl secrets set --app mailwarden \
  DIRECT_UPI_ID=mkb.kalra-1@okhdfcbank \
  DIRECT_PAYEE_NAME="Mailwarden" \
  DIRECT_PAY_INR=4200 \
  ADMIN_EMAIL=mkb.kalra@gmail.com
```

The pricing page shows the UPI section only once `DIRECT_UPI_ID` is set —
before that it stays hidden, because advertising a payment channel that is not
configured fails *after* the buyer has already decided to pay.

Keep `DIRECT_PAY_INR` roughly in step with $49, or simply price in INR for
Indian buyers and treat them as a separate segment.

### Granting a seat after a UPI payment

Signed in as `ADMIN_EMAIL` — which is **mkb.kalra@gmail.com**, the operator
account, not one of the test users:

> **Prerequisite:** the admin account has to be able to sign in, and signing in
> requires being on Google's **Test users** list like everyone else. Add
> mkb.kalra@gmail.com there first, or the grant endpoint stays unreachable.

```bash
curl -X POST https://mailwarden.fly.dev/api/billing/grant \
  -H 'Content-Type: application/json' \
  -b 'mw_session=YOUR_SESSION_COOKIE' \
  -d '{"email":"buyer@gmail.com","plan":"founding","reference":"UPI ref 402511…"}'
```

The buyer must have signed in at least once first, so there is an account to
attach the plan to. Both sides are written to the audit log with the payment
reference — if a purchase is ever disputed, that log is the only evidence there
is, so always pass a real reference.

**`ADMIN_EMAIL` unset means nobody can grant, not everybody.** Tests enforce it.

---

## Step 1 — Stripe (about 20 minutes)

1. Create an account at <https://dashboard.stripe.com/register>. Business
   details and a bank account are required; only you can do this.
2. **Products → Add product**, three times:

   | Product | Price | Type |
   |---|---|---|
   | Mailwarden Founding 100 | $49 | **One-time** |
   | Mailwarden Starter | $19 | Recurring, yearly |
   | Mailwarden Pro | $39 | Recurring, yearly |

   The founding price **must be one-time**, not recurring. A subscription there
   would contradict "one payment, lifetime" on the pricing page.

3. Copy each price id (`price_…`) and the secret key (`sk_live_…`).

4. **Developers → Webhooks → Add endpoint**
   - URL: `https://mailwarden.fly.dev/api/billing/webhook`
   - Events: `checkout.session.completed`,
     `checkout.session.async_payment_succeeded`,
     `customer.subscription.updated`, `customer.subscription.deleted`
   - Copy the signing secret (`whsec_…`)

5. Set them on Fly:

```bash
flyctl secrets set --app mailwarden \
  STRIPE_SECRET_KEY=sk_live_... \
  STRIPE_WEBHOOK_SECRET=whsec_... \
  STRIPE_PRICE_ID_FOUNDING=price_... \
  STRIPE_PRICE_ID_STARTER=price_... \
  STRIPE_PRICE_ID_PRO=price_...
```

Fly redeploys automatically. `/pricing.html` switches from "Checkout opens
shortly" to live buttons on its own — nothing else to change.

6. **Test with one real card before telling anyone.** Buy a founding seat
   yourself, confirm the webhook fires (`pnpm logs | grep billing`), confirm
   your plan flips to `founding`, then refund yourself in Stripe. A checkout
   that silently fails to grant a plan is the single worst bug this product can
   have, and it is invisible until a customer complains.

---

## Step 2 — restore the paywall

`server/src/lib/entitlements.ts` currently has `freeBatches:
Number.MAX_SAFE_INTEGER` for the free plan. Set it back to `1`.

**Order matters: Stripe first, then this.** Shipping `1` while checkout does not
exist hard-blocks every user after one cleanup with no way out — exactly the
Trimbox failure you are positioned against. The test suite prints a reminder on
every run until you do it.

---

## Step 3 — every buyer needs adding to Google by hand

This is the friction of Testing mode and there is no way around it.

1. <https://console.cloud.google.com> → your project → **OAuth consent screen**
2. **Test users → Add users** → paste their Gmail address
3. They can now sign in

Your queue of people waiting is at `/api/access-request/list` (sign in with a
paid account to read it). Budget a minute per customer. At 100 customers that is
under two hours total, spread over weeks.

**Warn them about the scary screen.** Google shows "Google hasn't verified this
app" and it is the single biggest drop-off point in your funnel. Tell them
before they click, in your own words: *"You'll see a warning that the app isn't
verified — that's Google's review still running, and it's exactly what the
founding seats pay for. Click Advanced → Continue."* Pre-framing it converts far
better than letting them meet it cold.

---

## Step 4 — where the first ten customers come from

You need roughly a dozen sales to fund compliance. That is a small enough number
that it should come from conversation, not campaigns.

**Do first, tonight or tomorrow:**

1. **Your own screenshot.** You already trashed 2,421 messages and freed 184 MB.
   That receipt is your best marketing asset. Screenshot it.
2. **Ten people you actually know** with messy Gmail. Not a broadcast — ten
   individual messages. This is the highest-converting channel you will ever
   have and it is the one most founders skip because it feels like it does not
   count.
3. **r/gmail and r/productivity.** Lead with the number and the guarantee, not
   the product. "I cleaned 2,421 emails out of my inbox and freed 184 MB — the
   tool I built can never permanently delete anything, and everything is
   reversible for 30 days."
4. **Show HN / Indie Hackers.** Same framing. Mention the 100-seat cap honestly:
   it is a real constraint, and saying so builds more trust than hiding it.

**What actually sells this**, in priority order:

- It cannot permanently delete. Google does not grant it that power.
- Sender-level: ~200 decisions instead of 40,000.
- Everything reversible for 30 days.
- Starred mail, attachments, replied threads, receipts, and login codes are
  protected automatically.

**Do not buy ads.** At these prices the CAC ceiling is a few dollars, which no
paid channel reliably delivers for this category. See docs/02 §6.

---

## Step 5 — instrumentation, before you post anything

The outreach in Step 4 is worth doing once. Posting to Show HN without knowing
which link brought people is spending that one chance and learning nothing.

**Already live, nothing to set up:**

- **`/admin.html` → Traffic.** Visitors, pageviews, top pages, referring sites,
  `utm_source`, and the full funnel from "landed" to "paid". First-party and
  cookieless: no vendor, no cookie banner, no CSP exception, and it stays
  consistent with what `/privacy.html` promises. Steps marked *verified* are
  counted from the server's own audit log as the action happens, so they cannot
  be inflated by anyone posting at the public event endpoint.
- **Tag your own links.** Append `?utm_source=hn`, `?utm_source=reddit`,
  `?utm_source=twitter` to what you post. Untagged links still show under
  referring sites, but only a tag survives someone copying the URL onward.

**Two things that need your Google account, ~10 minutes:**

1. **Search Console** — add the property, verify it, submit
   `https://mailwarden.fly.dev/sitemap.xml`. A sitemap nobody submits does
   nothing on its own.
2. **Rich Results Test** — paste the landing page and the pricing page. Both
   carry `schema.org` markup with real prices from `priceCatalogue()`. There is
   deliberately no `aggregateRating`: we have no reviews, and inventing them is
   both a lie and a manual-action risk.

**What the analytics deliberately cannot tell you:** a visitor is per-device and
resets at midnight UTC, because the salt that identifies one rotates daily and
is never stored. This measures a launch, not a cohort. If you later need
retention curves, that is a different tool and a different privacy disclosure.

---

## What I could not do for you

Stated plainly so nothing here is a surprise:

- **Create your Stripe account.** It needs your identity and bank details.
- **Run overnight.** I work within a session; there is no background process.
- **Make sales.** Code cannot decide to buy itself. The outreach in Step 4 is
  the part that produces money, and it is yours.

What *is* done: the entire payment path is built, deployed, and tested — hosted
checkout, signature-verified webhooks, replay protection, seat accounting,
oversell handling, and a pricing page that reads live availability. It is one
`flyctl secrets set` away from taking money.

---

## Still open on the product

| Gap | Why it matters |
|---|---|
| **Undo never run against live Gmail** | It is the backstop your entire safety pitch rests on. Test it before customers do. |
| Custom domain | Everything points at `mailwarden.fly.dev`. A `.fly.dev` subdomain ranks worse and reads as pre-launch. Moving means updating `APP_URL`, the Google OAuth redirect URI, and the four canonical/`og:url`/sitemap values together — smoke check 19 fails if they drift apart. |
| SQLite, single instance | Fine for 100 users. Blocks scale past that. |
| `auto_stop_machines = "stop"` | May kill a long scan mid-flight. |
