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

## Sources
- [Restricted scope verification — Google](https://developers.google.com/identity/protocols/oauth2/production-readiness/restricted-scope-verification)
- [Gmail OAuth scopes 3-tier system — Bright Softwares](https://bright-softwares.com/blog/en/google-workspace/gmail-oauth-scopes-decoded-the-3-tier-system-that-determines-your-launch-path)
- [Google CASA assessment costs — Deepstrike](https://deepstrike.io/blog/google-casa-security-assessment-2025)
- [Gmail API scopes guide — Unipile](https://www.unipile.com/gmail-api-scopes-guide/)
- [Passing CASA Tier 2 — Orbis](https://meetorbis.com/blog/how-we-passed-google-casa-tier-2-with-claude)
