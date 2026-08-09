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

## Still needed — rasters (cannot be produced from SVG in-repo)

`index.html` references `/brand/og.png` for social previews. **That file does not
exist yet**, so links shared to Twitter/LinkedIn/Slack currently render without
an image.

Export these from the original artwork:

| File | Size | Use |
|---|---|---|
| `og.png` | 1200×630 | Open Graph / Twitter card. Mark + wordmark, centred, generous margin — it gets cropped to ~1.91:1 and to a square in some clients. |
| `apple-touch-icon.png` | 180×180 | iOS home screen. Needs the black tile; iOS ignores transparency and composites on white. |
| `icon-512.png` | 512×512 | PWA / Play listing, if the extension ships. |

Drop them in this directory and they are served automatically —
`@fastify/static` has `web/` as its root. Then add to `index.html`:

```html
<link rel="apple-touch-icon" href="/brand/apple-touch-icon.png" />
```

## Colour

The tile is `#0b0b0b`, not pure `#000` — pure black on an OLED panel makes the
rounded corners disappear against a dark page background, and the tile stops
reading as a tile.
