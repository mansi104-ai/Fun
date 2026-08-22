# Beta readiness

Status as of 10 August 2026. Live at <https://mailwarden.fly.dev>.

---

## Ready

| | |
|---|---|
| Product | Safe / Review / Protected, sender-first, evidence on every decision |
| Safety | 15 guards behind one chokepoint, re-validated at execute time |
| Reversibility | Undo restores prior labels **and reads Gmail back to verify** |
| Legal | `/privacy.html`, `/terms.html` — every claim matched to enforced code |
| Payments | UPI at 0% fee, Stripe wired and dormant, seat cap enforced twice |
| Marketing | Landing, pricing, OG image, touch icon |
| Ops | Fly deploy, health checks, `pnpm logs`, `pnpm e2e` |
| Tests | 265 offline, 35 end-to-end against production |

---

## The one thing still unproven

**Undo has never run against live Gmail.**

Execute is proven — 2,421 messages on a real mailbox. Undo is not, and it is the
backstop every other protection falls through to. It is also the single loudest
claim on the landing page.

**Test it before the first outside user, not after.** Suggested run, deliberately
small:

1. Sign in, go to **Clean**
2. Pick a low-stakes sender — something automated with a few dozen messages
3. Archive it, and confirm in Gmail that those messages left the inbox but are
   still in All Mail
4. Go to **History**, hit **Undo**
5. Confirm they are back in the inbox, and that the receipt reports
   `restored` equal to the number archived with `mismatched: 0`

If step 5 reports mismatches, stop and send me the numbers — the undo path
reports what it verified, so a mismatch is real information, not noise.

---

## Yours before inviting anyone

1. **Add `mkb.kalra@gmail.com` to Google Test users.** Without it you cannot sign
   in as the operator, and `/admin.html` stays unreachable.
2. **Add the redirect URI** if you have not:
   `https://mailwarden.fly.dev/auth/google/callback`
3. **Turn on an alert channel** so access requests do not sit unread. Either or
   both; with neither, they only reach the server log.

   Email (Resend — free tier 3,000/month, sign up and take a key from
   resend.com/api-keys). The default sender needs no domain, but Resend will
   only deliver from it to the address that owns the Resend account, so sign up
   with the address you want alerted:
   ```bash
   flyctl secrets set --app mailwarden \
     RESEND_API_KEY='re_...' \
     ALERT_EMAIL_TO='mkb.kalra@gmail.com'
   ```

   Phone push, via a chat webhook:
   ```bash
   flyctl secrets set --app mailwarden \
     NOTIFY_WEBHOOK_URL='https://api.telegram.org/bot<TOKEN>/sendMessage?chat_id=<ID>'
   ```

   Verify without waiting for a real visitor — this hits the public endpoint,
   so it also leaves a row in the queue you should delete afterwards.

   PowerShell (note: `curl` there is an alias for `Invoke-WebRequest` and will
   not accept `-H`/`-d` — use `Invoke-RestMethod`, or spell it `curl.exe`):
   ```powershell
   Invoke-RestMethod -Method Post -Uri https://mailwarden.fly.dev/api/access-request `
     -ContentType 'application/json' `
     -Body '{"email":"alert-test@example.com","note":"checking alerts"}'
   ```

   bash:
   ```bash
   curl -X POST https://mailwarden.fly.dev/api/access-request \
     -H 'Content-Type: application/json' \
     -d '{"email":"alert-test@example.com","note":"checking alerts"}'
   ```

   Then clean up the test row:
   ```bash
   flyctl ssh console --app mailwarden -C "sqlite3 /data/mailwarden.db \"DELETE FROM access_requests WHERE email = 'alert-test@example.com'\""
   ```
4. **Submit OAuth verification.** Free, 4–6 weeks, and it is the long pole on
   ever passing 100 users. Privacy policy and terms now exist, which were the
   blocking artefacts.
5. **Run the undo test above.**

---

## Deliberate choices worth knowing

**The free tier is unlimited right now.** `freeBatches` is
`Number.MAX_SAFE_INTEGER`. For a 100-user beta that is correct — you want usage
and feedback, not revenue optimisation. Restore it to `1` when you want the
paywall, and only *after* a payment path is proven end to end. The test suite
prints a reminder every run.

**Trash is offered but discouraged.** Archive is the primary action everywhere;
trash carries an explicit warning that it is the only action with a deadline.

**Protection is over-inclusive on purpose.** Roughly 7% of a real mailbox is
held back. Some of that is genuinely cleanable mail we refuse to touch. That is
the intended trade: missing clutter is recoverable, deleting a receipt is not.

---

## Known gaps, in the order I would close them

| Gap | Why it matters |
|---|---|
| Undo unproven on live Gmail | The backstop for everything |
| Scheduled re-scan | Sold on the pricing page; not built. Also the reason anyone renews |
| SQLite, single instance | Fine for 100 users, blocks anything past that |
| `auto_stop_machines = "stop"` | May kill a long scan mid-flight |
| Domain protection rules | Only per-sender pinning exists; Settings says so |
| Token key in env, not KMS | Decrypts every stored refresh token. Disclosed in the privacy page |
| No error monitoring | Failures are only visible in `pnpm logs` |
| Unsubscribe verification | `unsubscribed_at` is recorded; nothing re-checks at 14 days |

---

## Commands

```bash
pnpm logs          # readable production logs
pnpm logs:tail     # follow live
pnpm e2e           # 35 checks against production
pnpm run deploy    # ship — `run` is required, `deploy` is a built-in pnpm command
pnpm status        # machine health
cd server && pnpm test                                       # 265 offline checks
```
