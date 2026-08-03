# Testing

This repo had no tests before. It now has two layers, chosen to fit a site
with no build step and no runtime dependencies.

| Layer | Runner | Covers |
| --- | --- | --- |
| Unit / static | `node --test` (built in, zero deps) | `api/lead.js`, link and sitemap integrity, page metadata, deploy config |
| End-to-end | Playwright (dev dependency only) | the contact form, mobile nav, reveal fallbacks, response headers |

## Running

```bash
npm install          # dev tooling only; the site itself stays dependency-free
npm test             # unit + static + SEO + config
npm run test:coverage
npm run test:e2e     # Playwright; starts its own static server
npm run test:all
npm run serve        # browse the site locally on :4321 with Vercel-like routing
```

CI runs the unit job and the e2e job separately on every push and pull
request (`.github/workflows/test.yml`).

## Layout

```
test/
  lead.test.js            api/lead.js — the only conversion path
  static.test.js          links, assets, sitemap, ?offer= contract
  seo.test.js             titles, Open Graph, JSON-LD, markup a11y
  config.test.js          vercel.json, robots.txt, package.json
  helpers/
    lead-harness.js       fake req/res + fetch stub for the handler
    pages.js              page list and metadata extraction
    static-server.js      zero-dep server reproducing Vercel cleanUrls
e2e/
  contact-form.spec.js    submit, failure paths, ?offer= prefill, honeypot
  navigation.spec.js      mobile nav a11y, headers, no-JS and reduced-motion
```

## Why these things are tested

`api/lead.js` is where the risk is: it holds the service-role key, writes to
`lead_submissions`, and is the site's only lead capture. It now has 100% line,
branch, and function coverage. The tests deliberately pin a few behaviours
that are easy to break silently:

- The **honeypot answers 200 while writing nothing**. A refactor that "fixed"
  the misleading success response would tell every bot its submission failed
  and invite retries.
- **No failure path leaks anything.** PostgREST error text and the service-role
  key must reach the server log and never the browser. One test drives every
  status code and asserts the key and project URL appear in no response body.
- **The row shape matches the table.** `site` and `form_type` are `NOT NULL`,
  and the context fields are flattened into `props` with snake_case keys.
- **The throttle is best-effort, and the tests say so** rather than pretending
  it is a rate limiter (see the notes below).

The static suite exists because renaming a page is a two-line change that can
break the nav, the sitemap, and the canonical tags at once. The `?offer=`
tests cover a real cross-file contract: `/speaking` and `/academy` deep-link
into the form with a preselected offer, and nothing else would notice if the
`<option>` values drifted.

## Notes and known trade-offs

These are recorded behaviours, not bugs to fix blindly. Each has a test
pinning it, so changing one is a deliberate act.

- **The throttle counts before it validates.** Six malformed submissions in a
  minute lock a visitor out even though none reached the database.
- **Crossing 500 tracked IPs clears the whole map**, including the history of
  anyone currently being throttled. Fine for a best-effort guard on an
  ephemeral serverless instance; a per-key eviction would be the fix if it ever
  matters. As the source comment says, real spam pressure wants Vercel's WAF or
  a Turnstile challenge instead.
- **Truncation runs before validation.** An email over 200 characters gets its
  `@` cut off and is reported as malformed rather than too long. Harmless at
  the current limit (RFC 5321 caps a path at 256) but worth knowing before
  anyone lowers `MAX.email`.
- **Titles and meta descriptions exceed what search results display.** Titles
  run 49–86 characters and descriptions 168–212, against roughly 60 and 160
  before truncation. Nothing is broken and no test fails on it — the bounds in
  `seo.test.js` are set to catch a pasted paragraph, not to enforce SEO
  cosmetics. Worth a copy pass at some point.

## Things deliberately not tested

The parallax and pointer-glow effects in `assets/site.js` are presentational
and expensive to assert meaningfully; the reduced-motion guard around them is
tested instead, because that one has an accessibility consequence. Visual
regression is also out of scope — it needs baseline images and a stable
rendering environment, and would mostly catch intentional design changes.

## Deployment

Nothing in this directory ships. `.vercelignore` excludes the test tooling
*and* `package.json`, so Vercel keeps treating the repo as a static site with
one function and never runs an install step — which is exactly how it deployed
before any of this was added.
