# UI Design Spec — Inspiration and Rules

## 1. What We Borrow

**Superhuman** — keyboard-first, sub-100ms perceived interactions, command palette, *one-key triage*. Their core insight: when a decision costs one keystroke instead of three clicks, users will make 200 of them in a sitting. Our review queue is exactly that shape, so we take: `E` archive, `T` trash, `K` keep, `U` unsubscribe, `⌘K` palette, `J/K` navigate. A user should be able to clear 200 senders without touching the mouse.

**Shortwave** — grouping conversations as threads rather than rows. We generalise it one level up: **the sender is the thread.** One card per sender, not per message.

**Clean Email** — their "Smart Views" prove that named, pre-built cohorts ("Old & Unread", "Top Senders") outperform a raw filter builder. We ship named cohorts as the default surface and hide the rule builder until iteration 67.

**Linear / Vercel dashboards** — density with breathing room, muted surfaces, one accent colour, real typographic hierarchy. Inbox tools traditionally look like 2011 webmail; looking modern is cheap differentiation.

**What we deliberately reject:** Unroll.me's "Rollup" pattern. It hides mail in a digest rather than resolving it, which defers the decision instead of ending it.

## 2. The Three Screens

Everything ships as three screens. Resist adding a fourth.

### Screen 1 — Scan
Live progress during first sync. This is a 2–6 minute wait on a large inbox and it is where users abandon, so it must feel like *work being done for you*, not a spinner.

Show, updating live: messages scanned, senders found, storage attributed, and a scrolling ticker of sender names as they're discovered. Ends on a single number: **"You have 312 bulk senders sending you 41,204 emails."**

### Screen 2 — Review (the product)
Sender cards in a single column, sorted by impact (count × recency decay).

```
┌──────────────────────────────────────────────────────────┐
│  ● Groupon                          promotions · 94% unread│
│    2,341 emails · 412 MB · since Mar 2019                 │
│    "Your Tuesday deals are here" +2,340 more              │
│                                                            │
│    [ Keep ]  [ Archive all ]  [ Trash all ]  [ Unsub ]    │
└──────────────────────────────────────────────────────────┘
```

Rules:
- Every card states **why** it was categorised that way. No black box.
- Protected senders (OTP, receipts, anyone you've replied to) render with a lock and cannot be bulk-actioned without an explicit override. This is the anti-"I lost my boarding pass" guarantee.
- Action buttons say what happens, not what they are: **"Archive all 2,341"**.
- Nothing executes on click. Clicks build a **pending batch**, shown in a sticky footer.

### Screen 3 — Confirm & Receipt
The consent gate. Sticky footer expands to a full summary:

> **You are about to archive 8,412 emails from 23 senders and trash 1,203 from 4 senders.**
> Nothing is permanently deleted. Everything is restorable for 30 days.
> `[ Review list ]` `[ Confirm ]`

Then a live progress bar, then a receipt with a persistent **Undo everything** button. The receipt is the shareable moment — make it screenshot-worthy, because that screenshot is free marketing.

## 3. Non-Negotiable Interaction Rules

1. **No destructive action without a preview screen listing exactly what moves.** No exceptions, no "don't show again."
2. **Undo is a primary button, never a menu item.** It is the feature, not an escape hatch.
3. **Never paywall mid-job.** The wall appears when a cleanup would exceed the allowance — *before* the confirm screen, never between confirming and executing — and it always states the two real numbers: what this job needs, and what is left. "This cleanup covers 6,645 messages and you have 1,000 left this month." A refusal that does not say how far short it is leaves the user with nothing to act on. The remaining allowance is also shown in Settings, so the wall is never the first time anybody hears about it.
4. **Optimistic UI everywhere.** Gmail batch calls take seconds; the card should animate out instantly and reconcile after.
5. **Copy uses "archive" and "trash." Never "delete."** It is legally accurate, compliance-safe, and less frightening.

## 4. Visual System

- **Type:** Inter (or system stack). One family, four weights.
- **Colour:** near-black on near-white; single accent for actions. Semantic only where it earns its place — amber = needs review, red = trash, green = protected. Never colour a card wholesale; colour the badge.
- **Density:** 12px base spacing unit. Cards breathe; the list does not.
- **Dark mode from day one** — this audience expects it, and retrofitting is painful.
- **Motion:** ≤150ms, ease-out. Only on state change. Nothing decorative.
- **Empty states carry the personality.** Everything else stays quiet.

## 5. Onboarding Copy

The consent screen is the highest-anxiety moment in the funnel. Pre-empt it *before* the Google redirect, on our own page:

> **What we ask for, and why.**
> We request permission to archive, label, and move email to trash.
> We do **not** request permission to permanently delete anything — Google won't even give us that ability with the access we use.
> We never read message bodies. We look at senders, dates, and sizes.
> Disconnect any time and we erase everything within 24 hours.

Users who read this convert *better*, not worse. Anxiety, not indifference, is the drop-off cause here.

## Sources
- [Superhuman vs Shortwave — CMDK](https://cmdk.email/post/superhuman-vs-shortwave/)
- [Shortwave vs Superhuman — Zapier](https://zapier.com/blog/shortwave-vs-superhuman/)
- [Best email apps 2026 — CMDK](https://cmdk.email/post/best-email-apps-2026/)
