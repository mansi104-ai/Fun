# Mailwarden design system

Mailwarden is a product of **BBI** (Building · Creating · Impacting).

The machine-readable version is [`web/brand.css`](../web/brand.css) — one file,
one source of truth. This document explains the decisions it encodes.

> **Note on the BBI parent brand.** The BBI kit uses Playfair Display and a gold
> accent (`#D4AF37`). Both were tried in Mailwarden and both were reverted. The
> reasons are below. BBI keeps its own identity; the product does not have to
> wear it, and shouldn't.

---

## 1. Monochrome, no accent hue

| Token | Light | Dark |
|---|---|---|
| Background | `#FAFAFA` | `#0A0A0A` |
| Surface | `#FFFFFF` | `#131316` |
| Text | `#0A0A0A` | `#FAFAFA` |
| Muted | `#71717A` | `#A1A1AA` |
| **Primary button** | near-black on white | near-white on black |

**Contrast is the accent.** The primary button is simply the inverse of the
page, which is what Linear, Vercel and Notion all do. It needs no hue, it can
never fail a contrast check, and it makes the *content* the most colourful
thing on screen.

Semantic colour survives in exactly three places, because these carry meaning
that shape alone cannot: `--danger`, `--warn`, `--safe`.

### Why the gold came out

`#D4AF37` on white is roughly **2:1** contrast against a 4.5:1 minimum. Every
use as text needed a darker bronze substitute, so the "one accent" was really
two colours that had to be kept in sync. Gold also reads as luxury/finance —
a jarring signal on a tool whose promise is *not losing your receipts*.

---

## 2. One sans family, no webfont

```
Inter → -apple-system → Segoe UI → Roboto → Helvetica Neue → Arial
```

### Why no serif

Look at what actually ships in this category — Linear, Vercel, Notion, Height,
Raycast, Stripe, Superhuman. Every one uses a single sans family. **Nobody in
productivity software sets UI headings in a display serif.** Playfair and its
relatives read as editorial, fashion, or wedding stationery; on a tool they read
as "someone picked a font" rather than "this is well built".

That convergence isn't laziness. A utility earns trust by getting out of the
way, and a distinctive display face does the opposite.

### Why no webfont at all

- The CSP is `default-src 'self'` with no `font-src`, so Google Fonts is blocked
  outright — and that policy already caught a real production bug. Punching a
  hole in it for typography is a bad trade.
- Self-hosting means a download before the page is readable, plus a flash of
  fallback text.
- The system stack is what GitHub, Basecamp and Notion ship. It is instant and
  it looks native on every platform.

**Type is carried by scale and spacing, not by the family.** Tight tracking on
large headings (`-0.025em`) and a 1.6 body line-height do almost all the work
of making an interface look considered.

---

## 3. The mark

A **white envelope on a near-black tile**, wordmark lowercase.

A shield was tried, following the BBI kit's Mailwarden card. It was reverted:
a shield alone reads as a security badge or a VPN, and the product has to say
"mail" before it says anything else. The envelope is instantly legible at 16px,
which is the only size that really matters for a favicon.

---

## 4. Mobile

Mobile-first, verified by measuring rather than by eye:

- **Fluid type** via `clamp()` — one rule from 360px to 1440px, no breakpoint
  stack, and a minimum chosen so nothing wraps mid-word on a small phone.
- **44px minimum touch targets** on every button and input.
- **16px minimum input font size.** Anything smaller makes iOS Safari zoom the
  whole page on focus, which is the most common way a form feels broken.
- **Buttons go full-width below 560px.** A 48%-wide button whose label wraps to
  two lines is worse than a full-width one.
- **Wide content scrolls inside its own box** (`.scroll-x`), never the page.
- **`overflow-wrap: anywhere`** on sender addresses and payment references,
  which are the strings long enough to force horizontal scroll.

### A bug worth remembering

The landing page's email input rendered **240px tall** on mobile. The cause:

```css
.signup input { flex: 1 1 240px; }              /* width, in a row */
@media (max-width:560px) { .signup { flex-direction: column; } }
```

`flex-basis` follows the **main axis**. The moment the container became a
column, `240px` stopped meaning width and started meaning height. Fixed by
resetting `flex` explicitly inside the media query.

It was invisible in a plain headless screenshot and obvious the second the
element was measured — which is why layout verification now reads
`scrollWidth` vs `clientWidth` and element heights, instead of relying on a
picture.

---

## 5. Voice

From the BBI kit, and worth keeping because the product's whole pitch is trust:

**Personal & Authentic · Curious & Creative · Builder Mindset · Impact Driven**
*Minimal · Focused · Builder · Reliable · Thoughtful*

In practice that means three habits the copy already follows:

- **Admit limits out loud.** "Only 100 seats" works *because* the page explains
  Google imposed the cap. "UPI cannot take international cards" is stated on the
  pricing page rather than discovered at checkout. A limitation admitted buys
  more trust than a benefit claimed.
- **Never claim a success you did not have.** The unsubscribe engine reports
  which mechanism it used and what it could not do. Undo reports mismatches
  instead of counting them as restored.
- **No vendor names in product copy.** Users cannot perceive which model ran;
  they can perceive what it did. "Two-pass classification — every ambiguous
  sender gets a second, deeper review" survives a change of provider.

Tagline: **Clean inbox. Clear mind. More focus.**

---

## 6. Still missing

Raster files cannot be produced here; export from the original artwork into
`web/brand/`:

| File | Size | Cost of not having it |
|---|---|---|
| `og.png` | 1200×630 | Every shared link renders with no preview image — directly costs clicks on launch posts |
| `apple-touch-icon.png` | 180×180 | iOS home screen falls back to a screenshot |

---

## 7. mailwarden.xyz

Production runs on `mailwarden.fly.dev`. **This is now a launch blocker, not a
preference:** Google rejected OAuth verification with *"the website of your
homepage URL is not registered to you"*. A `*.fly.dev` subdomain is registered
to Fly.io, and no amount of Search Console verification changes whose name is
on the registration.

`mailwarden.xyz` was registered at Namecheap on 2026-09-03, and the site's own
25 self-references have already been moved onto it with:

    node scripts/set-domain.mjs https://mailwarden.xyz

It rewrites every canonical, `og:url`, sitemap entry and robots directive, and
refuses to run if it finds the tree already holding two different self-origins.
Smoke §19 fails the build if they ever disagree.

Then five things the script cannot do for you:

1. `flyctl certs add mailwarden.xyz`
2. `flyctl secrets set APP_URL=https://mailwarden.xyz`
3. Google Cloud → Credentials → add `https://mailwarden.xyz/auth/google/callback`
4. Google Cloud → OAuth consent screen → set the homepage to `https://mailwarden.xyz`
5. Search Console → verify the domain → submit `https://mailwarden.xyz/sitemap.xml`

Miss the third and OAuth breaks with `redirect_uri_mismatch` for everyone. Miss
the fourth and the verification rejection stands, because the consent screen
still points at the domain Google objected to.
