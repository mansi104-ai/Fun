# Gmail OAuth, CASA, and the Actual Launch Path

**Read this before writing product code or promising a launch date.** This document contains the two facts that determine whether this business is viable and when it can take money.

---

## 1. The Hard Constraint

Every Gmail scope that is useful for this product is classified **RESTRICTED** by Google — including `gmail.metadata`, which only exposes headers and labels. There is no "light" Gmail scope that reads a whole inbox.

Restricted scopes require **both**:
1. **Google OAuth verification** — free, but takes **4–6 weeks**, and involves a demo video, a published privacy policy, a verified domain, and a homepage explaining the scope use.
2. **CASA security assessment** by a Google-approved third-party lab — **paid, annual**.

| | Tier 2 | Tier 3 |
|---|---|---|
| Trigger | Moderate user count, restricted scopes | Highly sensitive data access, or Google Workspace Marketplace badge |
| Cost | **$540 – $1,800 / yr** | **~$4,500 / yr** |
| Duration | 1–3 weeks after testing starts | 2–4 weeks |
| Content | Automated DAST/SAST + lab verification, subset of OWASP ASVS | Full third-party pen test, all ASVS categories |

There is **no free CASA path**. Google requires an authorised lab to issue the Letter of Validation. You can self-scan first to avoid paying twice for a failed run.

> **This means: you cannot serve unlimited public users on day one. Anyone who tells you otherwise is wrong.**

---

## 2. The Unlock — Testing Mode

An app with restricted scopes can publish in **Testing status with up to 100 users, immediately, with no CASA and no verification.**

Those 100 users are real users with real inboxes who can pay real money.

This is the entire go-to-market strategy for months 1–2:

```
Day 0-30    Testing mode, 100 hand-picked users, charge them.
            Goal: proof the cleanup works + 100 testimonials + revenue.
Day ~14     Start OAuth verification in parallel (it is free; the 4-6 week
            clock should be running while you sell to the first 100).
Day ~30     Self-scan against ASVS, fix findings, then book CASA Tier 2.
Day 60-75   Verification + CASA clear. Remove the 100-user cap. Open funnel.
```

The 100-user cap is a *feature* for launch messaging: **"Founding 100. Closed beta."** Scarcity is real, not manufactured — which means you can say it honestly.

**Caveat to verify yourself:** Testing-mode refresh tokens have historically expired every 7 days for external-user testing apps. Confirm current behaviour in Google Cloud Console before promising uninterrupted service, and design the app to re-prompt gracefully. Budget for this being a real friction point with the first 100 users — tell them up front that beta requires a periodic reconnect.

---

## 3. Scope Decisions (Locked)

| Scope | Use | Status |
|---|---|---|
| `gmail.modify` | Archive, trash, label. **Cannot permanently delete.** | ✅ Use |
| `gmail.readonly` | — | ❌ Superset of what we need, same tier, worse optics |
| `https://mail.google.com/` | Full IMAP incl. permanent delete | ❌ **Never.** Pushes toward Tier 3, ~$4,500/yr |
| `userinfo.email` | Account identity | ✅ Use (non-sensitive) |

**Architectural consequence:** the product's verb is *archive / trash / label*, never *delete*. Trash auto-purges via Gmail's own 30-day policy — which is a better user promise anyway ("30-day undo, enforced by Google, not by us").

Marketing must never use the word "permanently delete." It is both false and a verification risk.

---

## 4. Data Minimisation — Required by CASA, Also Our Moat

The assessment gets dramatically easier the less data you retain. Rules, enforced in code:

1. **Never store email bodies.** Not in a DB, not in a log, not in a cache.
2. **Store per-message: message ID, sender, date, size, Gmail label IDs, and a hash of the subject.** Nothing else.
3. **Send to the LLM: aggregated sender-level facts only** — sender domain, display name, message count, date range, whether `List-Unsubscribe` is present, Gmail's own category labels, open-rate proxy (read/unread ratio). **Never a subject line, never a body, never a recipient address.**
4. **Encrypt refresh tokens at rest** with a KMS-managed key, never the app DB's default.
5. **Purge on disconnect** within 24h, and say so on the disconnect button.

Point 3 is worth emphasising: because we classify at the sender level, **we never need to send message content to a third-party model at all.** That is not a compromise we made for compliance — it falls out of the sender-level architecture for free, and it is a marketing claim competitors using full-body scanning cannot match.

---

## 5. Verification Application Checklist

Prepare before applying — incomplete applications are the main cause of multi-month delays:

- [ ] Verified domain ownership in Google Search Console
- [ ] Homepage on that domain explaining what the app does
- [ ] Privacy policy on that domain, linked from the consent screen, explicitly listing each scope and its use
- [ ] Terms of service
- [ ] YouTube demo video: shows the OAuth consent screen, the granted scopes, and each scope actually being *used* in-product
- [ ] Written justification per scope, in the form "we need `gmail.modify` because the user's core action is archiving bulk mail; we do not request full access because we never permanently delete"
- [ ] The word "Google" used per brand guidelines; no implication of Google endorsement
- [ ] In-app account deletion that revokes the token and purges data

## 6. First submission — what Google actually rejected

Submitted and rejected with three findings. The checklist above predicted all
three; two are now fixed in code and enforced by smoke §20.

| Google's finding | Status |
|---|---|
| *"The website of your homepage URL `https://mailwarden.fly.dev` is not registered to you."* | **Open — needs a purchase.** A `*.fly.dev` subdomain is registered to Fly.io. Buy the domain, then `node scripts/set-domain.mjs https://mailwarden.ai` and the five manual steps in docs/09 §7. |
| *"Your homepage does not explain the purpose of your app."* | **Fixed.** The homepage now carries *What Mailwarden does*, *How it works*, a per-scope justification quoting the full scope strings, *What Mailwarden will not touch*, and the Limited Use citation. |
| *"The app name configured for your OAuth consent screen does not match the app name on your homepage."* | **Fixed.** The page led with the tagline and carried the name only in the lowercase wordmark and in body copy. `Mailwarden` is now the first text in the `<h1>`, verbatim and identical to the consent screen and the `<title>`. |

Smoke §20 now fails the build if the homepage stops naming the app in its
`<h1>`, stops explaining what the app does, drops the privacy-policy link or the
Limited Use citation, or — the valuable one — if a scope is added to
`config.google.scopes` without being disclosed on the homepage that justifies
it. A consent screen and a homepage that disagree is exactly what costs another
six-week cycle.

### Second submission — rejected again, for a reason worth remembering

Two findings came back, and the first one was **not a content problem**.

*"Your homepage does not explain the purpose of your app."* — The homepage that
explains the purpose had been written, reviewed, committed and pushed. It had
never been **deployed**. Fly was still serving the previous build, so the
reviewer read a 3.7 KB page with no `<h2>` on it at all, and a full cycle was
spent proving that a `git push` is not a release.

`node scripts/e2e.mjs https://mailwarden.fly.dev` now asserts, against the live
host, everything smoke §20 asserts against the files: the app name in the
`<h1>`, the three purpose headings, both scope strings, the privacy link, the
Limited Use citation, and that `/analytics.js`, `/robots.txt` and `/sitemap.xml`
are actually served. Run it before every resubmission. It reproduced both of
Google's findings exactly when pointed at the undeployed site.

*"The app name 'mailwarden' … does not match the app name on your homepage."* —
Note the casing. The first rejection quoted `Mailwarden`; this one quoted
`mailwarden`. The consent screen had been changed, the site had been changed the
other way, and the two crossed over. **The canonical name is `Mailwarden`** —
capitalised — and it is written down once, in `APP_NAME` in smoke §20. The
lowercase wordmark is the logotype and stays as it is (docs/09 §3); Google is
looking for the name, which the `<h1>` and all four `<title>`s supply.

Change either the consent screen or `APP_NAME` and you must change both, in the
same sitting.

## Pre-resubmission gate

Do not resubmit until all four are true:

1. `cd server && pnpm test` — 257 checks, including §19 (SEO agreement) and §20
   (what a reviewer must find).
2. `pnpm deploy` has actually run and finished.
3. `node scripts/e2e.mjs https://<live host>` passes §3 in full.
4. The consent screen's app name and homepage URL match what is live.

## Sources
- [Restricted scope verification — Google](https://developers.google.com/identity/protocols/oauth2/production-readiness/restricted-scope-verification)
- [Gmail OAuth scopes 3-tier system — Bright Softwares](https://bright-softwares.com/blog/en/google-workspace/gmail-oauth-scopes-decoded-the-3-tier-system-that-determines-your-launch-path)
- [Google CASA assessment costs — Deepstrike](https://deepstrike.io/blog/google-casa-security-assessment-2025)
- [Gmail API scopes guide — Unipile](https://www.unipile.com/gmail-api-scopes-guide/)
- [Passing CASA Tier 2 — Orbis](https://meetorbis.com/blog/how-we-passed-google-casa-tier-2-with-claude)
