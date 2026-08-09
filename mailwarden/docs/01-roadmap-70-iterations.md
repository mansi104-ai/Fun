# Mailwarden — 70-Iteration Roadmap

One iteration ≈ one focused work session. Ordered so that **revenue is possible at iteration 22** and every phase ends on something shippable.

Legend: 🔴 blocking · 💰 revenue-affecting · ⚖️ compliance-affecting · 🧪 needs real-inbox testing

---

## Progress — 32 of 70 done

**Done (code + tests):** 1, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17,
18, 19, 20, 21, 22, 23, 28, 32, 33, 36, 42, 46, 47, 48, 49

Iteration 6 now includes **incremental `historyId` sync** (a repeat scan is
0.7 s instead of 218 s) and iteration 42 (**auto-rules learned from past
decisions**) landed alongside it — executing a batch teaches the classifier,
undoing one un-teaches it. Both measured on the real mailbox; see
[05 §7](05-deployment-runbook.md).

Category browsing is in: every taxonomy category is listed with guard-accurate
counts, protected ones included at zero cleanable, with per-sender narrowing
that can shrink a batch but never widen it.

**Blocked on you:** 2 (Google Cloud project — needs your Google account)

**Deferred by request:** 24, 25, 26, 27, 29 (Stripe and billing UI)

**Verified:** typecheck clean; **53/53** offline checks in `server/src/smoke.ts`;
production build runs; recipe → plan → guard → execute exercised on the demo
inbox. See [06-safety-model.md](06-safety-model.md).

**Iteration 6 is now validated against a real 6,010-message mailbox** — OAuth,
sync, aggregation, and classification all working. That run exposed four bugs
worth ~33% of the mailbox being wrongly locked; all fixed, all now covered by
regression tests. Details in [05 §7](05-deployment-runbook.md).

**Still needs a real inbox (🧪):** 19 only — `batchModify` execute and undo have
never touched live Gmail. Everything upstream of them is now proven.

### Remaining, in the order I'd do them

1. **2** — Google Cloud project (10 min, yours to do)
2. **38** — submit OAuth verification. Free, 4–6 weeks, the long pole
3. **41, 43** — scheduled re-scan + weekly digest. This is what converts a
   one-off job into a subscription; churn is the deepest risk in docs/02 §6
4. **44, 45** — unsubscribe engine + verification. Nobody verifies that an
   unsubscribe was honoured; that alone is a marketing hook
5. **31, 34, 35, 37, 39, 40** — the compliance block, gated on money for CASA
6. **24–27** — Stripe, once you want to charge
7. **51–53** — Chrome extension and comparison SEO, the two channels that
   actually scale

---

## Phase 0 — Foundations (1–8)

1. 🔴 Repo scaffold, TypeScript strict, workspace layout, lint/format, `.env.example`
2. 🔴 Google Cloud project, OAuth client, consent screen in **Testing** mode, `gmail.modify` + `userinfo.email` ⚖️
3. 🔴 Postgres schema + migrations: `users`, `accounts`, `senders`, `messages_meta`, `batches`, `batch_items`, `audit_log`
4. 🔴 OAuth flow end-to-end: consent → callback → encrypted refresh-token storage → session cookie ⚖️
5. Token refresh service with automatic retry and a clean "reconnect required" state
6. 🔴 Gmail sync worker: paged `messages.list` + `messages.get(format=metadata)`, checkpointed, resumable 🧪
7. Sync progress streaming (SSE) so the UI shows live counts during first scan
8. Sender aggregation: roll messages into per-sender rows (count, bytes, date span, unread ratio, unsubscribe presence)

## Phase 1 — Classification (9–16)

9. 🔴 Heuristic classifier v1: `List-Unsubscribe`, `Precedence: bulk`, Gmail `CATEGORY_*` labels, ARC/DKIM domain → categories
10. OTP/transactional detector — **hard protect rule**, never actionable (subject-hash patterns + sender reputation) 🧪
11. Receipt/travel/tax detector — the "promotions contains my boarding pass" failure mode 🔴
12. Protected-sender list: anyone the user has *replied to*, plus contacts, plus manual pins
13. 🔴 LLM classifier: batched **sender-level** prompt (50 senders/request), strict JSON schema, validated + repaired
14. OpenRouter free-tier adapter with budget accounting (50 req/day) and graceful degradation to heuristics-only
15. Paid-tier adapter → Claude Haiku 4.5 / Sonnet 5 routing, higher batch fidelity, per-user quota
16. Confidence scoring + "needs review" bucket; never auto-suggest below threshold

## Phase 2 — The Consent Loop (17–22)

17. 🔴 Batch builder: turn classifications into reviewable proposals grouped by sender
18. 🔴 Preview UI: sender cards, counts, sample subjects, one-tap keep/archive/trash
19. 🔴 Execute engine: Gmail `batchModify`, chunked, rate-limit aware, idempotent, resumable on failure 🧪
20. 🔴 Undo: full reversal from `batch_items` within 30 days ⚖️
21. Receipt screen — "4,312 emails archived · 1.2 GB freed · undo anytime"
22. 💰 **MILESTONE: free tier is end-to-end usable.** First real cleanup on a real inbox.

## Phase 3 — Monetisation (23–30)

23. 💰 🔴 Entitlement system: plan, quota, feature gates, server-enforced (never trust client)
24. 💰 🔴 Stripe: checkout, webhooks, subscription lifecycle, dunning
25. 💰 Paywall placement — **after** first cleanup completes, never mid-job
26. 💰 Pricing page + annual/monthly toggle, founding-member code
27. Referral: both sides get a month; unique code per user
28. 💰 Model routing switches on plan (free → OpenRouter free models, paid → Claude)
29. Usage dashboard so paid users see what they're getting
30. 💰 **MILESTONE: can take money.** Charge the first 100 testing-mode users.

## Phase 4 — Trust & Compliance (31–40)

31. ⚖️ Privacy policy, ToS, subprocessor list, DPA template
32. ⚖️ In-app disconnect: token revoke + 24h purge job, with proof shown to user
33. ⚖️ Audit log — every action, immutable, user-viewable and exportable
34. ⚖️ Encrypt refresh tokens with KMS; rotate app secrets
35. ⚖️ Self-run DAST/SAST against OWASP ASVS; fix before paying a lab
36. ⚖️ Security headers, CSP, rate limiting, CSRF, session hardening
37. ⚖️ Record OAuth demo video showing each scope in use
38. ⚖️ **Submit Google OAuth verification** (4–6 wk clock starts — do this early, in parallel with Phase 3)
39. ⚖️ Book + pass CASA Tier 2
40. ⚖️ **MILESTONE: 100-user cap removed.** Public launch unlocked.

## Phase 5 — Retention (41–50)

41. Scheduled re-scan (daily/weekly) — the thing that justifies a *subscription* rather than a one-off
42. Auto-rules: "always archive this sender" learned from past decisions
43. Weekly digest email: what arrived, what we'd archive, one-click approve
44. Unsubscribe engine: RFC 8058 one-click `List-Unsubscribe-Post` first, mailto second, HTTP scrape last 🧪
45. Unsubscribe verification — re-check in 14 days, flag senders that ignored it (nobody does this; it's a killer feature)
46. Storage analytics: largest senders by bytes, attachment hogs, "free 4 GB" framing
47. Onboarding rebuild driven by funnel data
48. Bulk-action safety rails: velocity caps, anomaly detection, confirm-on-large-batch
49. Mobile-responsive dashboard
50. Churn instrumentation + cancel-flow save offer

## Phase 6 — Growth (51–60)

51. 💰 Chrome extension: in-Gmail sidebar, "clean this sender" from any thread
52. Public "Inbox Score" — shareable, no signup, top-of-funnel magnet
53. SEO cluster: `/vs/clean-email`, `/vs/unroll-me`, `/vs/trimbox`, `/gmail-storage-full`
54. Free tools for links: Gmail storage calculator, unsubscribe-link finder
55. Product Hunt launch (only after iteration 40)
56. Lifecycle email sequences: onboarding, activation, win-back
57. Affiliate program for productivity newsletters
58. 💰 Multi-account support — the natural upsell to the higher tier
59. Outlook/Microsoft 365 connector (different compliance regime — scope it separately)
60. 💰 **MILESTONE: repeatable paid acquisition with CAC < 1/3 LTV**

## Phase 7 — Durable Moat (61–70)

61. Local-first classification option — heuristics in-browser, "your metadata never leaves your device" premium tier
62. Cross-user sender reputation graph (aggregated, anonymised, k-anonymity floor) — accuracy compounds with scale
63. Self-hosted small classifier to cut LLM COGS to near zero at volume
64. Team/family plans
65. API + Zapier/Make integrations
66. Attachment archival to Drive before trashing
67. Advanced rules engine for power users migrating off Clean Email
68. SOC 2 Type I (unblocks business buyers)
69. Workspace Marketplace listing (needs CASA Tier 3 — only if B2B revenue justifies ~$4,500/yr)
70. Annual plan push + pricing-power test

---

## Critical Path

Nothing matters before **6 → 8 → 9 → 13 → 17 → 19 → 20**. That chain is the product. Iterations 1–22 are the only ones that must happen in order; most of Phases 4–7 can be reordered by what the first 100 users complain about.

**Start iteration 38 (OAuth verification submission) as early as iteration 24.** It is free, it is slow, and it is the long pole on public launch. Everything else can proceed while that clock runs.
