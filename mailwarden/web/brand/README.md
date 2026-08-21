# Brand assets

| File | Use |
|---|---|
| `mark.svg` | Envelope + sparkle, no wordmark. Uses `currentColor`. |
| `logo.svg` | Horizontal lockup (mark + wordmark). Uses `currentColor`. |
| `favicon.svg` | Browser tab. Tiled, thicker strokes, one sparkle. |

## Why `currentColor` and not two colour variants

The app and the landing page both flip with `prefers-color-scheme`. A mark that
inherits `currentColor` needs one file and can never drift out of sync with the
palette; a pair of light/dark PNGs needs two, and one of them always ends up
stale.

The header lockups are **inlined into the HTML** rather than referenced with
`<img src>`, for the same reason — an external SVG cannot inherit the page's
colour.

## Why the favicon is a different drawing

At 16 px the open mark's strokes merge into a grey smear. `favicon.svg`
thickens them, drops the secondary sparkle, and keeps the black tile so it holds
contrast against both light and dark browser chrome. Do not replace it with a
scaled-down `mark.svg`.

## Rasters

| File | Size | Use | Status |
|---|---|---|---|
| `og.png` | 1200×630 | Open Graph / Twitter card. Mark + wordmark, centred, generous margin — it gets cropped to ~1.91:1 and to a square in some clients. | shipped |
| `apple-touch-icon.png` | 180×180 | iOS home screen. Needs the black tile; iOS ignores transparency and composites on white. | shipped |
| `icon-512.png` | 512×512 | PWA / Play listing, if the extension ships. | not needed yet |

Files here are served automatically — `@fastify/static` has `web/` as its root.

`og.png` is referenced by every public page: `index`, `pricing`, `privacy` and
`terms`. Each carries its own `og:title`, `og:description` and `og:url` but
shares the one image, along with `og:image:width`/`height` so Slack and LinkedIn
can lay the card out before they have fetched it.

`app.html` and `admin.html` deliberately have **no** social preview. The app is
behind auth and the operator page is `noindex`; neither is a link anyone should
be sharing, and giving them a card invites exactly that.

If the image is re-exported, keep it at 1200×630 or update the width/height tags
with it — a declared size that does not match the file makes the card render at
the wrong aspect ratio in the clients that trust the declaration.

## Colour (superseded — see docs/09-brand.md and web/brand.css)

The tile is `#0b0b0b`, not pure `#000` — pure black on an OLED panel makes the
rounded corners disappear against a dark page background, and the tile stops
reading as a tile.
