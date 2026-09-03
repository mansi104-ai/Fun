# Brand roadmap — what's next

Written 21 Aug 2026, the night of the first launch push.
Companion to [docs/09](09-brand.md), which defines the system. This one is about
the surfaces the system has not reached yet.

---

## 0. The first decision: do not rebrand

The identity is sound and it is better reasoned than most seed-stage products'.
The monochrome call, the no-serif argument, the envelope-over-shield reversal —
each is written down with the reason it was made, which is the part almost
nobody does. It does not need revisiting.

**The risk at this stage is redecorating instead of shipping.** A logo has a
seductive property: it always feels improvable, and working on it always feels
like progress. Everything below is a surface the brand has not reached yet
rather than a surface it reached badly. That ordering is the whole point of this
document.

---

## 1. The domain — the largest branding item you have

Right now the brand's address is `mailwarden.fly.dev`.

This costs you twice, and the second cost is the expensive one:

**It reads as a hobby project.** You are asking a stranger to hand over access
to their Gmail. Everything else about the product answers "why should I trust
this" — the scope argument, the privacy page, the undo guarantee. The URL then
says "weekend project on someone else's subdomain." It is the one element of the
brand that contradicts the rest of it.

**It cannot pass OAuth verification.** Google requires the homepage domain be
registered to you. A `.fly.dev` subdomain belongs to Fly. This is not a settings
problem and no amount of Search Console verification fixes it — it is a hard
stop on ever exceeding 100 users.

`docs/09` §7 already names `mailwarden.xyz`. Do it, and do the three steps
together — miss the third and OAuth breaks for everyone at once:

```bash
flyctl certs add mailwarden.xyz
flyctl secrets set APP_URL=https://mailwarden.xyz
# Google Cloud → Credentials → add https://mailwarden.xyz/auth/google/callback
```

Then update `og:url` and `canonical` on all four public pages, the branding
fields on the consent screen, `sitemap.xml`, and the `SoftwareApplication`
`url` in the ld+json block.

**Do not do this mid-launch.** DNS propagation plus certificate issuance plus a
redirect-URI change is not a thing to start while traffic is arriving.

---

## 2. Lock the written form of the name

Three spellings are currently in circulation: `Mailwarden` (consent screen,
docs, page copy), `mailwarden` (the drawn wordmark), and `MailWarden` (informal
use). Google's branding check has already flagged a name mismatch once.

**The rule, from here on:**

| Context | Form |
|---|---|
| Prose, headings, page copy, store listings | **Mailwarden** |
| Every configured field — OAuth consent screen, Stripe products, DNS, social bios | **Mailwarden** |
| The drawn wordmark and the favicon only | lowercase `mailwarden` |
| Never | `MailWarden`, `Mail Warden`, `MW` |

Lowercase is a *typographic* treatment of the logotype, not an alternative
spelling. That distinction is what keeps the design decision in §3 of docs/09
without it becoming a compliance problem every time a reviewer diffs your
consent screen against your homepage.

---

## 3. The receipt is your most important undesigned surface

`docs/02` §4 ranks the receipt screenshot as the **second-highest growth channel
you have**, above the Chrome extension and above Product Hunt. It costs nothing
to build and it turns every completed cleanup into a distribution event.

It has not been designed. This is the highest-return brand work available to you
and it is not close.

What it needs to be:

- **Screenshot-shaped.** Someone will crop it with a phone and post it. Assume
  the crop; put the number and the wordmark inside the safe area.
- **One number, enormous.** "15,000 archived" at display scale. The supporting
  detail — storage freed, senders resolved, time taken — sits at a fraction of
  the size. A receipt with four equal numbers has no headline.
- **The guarantee, visibly.** "Reversible for 30 days · nothing permanently
  deleted" on the artefact itself. That line is what makes a shared screenshot
  an argument rather than a brag, and it travels to people who will never read
  your landing page.
- **A one-tap share.** Copy image, download PNG, tweet it. Every extra step
  costs you most of the shares.
- **Honest by construction.** It reports what was verified, not what was
  attempted — consistent with the voice rule in docs/09 §5. If undo reported
  mismatches, the receipt says so.

Render it server-side to a PNG so the shared image is identical for everyone and
does not depend on the sharer's font stack, device pixel ratio, or dark-mode
setting.

---

## 4. Google's warning screen is currently your first impression

Now that the app is in production, the sequence for a new user is:

> your landing page → **"Google hasn't verified this app"** → your app

`docs/08` §3 already identifies that middle screen as the single biggest
drop-off in the funnel. It is also, unavoidably, a brand moment: it is the first
thing many people will see after clicking a link from a stranger's post.

**Build a pre-flight interstitial** between "Clean my Gmail" and the Google
redirect. One short screen, in the product's voice:

- what they are about to see, and that it is expected
- why it appears — verification is in progress, and that is what the founding
  seats fund
- exactly which permissions are being requested, restated in one line each
- the literal instruction: Advanced → Continue

This is the clearest possible application of the docs/09 §5 voice rule — *a
limitation admitted buys more trust than a benefit claimed*. It is also the
cheapest conversion work on this list. Retire the page when verification clears.

---

## 5. Email is an undesigned surface too

Transactional mail is the only 1:1 branded surface the product has, and there
is currently nothing there. At minimum:

| Mail | Trigger | Job |
|---|---|---|
| You're in | Access granted | Pre-frame the warning screen, set expectations, one link |
| Receipt | Cleanup completed | Mirror the in-app receipt; make it forwardable |
| What did you expect? | ~7 days after first cleanup | The one question in docs/02 §2 that produces the iteration backlog |

Plain-text-leaning, one column, system fonts, no images that break when blocked.
An inbox-cleanup product that sends heavy marketing mail is telling on itself —
the restraint is the brand argument.

---

## 6. Comparison pages are voice work, not just SEO

`docs/02` §4 makes these the top growth priority: `/vs/clean-email`,
`/vs/unroll-me`, `/vs/trimbox`, `/gmail-storage-full`.

Treat them as brand surfaces. The instruction in docs/00 §5 — *attack the
category practice, not the named company* — is both the safer position and the
more persuasive one. A comparison page that is scrupulously fair to the
competitor converts better than one that is not, because the credibility **is**
the conversion mechanism. Include a row where the competitor wins. Readers who
find one trust every other row.

---

## 7. Decide what `seeker_1010` is

Right now a handle markets a product with no stated relationship between them.
That is fine for a week and corrosive over a quarter — a Gmail-access product
whose public voice is anonymous is working against its own pitch.

Three coherent options; pick one deliberately rather than drifting:

1. **Personal handle, product account separate.** `seeker_1010` is you; a
   `@mailwarden` account carries product news. Cleanest, most work.
2. **Handle is the product's voice.** Bio states plainly "I build Mailwarden."
   Cheapest, works well on HN and Reddit where builder identity is the norm.
3. **Handle retires into a named byline** once verification clears and the
   product is public. The trust argument gets easier the moment there is a
   person behind it.

Option 2 now, option 3 by the time the funnel opens, is the path I would take.

---

## 8. Housekeeping — drift already accumulating

Small, but this is exactly how a documented system stops being one:

- **`docs/09` §6 is stale.** It lists `og.png` and `apple-touch-icon.png` as
  missing; both shipped. `web/brand/README.md` already records them correctly.
  Delete §6 or point it at the README.
- **Two undocumented assets.** `brand_1.png` (448 KB) and `mark.png` appeared in
  `web/brand/` on 21 Aug and are in neither inventory. Either add rows to the
  README or remove them — 448 KB of unexplained raster in the served directory
  is the kind of thing that becomes load-bearing by accident.
- **The mark's description disagrees with itself.** `web/brand/README.md`
  describes "envelope + sparkle"; `docs/09` §3 describes an envelope with no
  sparkle. One of them is wrong. Fix whichever does not match the file.

---

## What not to do

Each of these will feel like an improvement and is not:

| Don't | Because |
|---|---|
| Add an accent colour | docs/09 §1 already worked out why contrast is the accent, and gold specifically failed a contrast check. Re-litigating costs a week and loses. |
| Add a webfont | The CSP is `default-src 'self'` with no `font-src`, and that policy has already caught a real production bug. Punching a hole in it for typography is a bad trade. |
| Redraw the mark | It is legible at 16 px, which is the only size that matters. Nothing is wrong with it. |
| Commission a logo, run a rebrand, hire a designer | At 100 seats the constraint is trust and distribution, not visual identity. Spend it on the receipt. |
| Put BBI's identity on the product | docs/09 opens by explaining why not. Still true. A footer credit is the most it should ever be. |

---

## Sequence

| When | Item | Why then |
|---|---|---|
| After the launch push settles | §1 domain | Blocks verification; blocks everything past 100 users |
| Same session as §1 | §2 name lock | The consent-screen fields are already open |
| Week 1 | §4 pre-flight screen | Every signup between now and verification passes through it |
| Week 1–2 | §3 receipt | Highest-return work on this list once traffic exists to share it |
| Week 2 | §5 welcome mail | Needed the moment onboarding stops being ten people you know |
| Week 2 | §8 housekeeping | Twenty minutes; do it before the drift compounds |
| Week 3+ | §6 comparison pages | Needs verification progress and real testimonials to be credible |
| Before the funnel opens | §7 identity decision | Forced by the first press or PH launch anyway |

The ordering is not by effort or by appeal. It is by what unblocks the next
thing: the domain unblocks verification, verification unblocks the cap, and the
receipt is what fills the seats the cap stops capping.
