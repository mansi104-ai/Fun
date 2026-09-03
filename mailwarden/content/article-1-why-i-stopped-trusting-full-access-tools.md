*This is Article 1 of a 5-part series on how MailWarden is actually built — the sender-level architecture, the guardrail system, and the data-minimization design. Follow along at [@seeker_1010](https://twitter.com/seeker_1010).*

# Why I Stopped Trusting Full-Access Gmail Cleanup Tools (And Built My Own)

My Gmail had drifted to 6,010 messages. Every cleanup tool I tried asked me for one of two things I wasn't willing to give: hours of reviewing emails one at a time, or full access to my mailbox and blind trust that nothing would go wrong.

Neither is actually a solution — one just moves the tedium, the other just moves the risk. So I built MailWarden, and last week I finally ran it on my own real inbox. Here's what happened, and the three decisions that made it possible.

## The inbox isn't 6,010 things. It's 261.

The first insight is almost embarrassingly simple once you see it: nobody's inbox is actually thousands of independent problems. On my own account, 6,010 messages broke down to **261 distinct senders**. Newsletters I subscribed to once. Promotional blasts from things I signed up for years ago. Notification digests I've never opened.

The number of real *decisions* — does this sender matter or not — was never 6,010. It was 261. Message count was just noise multiplying a small number of real choices.

So MailWarden classifies at the sender level, not the message level: aggregate everything from one sender, show the evidence, make one decision that applies to everything from that source. That's a **23× reduction** in decisions for a person — and because classification runs once per sender instead of once per message, it's also roughly a **100× reduction in inference cost**. Those aren't two separate wins from two separate design choices. They're the same fact, looked at from two directions: fewer decisions for a human is fewer classifications for a model, because they're counting the same 261 things.

That ratio is also what makes a genuinely useful free tier survive on a tight LLM budget at all — spending a handful of model calls on 261 senders is viable in a way that spending them on 6,010 raw messages never would be.

## It's structurally incapable of permanently deleting anything

Here's the decision I spent more time on than any other, and the one I think matters more than the speed.

I didn't want to promise "we'll be careful with your data" and ask you to believe me. I wanted a constraint that didn't depend on my code being bug-free, or my intentions staying good, or the app still existing next year.

Gmail's API offers a scope called `mail.google.com` that grants full access, including permanent deletion. MailWarden never requests it. It requests `gmail.modify` instead — which can archive, label, and trash, but **cannot** permanently delete. Google will not grant that capability under this scope, full stop.

That's not a setting I could quietly change later. It's the permission boundary the app runs inside. Worst case — a misclassification, a bug I haven't found yet, anything at all — the affected mail lands in your own Gmail trash, where Gmail itself holds it for 30 days before anyone can touch it again. You could restore it yourself with MailWarden switched off entirely.

I built this constraint before I built the product, on purpose. If it doesn't hold, nothing else — the speed, the UI, the classification accuracy — matters at all.

> **[Insert screenshot here: `mailwarden-screenshot-overview.png`]**
> The actual overview screen, from a real run against a seeded demo inbox — not a mockup. The three-way split (Safe / Review / Protected) is the whole trust model in one screen: 11,176 safe to clean, 0 needing review, 1,726 protected and untouched.

It also isn't only a trust argument; it's an economic one. Google's app-verification process (CASA) prices access tiers by what an app can do: the tier that allows full mailbox access runs roughly **$4,500/year** to maintain verification for. The tier that matches `gmail.modify` runs **$540–$1,800/year**. One decision bought three things at once: a real undo guarantee, a marketing claim no full-access competitor can honestly make, and a compliance bill I can actually afford as a solo builder.

## Consent isn't a checkbox — it's the interaction model

Every batch in MailWarden follows the same loop: preview, explicit approval, execute, receipt. Nothing moves without a click on a screen that shows exactly what's about to move — and the count on that screen isn't a rough estimate. It's produced by dry-running the *real* safety policy before you ever see it, so the number on the tile is exactly what will happen when you click. A tile that promises 2,341 and delivers 1,800 destroys trust faster than a tile that never existed.

Every message's prior state is recorded before anything changes, which is what makes undo exact rather than approximate — reversing a batch doesn't guess at what it looked like before, it replays what was actually recorded.

## What it looked like on my own inbox

I connected my real account — the one I'd been avoiding cleaning up for years. MailWarden aggregated it down to 261 senders, showed me what it found and why, and I approved in batches rather than reviewing message by message. Fifteen thousand messages archived, non-essential only, in under five minutes.

Nothing starred was touched. Nothing in a thread I'd replied to was touched. No attachments, no receipts, no login codes. That's not a claim about the demo account — it's what happened on my own real mail, because those protections run whether or not I'm watching.

## Where things actually stand

I'd rather you know the real state than find out mid-signup: MailWarden is in a closed beta capped at 100 users. That's not artificial scarcity — it's the real limit Google places on an OAuth app that hasn't finished verification review yet. You'll see Google's "this app isn't verified" warning on sign-in for the same reason; Advanced → Continue gets you past it. I'd rather flag that here than have it catch you off guard.

Pricing once verification clears: a free tier that runs a full scan and one complete real cleanup — no card required, because the failure mode I designed against is the tool that lets you scan for free and then walls you before a single action completes — then $19/yr or $39/yr depending on tier. For now, the first 100 users get lifetime access for a one-time $49, tied to the actual cap rather than a marketing round number.

## Why I'm writing this instead of just linking the app

The pitch isn't really "clean your inbox fast," even though that's true. It's "you shouldn't have to trust a tool with data it doesn't need, or power it doesn't need to have." Sender-level aggregation is what makes the speed possible. `gmail.modify` is what makes the trust possible. I think the second one is the actual product, and the first is just what makes it usable day to day.

This is article one of a series where I'm going to open the whole thing up — the sync and classification pipeline that turns thousands of messages into a couple hundred decisions, the single chokepoint every mailbox mutation has to pass through, and exactly what does and doesn't reach a third-party model when the classifier needs help. If you've been burned by a cleanup tool before, or avoided trying one because "full access to my email" felt like too much to ask for too little in return, I think the next few posts will be for you.

Try it at [mailwarden.xyz](https://mailwarden.xyz/). Happy to answer anything about the architecture, the scope decision, or the verification timeline in the comments.

---

*Next: how 6,010 emails become 261 decisions — the sync strategy, the four-tier classifier, and the bug that once locked a third of a real mailbox over one stray reply.*

*Building this in public — follow along at [@seeker_1010](https://twitter.com/seeker_1010) on X.*
