# SEO Plan

*Written 3 September 2026, the day `mailwarden.xyz` went live and OAuth
verification cleared.*

## 0. What the Lighthouse 100 does and does not mean

Every public page scores **100 / 100 / 100 / 100** in Lighthouse, on the mobile
preset with 4× CPU throttling and simulated slow 4G, measured against the live
site. Core Web Vitals on production:

| Metric | Value |
|---|---|
| First Contentful Paint | 1.3 s |
| Largest Contentful Paint | 1.3 s |
| Total Blocking Time | 30 ms |
| Cumulative Layout Shift | **0** |
| Speed Index | 1.6 s |

That is worth having and it is **not SEO**. It means a crawler can read the
pages without friction. It says nothing about whether anybody finds them.

The honest position on 3 September 2026: the domain is days old, there are six
public pages, and four of them are the homepage, pricing, privacy and terms.
**Mailwarden can rank for the word "Mailwarden" and essentially nothing else.**
Everything below is about fixing that, in priority order.

---

## 1. Own the content instead of renting it — done, keep doing it

This was the single largest lever, and it was a *distribution* bug rather than a
technical one.

`content/series-plan.md` describes five articles with real numbers, real bug
stories, and real architecture. Two are written. `content/distribution-outreach-plan.md`
published them **to Medium first**, with mailwarden.xyz receiving a footer link.
Every ranking signal that content earned would have accrued to `medium.com`, and
the plan's "portfolio blog" was a third domain again.

**The fix costs nothing extra — it is an ordering change:**

1. Publish at `mailwarden.xyz/blog/<slug>/` first.
2. Wait for Google to index it. Check in Search Console; days, not weeks.
3. *Then* syndicate to Medium using **Import a story**, which sets
   `rel="canonical"` back to the original automatically.

Medium's distribution still works. The authority lands on the domain that sells
the product. Do not paste the text into Medium's editor as a new post — that
creates a competing copy with no canonical, and Medium will usually outrank you
on your own words.

**Shipped:** `/blog/` index and Article 1 at
`/blog/why-i-stopped-trusting-full-access-gmail-cleanup-tools/`, with
`BlogPosting` and `BreadcrumbList` schema, sitemap entries, and a homepage link.
Both score 100 across all four Lighthouse categories.

### URL rules for everything published here

- **Directories, not `.html`** — `/blog/<slug>/`. A slug never has to change;
  a filename eventually does, and a URL that moves after being linked to loses
  everything it earned.
- **The slug is the keyword phrase**, not the headline. Article 1's headline is
  "Why I stopped trusting full-access Gmail cleanup tools (and built my own)";
  the slug drops the parenthetical.
- **Never rename a published slug.** If one must change, it needs a 301 — and
  there is no redirect table in this app, so avoid the situation.

### The checks that keep this honest

`smoke.ts` §19 enumerates `PUBLIC_PAGES` and asserts, for every one: a doctype,
a `lang`, a title, a meta description of at least 40 characters, a canonical
that points at itself, that the canonical is in the sitemap, that `og:url`
matches the canonical, and that `og:image` resolves to a file that exists.

**Adding a post means adding it to `PUBLIC_PAGES` and to `sitemap.xml`.** The
build fails otherwise, which is the point — a sitemap that silently stops
listing new posts is the failure mode this catches.

---

## 2. Comparison pages

Already priority 1 in `docs/02` §4, and still right. Highest intent first:

| Page | Why |
|---|---|
| `/vs/unroll-me/` | The 2017 data-selling story still drives "is unroll.me safe" searches. This is the highest-intent query available to us. |
| `/vs/clean-email/` | The direct competitor. $29.99/yr against a ₹299 one-time pass. |
| `/gmail-storage-full/` | Problem-first, not brand-first — the largest volume and the least competition from the brands themselves. |
| `/vs/trimbox/` | Smaller, but cheap to write once the template exists. |

We have an asset nobody else in this category has: **`gmail.modify` cannot
permanently delete mail, and that is verifiable by anyone.** It is the exact
anxiety behind the searches, and no full-access competitor can make the claim.

**Be scrupulously fair in these.** Say plainly what Clean Email does better —
it has more filters and a longer track record. The credibility *is* the
conversion mechanism; a comparison page that never concedes anything reads as
marketing and converts like marketing.

---

## 3. What cannot be shortcut

`mailwarden.xyz` was registered on **3 September 2026**. Realistic expectations:

| Horizon | What to expect |
|---|---|
| Weeks | Brand terms — "Mailwarden" — start resolving |
| 1–3 months | Long-tail article queries begin appearing in Search Console |
| **3–6 months** | Comparison pages become competitive, *if* they exist by then |

This is the argument for publishing now rather than polishing. The content has
to be aging while the domain ages. There is nothing to buy that changes this.

---

## 4. Search Console

OAuth verification required domain ownership, so the property almost certainly
exists already. Confirm:

- [ ] The **Domain** property (not URL-prefix) is verified for `mailwarden.xyz`
- [ ] `https://mailwarden.xyz/sitemap.xml` is submitted
- [ ] Coverage shows all six pages indexed, not "Discovered — currently not indexed"
- [ ] `/blog/` posts appear within a week of publishing

Coverage is the only real signal this early. Impressions will be near zero for
months and that is not a problem to solve.

---

## 5. Not SEO, but the same budget line

`docs/02` §4 ranks the **receipt screenshot** second, and it deserves to stay
there. Every completed cleanup produces a shareable number. That is a cheaper
acquisition channel than anything on this page and it compounds faster than
domain authority does. Do not let SEO work crowd it out — SEO is the channel
that pays in six months; the receipt is the one that pays this week.

---

## 6. Fixed on the way here

Two live defects found while auditing, both now corrected:

- **`pricing.html` meta description and `og:description` still advertised
  "One payment, lifetime access, only 100 seats."** That is the snippet Google
  shows for the pricing page — selling a tier that no longer exists. Missed in
  the repricing commit because the visible copy and the JSON-LD were updated
  and the `<head>` was not.
- **`sitemap.xml` `lastmod` was 2026-08-21** on every page, telling crawlers
  nothing had changed since — on a day when all of them changed materially.

**The lesson worth keeping: `<head>` metadata is invisible in review.** Nobody
looking at the rendered pricing page would have caught it. When copy changes,
grep the `<head>` too.
