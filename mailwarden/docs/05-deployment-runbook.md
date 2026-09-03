# Deployment & Launch Runbook

## 0. Local setup (10 minutes)

> **Use `pnpm`, not `npm`, on this machine.** `npm install` currently fails
> here with `Class extends value undefined is not a constructor or null` — for
> *any* package, in *any* directory, including a clean temp folder. It is an
> npm installation problem, not a project problem. Two Node managers are
> installed side by side (`C:\nvm4w` and `%APPDATA%\nvm\v18.18.0`) and npm's
> config chain still references the v18 tree while running Node v22.
> To repair npm itself: uninstall one of the two managers, then reinstall Node
> 22 LTS. Until then `pnpm` works fine and is used below.

```bash
cd mailwarden/server
pnpm install                       # builds the better-sqlite3 native binding
# pnpm is pinned to 8.9.2 via package.json -> packageManager. Corepack honours
# it; upgrading requires re-validating the container build (see §2).
cp ../.env.example ../.env         # then fill in the values below

node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"  # TOKEN_ENCRYPTION_KEY
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"  # SESSION_SECRET

pnpm exec tsx src/smoke.ts         # offline checks — no network, no keys needed
pnpm dev                           # http://localhost:8080
```

`src/smoke.ts` verifies the safety-critical logic (protected senders, plan/undo
bookkeeping, entitlement gate) without touching Gmail. Run it after any change
to `classify/` or `gmail/executor.ts`.

## 1. Google Cloud project

1. <https://console.cloud.google.com> → new project **Mailwarden**.
2. **APIs & Services → Library** → enable **Gmail API**.
3. **OAuth consent screen** → External → fill in app name, support email,
   developer email → **Publishing status: Testing**.
4. **Scopes** → add exactly two:
   - `https://www.googleapis.com/auth/gmail.modify`
   - `https://www.googleapis.com/auth/userinfo.email`

   Do **not** add `https://mail.google.com/`. It grants permanent deletion,
   breaks the product's core promise, and pushes the assessment toward CASA
   Tier 3 (~$4,500/yr instead of ~$540–$1,800).
5. **Test users** → add your own address. This list is your 100-user cap; every
   founding member gets added here manually.
6. **Credentials → Create OAuth client ID → Web application.**
   Authorized redirect URI: `https://YOUR_DOMAIN/auth/google/callback`
   (locally: `http://localhost:8080/auth/google/callback`). It must match
   `APP_URL` exactly — a trailing slash difference will fail.

## 1b. See it working right now (no Google account needed)

Demo mode seeds a synthetic 13,000-email inbox — including the traps (an
airline filed under Promotions, a bank, an OTP sender, a colleague you replied
to) — and signs you in. Useful for evaluating the UI before approval, and for
recording the verification demo video.

```bash
cd server
ENABLE_DEMO=1 GOOGLE_CLIENT_ID=x GOOGLE_CLIENT_SECRET=x pnpm dev
# open http://localhost:8080/auth/demo
```

The demo account holds no Gmail token, so the final execute step returns
`reconnect_required` rather than pretending to move mail. Everything up to that
point — scan, tiles, guard exclusions, the confirm screen — is real.

Two independent gates keep this out of production: `NODE_ENV !== "production"`
**and** `ENABLE_DEMO=1`. A single misconfigured variable cannot expose it.

## 2. Production deploy

Two blueprints are included. Both build the same `Dockerfile`.

### The container image, and three traps it already hit

`docker build` succeeding proves nothing here — every one of the following
produced a **green build that died at boot**. All three are fixed; the notes
exist so a future change does not quietly reintroduce them. Always run the image
before shipping it:

```bash
docker build -t mailwarden:local .
docker run -d --name mw-test -p 8899:8080 \
  -e NODE_ENV=production -e APP_URL=http://localhost:8899 \
  -e GOOGLE_CLIENT_ID=x -e GOOGLE_CLIENT_SECRET=x \
  -e TOKEN_ENCRYPTION_KEY=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))") \
  -e SESSION_SECRET=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))") \
  mailwarden:local
docker inspect --format='{{.State.Health.Status}}' mw-test   # must be: healthy
```

1. **Both `node_modules` trees must be copied.** pnpm keeps every real package
   once under `/app/node_modules/.pnpm` and fills `/app/server/node_modules`
   with *relative* symlinks into it. Copying only the server tree carries the
   links and leaves the targets behind → `ERR_MODULE_NOT_FOUND: fastify` at
   boot. Note that `ls /app/node_modules | wc -l` prints `0` because `.pnpm` is
   a dotfile — the directory is not empty.

2. **The pnpm version must be pinned.** Local runs 8.9.2; corepack in the image
   was silently fetching 11.20.0, so the container was never building what had
   been validated. pnpm 10+ also refuses to run dependency build scripts unless
   allowlisted. `packageManager: "pnpm@8.9.2"` in the root `package.json` pins
   it; `onlyBuiltDependencies` in `pnpm-workspace.yaml` covers a future upgrade.
   Settings moved out of `.npmrc` and the `pnpm` field of `package.json` in
   pnpm 11 — both are now ignored, with a warning.

3. **`--ignore-scripts` plus `pnpm rebuild better-sqlite3` is not equivalent to
   a plain install.** The rebuild exited 0 while compiling nothing, so the image
   shipped without `better_sqlite3.node` and could not open its database. The
   Dockerfile now asserts the binding exists at build time rather than trusting
   the exit code.

Verified on this machine: image builds (489 MB), boots, reports `healthy`,
serves `/` and `/app.html`, returns **404** for `/auth/demo` under
`NODE_ENV=production`, returns **401** for every `/api/*` read and mutation
while unauthenticated, and sets HSTS, CSP, `X-Frame-Options: DENY`, and
`nosniff`.

### Fly.io

```bash
fly launch --no-deploy --copy-config
fly volumes create mailwarden_data --size 1 --region <region>
fly secrets set \
  GOOGLE_CLIENT_ID=... GOOGLE_CLIENT_SECRET=... \
  TOKEN_ENCRYPTION_KEY=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))") \
  SESSION_SECRET=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))") \
  APP_URL=https://<app>.fly.dev
fly deploy
```

### Render

Push to GitHub → Render → New → Blueprint → fill the `sync: false` secrets.

### After either

Set the Google OAuth redirect URI to exactly
`https://<your-domain>/auth/google/callback`. A trailing-slash mismatch fails.

**`min_machines_running = 1` and a single instance are deliberate** — SQLite
cannot be shared across machines. Do not scale horizontally before migrating to
Postgres.

Any Node host works. Fly.io / Railway / Render are all fine at this scale.

**Before going live, replace SQLite with Postgres.** `server/src/db.ts` is
written in plain SQL against a single connection; the migration is mechanical
(swap `better-sqlite3` for `pg`, make the query helpers async). SQLite is
correct for development and for the first ~100 users on one machine; it is not
correct once you run more than one instance.

```bash
pnpm build && pnpm start
```

Production checklist:

- [ ] `NODE_ENV=production`, `APP_URL` set to the real HTTPS origin
- [ ] `TOKEN_ENCRYPTION_KEY` from a KMS or secret manager, **never** a `.env`
      file — it decrypts every stored Gmail refresh token
- [ ] `SESSION_SECRET` set and distinct from the token key
- [ ] TLS terminated upstream; `trustProxy` is already enabled in production
- [ ] Automated backups of the database
- [ ] Uptime + error monitoring (Sentry or equivalent)

Security headers (CSP, HSTS, `X-Frame-Options`, `nosniff`) are already applied
in `src/index.ts`.

## 3. OAuth verification submission

**Do this in week one — it is free and it is the long pole on public launch.**
Everything else can proceed while the 4–6 week clock runs.

Prepare, then submit from the OAuth consent screen:

- [ ] Domain verified in Google Search Console
- [ ] Homepage on that domain explaining what the app does
- [ ] Privacy policy on that domain, linked from the consent screen, listing
      each scope and its specific use
- [ ] Terms of service
- [ ] YouTube demo video showing: the consent screen, the granted scopes, and
      each scope actually being used in-product
- [ ] Written per-scope justification. Say plainly why you need `gmail.modify`
      (archive/label/trash is the core action) **and** why you deliberately do
      not request full access (you never permanently delete)
- [ ] In-app account deletion that revokes the token and purges data —
      implemented at `POST /auth/disconnect`

## 4. CASA Tier 2

Only after verification is moving.

1. Self-scan first (OWASP ASVS via a free DAST/SAST pass) and fix findings.
   A failed lab run costs the full fee again.
2. Book an approved lab. Budget **$540–$1,800**, 1–3 weeks.
3. Recertify annually.

## 5. Launch day

1. Set the OAuth publishing status to **In production**. Verification has
   cleared, so the 100-user cap is gone and nothing in the code gates sign-up.
2. Run Mailwarden on your own inbox; screenshot the receipt.
3. Publish the landing page with the Backlog Pass offer (₹299, 50,000 messages).
4. Post to r/gmail, r/productivity, Show HN, Indie Hackers. Lead with the
   number on the receipt and the undo guarantee.
5. Watch the UPI queue in `/admin.html`. Payments are confirmed by hand, so a
   buyer who pays while you are asleep waits — the free tier keeps working
   meanwhile, which is what stops that being a lost sale.

## 6. Known gaps before public launch

Honest list of what is scaffolded but not finished in this repo:

| Gap | Where | Roadmap item |
|---|---|---|
| Stripe checkout + webhooks not wired | `lib/entitlements.ts` has the gate; no Stripe routes yet | 24 |
| Unsubscribe engine not implemented | — | 44–45 |
| Scheduled re-scan not implemented | — | 41 |
| SQLite → Postgres | `db.ts` | before public launch |
| Multi-batch LLM concurrency proven by construction, not yet on a >50-ambiguous-sender inbox | `classify/llm.ts` | — |
| Token encryption key is env-based, not KMS | `lib/crypto.ts` | 34 |
| No automated test suite beyond `smoke.ts` | — | 35 |

## 7. Verified on this machine

- `pnpm install` — clean
- `tsc --noEmit` — **passes, zero errors**
- `pnpm build` → `node dist/index.js` — **compiled production server boots**
- `better-sqlite3` native binding — builds and loads
- `pnpm exec tsx src/smoke.ts` — **47/47 checks pass**
  ([06-safety-model.md §8](06-safety-model.md))
- Demo inbox: 12,974 messages / 1.82 GB across 16 senders. All 6 trap senders
  (airline, bank, OTP, receipts, rail booking, replied-to colleague) classified
  **locked**; the other 10 open. Recipe tiles computed with guard-accurate counts.
- Full flow exercised: recipe → plan → `SCALE_ANOMALY` confirm gate →
  `TOO_RECENT` exclusions → execute. With an unusable token the API returns
  **409 `reconnect_required`**, the batch is marked `failed`, **0 messages
  applied**, and the account is flagged `needs_reconnect`.
- Production config: `/auth/demo` returns **404**; HSTS, CSP, and
  `X-Frame-Options` present; unauthenticated `/api/senders` returns 401

### Validated against a real mailbox (2026-08-09)

First live run: a 6,010-message Google Workspace account.

- OAuth round-trip, token storage, and refresh — **working**
- Sync: 5,998 messages in 189s (~32 msg/s), 261 senders, 1.1 GB
- **The sender-level thesis holds on real data: 6,010 messages → 261 senders**,
  a 23× reduction in decisions
- LLM tier resolved 45 ambiguous senders in **one request** — the batching
  economics from docs/02 confirmed outside synthetic data

It also surfaced four bugs that no synthetic fixture would have caught. All four
are fixed and covered by regression tests in `smoke.ts` §12:

| Bug | Impact measured | Fix |
|---|---|---|
| One stray reply locked an entire bulk sender as `personal` | 15 senders / **1,964 messages — 33% of the mailbox** — permanently untouchable | Reply detection is now a **ratio** (≥25%), not a boolean; `noreply@`-style addresses can never be correspondents |
| The user's own address became a sender row | 116 of their own sent messages offered for archiving | Self address excluded during aggregation |
| `no-reply@` treated as a *security* signal | Google Classroom (647 msgs) locked as `security` | Removed the generic pattern; specific tokens (`accounts.google`, `otp`, `2fa`, …) retained |
| Retired OpenRouter free-model slug 404'd **silently** | Whole LLM tier returned zero verdicts while reporting success | Model updated; failures now log loudly |

Net effect: messages wrongly locked fell from **~56% to 6%**, with every
critical sender (Google Accounts, SBI, Razorpay, all 11 human correspondents)
still protected.

**Still unverified:** `batchModify` execution and undo against real Gmail. That
is now the only untested path.

### Agent performance work (2026-08-09)

The agent re-did all of its work on every visit. Measured on the same
6,010-message account, before and after:

| Stage | Before | After (2nd run) | Why |
|---|---|---|---|
| Sync | 218.6 s | **0.7 s** | Incremental `users.history.list` from a stored `historyId`, falling back to a full scan when the cursor ages out (Gmail keeps ~7 days) |
| Classify | 80.4 s | **0.1 s** | Verdicts cached against a *bucketed* fingerprint of the signals that produced them |
| LLM requests | 1 | **0** | Unchanged senders never reach a model |
| **Total** | **299 s** | **0.8 s** | ~370× |

The fingerprint is bucketed rather than exact on purpose: a raw message count
changes on nearly every sync, so hashing it would re-classify — and re-bill —
the whole mailbox every pass. Volume is bucketed by `log2`, rates to one
decimal. Verdict-changing signals (unsubscribe header, reply status, user
decision, Gmail category labels) are exact.

Four further changes, all in the same direction:

- **Concurrency.** LLM batches ran serially. One 46-sender batch takes ~70 s on
  a free model, so a 300-sender mailbox was ~7 minutes of strictly independent
  work done one at a time. Now 4-way bounded (both providers). Bounded, not
  unbounded — a burst earns a 429 that costs more than the serialisation saved.
- **Value-ordered escalation.** Senders are sorted by message count before
  batching, so when the free tier's 50-request budget truncates a run, the
  senders that miss out are always the smallest.
- **The agent learns.** Executing a batch records `user_decision` per sender;
  undoing one reverses it. A decided sender skips the model entirely on the next
  pass — the cheapest accuracy available, and it never misreads intent.
  Deliberately ranked *below* the protective rules: a past "archive" must not
  unlock a sender that has since started carrying boarding passes.
- **Honest degradation.** An unavailable model used to mark senders `unknown`
  and lock them permanently. `fallbackClassify` now makes a stated low-confidence
  call (0.55 — above the guard floor, below the auto-suggest bar) when the bulk
  evidence is strong and entirely local, and does not cache it, so the next scan
  retries properly.

Measured category distribution after the work (5,882 messages, 260 senders):

| Category | Senders | Messages | Locked |
|---|---|---|---|
| promotional | 76 | 2,639 | 0 |
| notification | 51 | 2,377 | 0 |
| newsletter | 5 | 399 | 0 |
| unknown | 82 | 99 | 99 |
| finance | 5 | 93 | 93 |
| personal | 22 | 91 | 91 |
| security | 7 | 84 | 84 |
| social | 6 | 66 | 0 |
| transactional | 6 | 34 | 34 |

**401 of 5,882 messages locked (6.8%)** — and the 82 `unknown` senders account
for only 99 of them, because they are senders with one or two messages each.
Every critical sender remains protected.
