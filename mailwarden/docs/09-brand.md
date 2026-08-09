# BBI brand — as applied to Mailwarden

Mailwarden is a product of **BBI** (Building · Creating · Impacting), the
personal brand of a solo founder building in public.

The machine-readable version of everything below is
[`web/brand.css`](../web/brand.css). That file is the source of truth; this
document explains the decisions it encodes.

---

## Colour

| Token | Hex | Role |
|---|---|---|
| Ink | `#0A0A0A` | Page ground in dark, brand tile in light |
| Paper | `#FFFFFF` | Surfaces in light |
| Graphite | `#2B2B2B` | Raised surfaces in dark |
| Mist | `#E5E5E5` | Borders in light |
| **Gold** | **`#D4AF37`** | The single accent |

### The one adjustment I made, and why

**Gold cannot be used as text on white.** `#D4AF37` on `#FFFFFF` is roughly
**2:1** contrast, against the 4.5:1 minimum — legible to some people in some
light, and invisible to others. It is excellent as a *fill* with ink on top
(~9.8:1).

So the accent splits in two:

```css
--accent:      #D4AF37   /* fills — buttons, highlights */
--accent-fg:   #0A0A0A   /* text ON a gold fill */
--accent-text: #7A5F14   /* accent-coloured TEXT on light surfaces */
```

On ink, gold text clears 9:1, so `--accent-text` becomes the full gold in dark
mode. Links and small accent text stay readable in both themes without ever
looking off-brand.

---

## Type

| Role | Face |
|---|---|
| Headings | Playfair Display, 600 |
| Body | Inter |

### Playfair is not currently loading

The app's CSP is `default-src 'self'` with **no `font-src`**, so Google Fonts is
blocked outright. Loosening the CSP for a webfont would weaken the policy that
already caught one real bug, so the fix is to self-host.

`brand.css` already contains the `@font-face` rule pointing at
`/fonts/playfair-display-600.woff2`. **Drop that file in and it starts working
with no other change** — a missing `src` makes the browser fall through to the
next family rather than render nothing.

Until then headings use a high-contrast serif fallback (Iowan Old Style →
Palatino → Georgia), which holds the same editorial feel.

Get the file from <https://fonts.google.com/specimen/Playfair+Display> →
Download family → convert the 600 weight to woff2 → `web/fonts/`.

---

## The mark

The BBI kit shows Mailwarden as a **shield**, not an envelope. That is the
better mark and I switched to it:

- "**Warden**" is the half of the name doing the work.
- A shield is what the product actually promises — nothing important gets
  deleted, everything is reversible.
- An envelope alone says "email client", which Mailwarden is not.

The envelope now sits *inside* the shield, so the mark still reads as mail at a
glance. Wordmark is **lowercase** `mailwarden`, per the kit's application
examples.

---

## Voice

From the kit, and worth holding to because the product's entire pitch is trust:

| | |
|---|---|
| **Personal & Authentic** | Real, transparent, human |
| **Curious & Creative** | Always learning, building, improving |
| **Builder Mindset** | From ideas to products that solve real problems |
| **Impact Driven** | Creating value for users and the world |

Keywords: *Minimal · Focused · Builder · Reliable · Thoughtful*

### What this means in copy, concretely

Mailwarden's copy already follows this, and it should keep doing so:

- **Admit limits out loud.** "Only 100 seats" works *because* the page explains
  Google imposed the cap. "UPI cannot take international cards" is stated on the
  pricing page rather than discovered at checkout. A limitation admitted is
  worth more than a benefit claimed.
- **Never claim a success you did not have.** The unsubscribe engine says which
  mechanism it used and what it could not do. Undo reports mismatches instead of
  counting them as restored.
- **No vendor names in product copy.** Users cannot perceive which model ran;
  they can perceive what it did. "Two-pass classification — every ambiguous
  sender gets a second, deeper review" survives a change of provider.

Tagline, from the kit: **Clean inbox. Clear mind. More focus.**

---

## Still missing

I cannot produce raster files, so these need exporting from the original
artwork and dropping into `web/brand/`:

| File | Size | Cost of not having it |
|---|---|---|
| `og.png` | 1200×630 | Every link shared to Twitter/LinkedIn/Slack renders with no preview image — directly costs clicks on launch posts |
| `apple-touch-icon.png` | 180×180 | iOS home screen falls back to a screenshot |
| `playfair-display-600.woff2` | — | Headings use a fallback serif |

The brand-kit image itself also lives outside the repo; this document and
`brand.css` are its canonical form here.

---

## Domain

The kit lists **mailwarden.ai**. Production currently runs on
`mailwarden.fly.dev`. When the domain is pointed at Fly, three things must
change together:

1. `flyctl certs add mailwarden.ai`
2. `flyctl secrets set APP_URL=https://mailwarden.ai`
3. Google Cloud → Credentials → add `https://mailwarden.ai/auth/google/callback`
   as an authorised redirect URI

Miss the third and OAuth breaks with `redirect_uri_mismatch` for everyone.
