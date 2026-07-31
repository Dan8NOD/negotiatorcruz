# Content-Security-Policy

Set in `vercel.json` on `/:path*`. This note exists because the two decisions
below look like sloppiness unless the reasoning is written down.

```
default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline';
img-src 'self'; font-src 'self'; connect-src 'self'; form-action 'self';
frame-src 'none'; object-src 'none'; base-uri 'none'; frame-ancestors 'self';
upgrade-insecure-requests
```

## What had to move first

`script-src 'self'` refuses inline `<script>`, so three blocks were lifted out
verbatim. No logic changed — only the wrapper:

| Was | Now |
|---|---|
| `index.html` inline `<style>` | `assets/mini-ad.css` |
| `index.html` inline `<script>` | `assets/mini-ad.js` |
| `contact.html` inline `<script>` | `assets/lead-form.js` |

The mini-ad's header comment used to advertise it as single-file portable. It
isn't any more; reusing it now means copying three pieces, and the comment says
so.

## Why `style-src` still allows `'unsafe-inline'`

There are 41 `style="…"` attributes across the pages. Hashes do not cover style
*attributes* — only `<style>` elements — so removing `'unsafe-inline'` would
mean converting all 41 to classes, with a real chance of visual regressions, in
exchange for very little. Inline style is not a script-execution vector, and
`script-src` is where the actual protection is. If those attributes ever get
cleaned up for other reasons, tighten this then.

## Why Calendly isn't in the policy

Every Calendly reference is an ordinary `<a href>` navigation, not an embed or a
fetch. Navigation away from the site is not governed by CSP, so no directive
needs to name it. `frame-src 'none'` is safe today for the same reason — **if a
Calendly inline embed is ever added, that widget will be blocked** until
`frame-src https://calendly.com` and `script-src https://assets.calendly.com`
are added.

`connect-src 'self'` covers the contact form's `fetch('/api/lead')`, which is
same-origin.

## Why the header block is declared twice

`vercel.json` carries the same five headers under **two** sources, `/(.*)` and
`/`. That is not a copy-paste slip.

The previous config used a single `"source": "/:path*"`, and on production that
rule did not match the bare root. Measured against live `negotiatorcruz.com`:

| Path | Security headers |
|---|---|
| `/` | **missing** |
| `/about`, `/system` | present |
| `/assets/site.css` | present |
| `/api/lead` | present |

So the homepage — the most-visited page on the site — was the one page serving
none of them, and had this CSP shipped under the same source it would have
inherited exactly the same hole.

Two things it is *not*: `/system` and `/assets/site.css` are served from cache
(`x-vercel-cache: HIT`) and still carry the headers, so a stale CDN entry is not
the cause; and `path-to-regexp` matches `/` for both `/:path*` and `/(.*)` in
isolation, so it is not the pattern syntax alone. It is specific to how the
production edge resolves the root, and **`vercel dev` does not reproduce it** —
locally `/:path*` covers `/` quite happily. That is why the explicit `/` rule is
there rather than a tidier one-line pattern change: it is the only form that
cannot silently miss.

`verify.sh` asserts the two blocks stay byte-identical, since duplicated config
is exactly what drifts.

**Confirm after the first production deploy:**

```bash
curl -sS -D- -o /dev/null https://negotiatorcruz.com/ | grep -i 'content-security-policy\|x-frame-options'
```

If the catch-all turns out to cover `/` on its own, the explicit rule can be
dropped — but verify on production, not locally.

## Verified before merge

Served locally with this exact header (`docs/agent-backlog/` has the pattern),
then per page:

- the contact form submitted end-to-end and rendered its success state — the
  `/api/lead` fetch is not blocked
- `assets/mini-ad.js` ran and rendered its cards; `mini-ad.css` applied
- every JSON-LD block still parses — non-executable `<script type>` data blocks
  are exempt from `script-src`, so they need no hash
- an injected inline `<script>` was **refused**, confirming the policy is
  enforcing rather than inert
- zero console violations on all seven pages; every referenced local asset 200s

The remaining gate is a Vercel preview deploy: the header is applied by the
platform there, not by the local test server.

## If something breaks

The failure mode is silent — a blocked resource logs to console and does
nothing else. Check DevTools console for `Refused to …`. To diagnose in
production without breaking anything, rename the header to
`Content-Security-Policy-Report-Only`, which logs violations while enforcing
nothing.
