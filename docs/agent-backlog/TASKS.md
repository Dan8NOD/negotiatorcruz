# Backlog — negotiatorcruz.com

Audited against commit `3287a4b`. Read `README.md` first for the operating rules.

Every task below is self-contained: anchor text is quoted exactly as it appears in
the file, and replacement text is given in full. Copy it. Do not improvise, and do
not "improve" the replacement text — the wording is deliberate.

Line numbers are given as a hint for locating the anchor. If a line number is
stale, trust the anchor text, not the number.

---

## T1 — BLOCKED: the contact email may be wrong on every page

**Status: do not implement. Awaiting owner confirmation.**

The site publishes `negotiationsondemand@gmail.com` in 10 places. Every other
identifier on the property uses `negotiator**s**ondemand`:

- Calendly: `calendly.com/negotiatorsondemand/...`
- TikTok: `@negotiatorsondemand`
- Sister site: `negotiatorsondemand.com`
- The account this repo is administered from: `negotiatorsondemand@gmail.com`

So the published address is `negotiation-s-ondemand` where everything else is
`negotiator-s-ondemand`. If that is a typo, then every "email me directly" link —
including the fallback shown when the lead form fails — has been sending mail
into a void, and the `/api/lead` error copy tells failed leads to use it.

This is the highest-value item in this document and also the one most dangerous
to guess at. **The owner must confirm which address is correct.**

Once confirmed, if a change is needed, it is one command:

```bash
grep -rl 'negotiationsondemand@gmail.com' --include='*.html' --include='*.js' --include='*.txt' . \
  | xargs sed -i 's/negotiationsondemand@gmail\.com/CONFIRMED_ADDRESS_HERE/g'
```

Affected: `contact.html` ×4, `index.html` ×2, `api/lead.js` ×3, `llms.txt` ×1.

---

# Batch 1 — Defects

## T2 — Delete the 5 MB unreferenced coin image

`nod-coin.png` is 2004×2014 and 5,030,105 bytes. It is **referenced by nothing** —
not by any HTML file, not by the CSS, not by the JS. The pages use
`nod-coin-176.png` (54 KB) and `nod-coin-64.png` (11 KB). It is dead weight in
every clone and it is publicly served at `negotiatorcruz.com/nod-coin.png`.

```bash
git rm nod-coin.png
```

Do not delete `nod-coin-176.png` or `nod-coin-64.png` — both are in active use.

> The source image survives in git history (`git show 3287a4b:nod-coin.png`), so
> this is recoverable if a large master is ever wanted again.

---

## T3 — The cross-promo ad ignores `prefers-reduced-motion`

**File: `index.html`** — inline `<style>` block, around line 172.

`assets/site.css` honours reduced-motion properly, and `assets/site.js` bails out
of all motion at line 66. But the MixMatch mini-ad was pasted in later as a
self-contained block with its own `<style>`, and it never got the same guard. It
runs two infinite CSS animations (`mm-ad-pulse` on the live dot,
`mm-ad-listen-glow` on the "Listen For" tab) plus a hover transform, regardless of
the user's setting. For a visitor with vestibular sensitivity this is the one
part of the page that keeps moving after they asked it to stop.

**Anchor** (end of the inline `<style>`):

```css
@media(max-width:560px){
  .mm-adbody{grid-template-columns:1fr;gap:6px}
  .mm-adtab{font-size:10px;padding:4px 8px}
}
</style>
```

**Replace with:**

```css
@media(max-width:560px){
  .mm-adbody{grid-template-columns:1fr;gap:6px}
  .mm-adtab{font-size:10px;padding:4px 8px}
}
/* This block is pasted into several sites, so it carries its own
   reduced-motion guard rather than relying on the host page's stylesheet. */
@media(prefers-reduced-motion:reduce){
  .mm-adlivedot,.mm-adtab.listen{animation:none}
  .mm-adframe,.mm-adbody{transition:none}
  .mm-adframe:hover{transform:none}
}
</style>
```

---

## T4 — The ad's scene rotator never stops

**File: `index.html`** — inline `<script>` block, around line 209.

`setInterval(..., 3600)` fires forever: on a background tab, after the ad has
scrolled out of view, and for users who asked for reduced motion. Each tick swaps
DOM and schedules a `setTimeout`. On a phone left open on the homepage this is a
small permanent battery draw for an animation nobody is looking at.

**Anchor:**

```js
    render('deck');
    var idx = 0;
    setInterval(function(){
      idx = (idx + 1) % order.length;
      var key = order[idx];
      tabs.forEach(function(t){ t.classList.toggle('on', t.getAttribute('data-scene') === key); });
      render(key);
    }, 3600);
```

**Replace with:**

```js
    render('deck');
    // Static for reduced-motion users: they still get the full first scene.
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    var idx = 0;
    setInterval(function(){
      // Skip the swap when nobody can see it — background tab, or scrolled past.
      if (document.hidden) return;
      var box = wrap.getBoundingClientRect();
      if (box.bottom < 0 || box.top > innerHeight) return;
      idx = (idx + 1) % order.length;
      var key = order[idx];
      tabs.forEach(function(t){ t.classList.toggle('on', t.getAttribute('data-scene') === key); });
      render(key);
    }, 3600);
```

`wrap` is already in scope — it is the `forEach` parameter on the enclosing
`document.querySelectorAll('.mm-adwrap').forEach(function(wrap){` line.

---

## T5 — Parallax layers freeze mid-transform past the cutoff

**File: `assets/site.js`** — two places, around lines 96 and 113.

Both scroll handlers do work only while `scrollY` is below a cutoff (600 for the
hero, 900 for the skyline). Past it they return without touching the transform,
so the layers keep whatever offset they had at the moment of the last update. On
a fast flick-scroll the handler can miss the frames near the boundary, and the
hero is left visibly displaced when you scroll back up.

Clamping the input instead of skipping the write costs the same and has no such
gap.

**Anchor 1** (hero):

```js
      requestAnimationFrame(function () {
        var y = scrollY;
        if (y < 600) heroPx.style.transform = 'translateY(' + y * 0.18 + 'px)';
        hTick = false;
      });
```

**Replace with:**

```js
      requestAnimationFrame(function () {
        // Clamp rather than skip: bailing out past the cutoff leaves the layer
        // stuck at whatever offset the last handled frame gave it.
        var y = Math.min(scrollY, 600);
        heroPx.style.transform = 'translateY(' + y * 0.18 + 'px)';
        hTick = false;
      });
```

**Anchor 2** (skyline):

```js
      requestAnimationFrame(function () {
        var y = scrollY;
        if (y < 900) {
          back.style.transform = 'translateY(' + y * 0.1 + 'px)';
          front.style.transform = 'translateY(' + y * 0.25 + 'px)';
        }
        tick = false;
      });
```

**Replace with:**

```js
      requestAnimationFrame(function () {
        var y = Math.min(scrollY, 900);
        back.style.transform = 'translateY(' + y * 0.1 + 'px)';
        front.style.transform = 'translateY(' + y * 0.25 + 'px)';
        tick = false;
      });
```

Also update the comment above the skyline block — it currently documents the
old behaviour. Change:

```js
  // back 0.10x, front 0.25x, rAF-throttled. Only runs while the hero is
  // plausibly on screen (scrollY < 900) to avoid pointless work.
```

to:

```js
  // back 0.10x, front 0.25x, rAF-throttled. Scroll offset is clamped at 900px,
  // past which the hero is off screen and the layers hold their end position.
```

---

# Batch 2 — Structured data and `<head>`

## T6 — `FAQPage` schema for contact.html

**File: `contact.html`** — the four `<details>` in the "Before You Write" section
produce no rich result because there is no schema describing them. This page also
carries no JSON-LD at all.

Insert immediately **before** the closing `</head>`:

```html
<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@type": "FAQPage",
  "url": "https://negotiatorcruz.com/contact",
  "mainEntity": [
    {
      "@type": "Question",
      "name": "How fast do you reply?",
      "acceptedAnswer": {
        "@type": "Answer",
        "text": "Usually within a day. I'm on TikTok Live two hours a day Monday to Saturday, so if it's urgent, the call booking is faster than the form."
      }
    },
    {
      "@type": "Question",
      "name": "Do you travel?",
      "acceptedAnswer": {
        "@type": "Answer",
        "text": "Yes — based in Chicago, travel billed at cost. Virtual sessions are available for the Negotiator Hour and keynotes; the intensives work far better in person because the roleplay rounds need a room."
      }
    },
    {
      "@type": "Question",
      "name": "Will you tell me not to book you?",
      "acceptedAnswer": {
        "@type": "Answer",
        "text": "Regularly. If your team hasn't opened the free app and your problem is motivation rather than method, a training day is the wrong purchase and I'd rather say so on a 15-minute call than after you've paid."
      }
    },
    {
      "@type": "Question",
      "name": "Can you do a pilot before we commit the whole team?",
      "acceptedAnswer": {
        "@type": "Answer",
        "text": "Yes. A common route is a Negotiator Hour with the sales lead first, then a one-day for the floor if it lands. Costs $500 to find out instead of $5,000."
      }
    }
  ]
}
</script>
```

---

## T7 — `FAQPage` schema for system.html

**File: `system.html`** — six `<details>` under "The questions I actually get
asked", no schema. Answer text below is the visible copy with `<em>` tags
stripped, which is what schema.org wants.

Insert immediately **before** the closing `</head>`:

```html
<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@type": "FAQPage",
  "url": "https://negotiatorcruz.com/system",
  "mainEntity": [
    {
      "@type": "Question",
      "name": "Is this just Chris Voss's material repackaged?",
      "acceptedAnswer": {
        "@type": "Answer",
        "text": "No, and I'd tell you if it were. The tools — labels, mirrors, calibrated questions, accusation audits — come from published FBI crisis-negotiation practice, and I don't pretend to have invented them. What I built is the sequencing, the drills, and the scoring: the order you run them in, how you rehearse each one, and how you measure whether a rep can actually do it under pressure."
      }
    },
    {
      "@type": "Question",
      "name": "My team already went to a big motivational event. Why do this too?",
      "acceptedAnswer": {
        "@type": "Answer",
        "text": "Those two things stack well. The event handles belief and energy. The Protocol handles the part where somebody has to open their mouth on a live call and say a specific sentence in a specific order. If your team came back fired up but can't tell you what they're doing differently in a negotiation, that's the gap this fills."
      }
    },
    {
      "@type": "Question",
      "name": "Does this work outside sales?",
      "acceptedAnswer": {
        "@type": "Answer",
        "text": "Yes — the mechanics are the same anywhere you need to move a person from where they are to where you need them. It's been run with real estate, insurance claims, construction, legal, call centers, procurement, and internal leadership teams. Mediators tend to pick it up fastest because Stage 1 is already how they think."
      }
    },
    {
      "@type": "Question",
      "name": "What if my people think roleplay is cringe?",
      "acceptedAnswer": {
        "@type": "Answer",
        "text": "Most of them do, for about the first twenty minutes. Then someone gets mirrored on their own objection and the room changes. We run your deals with your objections, which is a different thing than pretending to buy a stapler from a colleague."
      }
    },
    {
      "@type": "Question",
      "name": "Can you guarantee results?",
      "acceptedAnswer": {
        "@type": "Answer",
        "text": "I won't put a revenue number in writing — anyone who does is guessing at your pipeline. What I'll commit to is this: every attendee leaves able to execute all four stages on tape, with scripts written for your deals. If a training day ends and your team can't run the Protocol on camera, tell me and we'll fix it before I invoice the follow-up."
      }
    },
    {
      "@type": "Question",
      "name": "How big can the room be?",
      "acceptedAnswer": {
        "@type": "Answer",
        "text": "One-day intensives cap at 30. Multi-day immersives cap at 20, because individual coaching rounds with recordings don't scale past that. Keynotes have no cap — but a keynote is exposure to the method, not installation of it."
      }
    }
  ]
}
</script>
```

---

## T8 — Per-page structured data for about, speaking, academy

Only `index.html` currently carries JSON-LD. These three pages carry none, so the
`Person` and `Organization` entities defined on the homepage are never connected
to the pages that actually describe them. Each block below reuses the homepage
`@id` values (`#dan`, `#org`) so the graph resolves into one entity rather than
three unrelated ones.

Insert each immediately **before** the closing `</head>` of its file.

### `about.html`

```html
<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@type": "ProfilePage",
  "url": "https://negotiatorcruz.com/about",
  "mainEntity": {
    "@type": "Person",
    "@id": "https://negotiatorcruz.com/#dan",
    "name": "Dan Cruz",
    "jobTitle": "Negotiation Trainer & Speaker",
    "description": "Marine veteran, Chicago real estate, published author of a 33-chapter negotiation manual. Creator of The Cruz Protocol.",
    "image": "https://negotiatorcruz.com/nod-coin-176.png",
    "worksFor": { "@id": "https://negotiatorcruz.com/#org" },
    "knowsAbout": ["Negotiation", "Crisis negotiation", "Sales training", "Real estate negotiation"],
    "sameAs": [
      "https://www.tiktok.com/@negotiatorsondemand",
      "https://www.youtube.com/@Negotiators",
      "https://www.youtube.com/@NODNews",
      "https://negotiatorsondemand.com"
    ]
  }
}
</script>
```

### `speaking.html`

```html
<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@type": "Service",
  "name": "Negotiation Keynotes and Stage Programs",
  "url": "https://negotiatorcruz.com/speaking",
  "serviceType": "Keynote speaking",
  "description": "Keynote, half-day, and full-day stage programs in which a live negotiation is run on stage with a member of the audience.",
  "provider": { "@id": "https://negotiatorcruz.com/#org" },
  "areaServed": "US",
  "audience": {
    "@type": "BusinessAudience",
    "name": "Conferences, company kickoffs, and sales organisations"
  }
}
</script>
```

### `academy.html`

```html
<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@type": "ItemList",
  "name": "The NOD Academy — six rungs",
  "url": "https://negotiatorcruz.com/academy",
  "description": "Every way to learn The Cruz Protocol, in order, from the free practice app to the multi-day immersive.",
  "itemListOrder": "https://schema.org/ItemListOrderAscending",
  "numberOfItems": 6,
  "itemListElement": [
    { "@type": "ListItem", "position": 1, "name": "MixMatch practice app — free" },
    { "@type": "ListItem", "position": 2, "name": "NOD Training Manual — $10 Kindle / $50 print" },
    { "@type": "ListItem", "position": 3, "name": "Negotiator Hour — $500, private, virtual" },
    { "@type": "ListItem", "position": 4, "name": "Keynote or half-day workshop — fee on enquiry" },
    { "@type": "ListItem", "position": 5, "name": "One-Day Intensive — $5,000, up to 30 people" },
    { "@type": "ListItem", "position": 6, "name": "Multi-Day Immersive — $15,000–$20,000, up to 20 people" }
  ]
}
</script>
```

---

## T9 — Shared `<head>` additions across all six pages

Four small gaps, all fixable with the same two edits repeated on each of
`index.html`, `system.html`, `speaking.html`, `academy.html`, `about.html`,
`contact.html`. The anchor text is byte-identical in all six files.

1. **No `theme-color`.** The site is near-black; mobile browser chrome renders
   white against it.
2. **No `apple-touch-icon`.** Saved to an iOS home screen, the site gets a
   screenshot instead of the coin.
3. **No preconnect to Calendly.** Calendly is the destination of the primary CTA
   on every page; the TLS handshake currently starts only after the click.
4. **No `og:image:alt`.** Required for accessible link previews.

### Edit A — icons, theme colour, preconnect

**Anchor** (identical in all six files):

```html
<link rel="icon" href="/nod-coin-64.png">
<link rel="stylesheet" href="/assets/site.css">
```

**Replace with:**

```html
<meta name="theme-color" content="#08080f">
<link rel="icon" href="/nod-coin-64.png">
<link rel="apple-touch-icon" href="/nod-coin-176.png">
<link rel="preconnect" href="https://calendly.com">
<link rel="stylesheet" href="/assets/site.css">
```

> No `crossorigin` on that preconnect: the CTA is an ordinary navigation, not a
> CORS fetch, so the anonymous connection a `crossorigin` hint opens would sit
> unused alongside the one the click actually needs.

### Edit B — `og:image:alt`

**Anchor** (identical in all six files):

```html
<meta property="og:image:height" content="630">
```

**Replace with:**

```html
<meta property="og:image:height" content="630">
<meta property="og:image:alt" content="Negotiators Cruz — the NOD challenge coin on a dark gold-lit background">
```

---

# Batch 3 — Infra and polish

## T10 — Cache headers for static assets

**File: `vercel.json`**

The config sets four security headers and nothing about caching, so
`assets/site.css`, `assets/site.js` and the three PNGs are revalidated more often
than they need to be. Neither filename is content-hashed, so the CSS and JS get a
short cache with `must-revalidate`; the images are stable and can be cached hard.

**Anchor:**

```json
        {
          "key": "Permissions-Policy",
          "value": "camera=(), microphone=(), geolocation=()"
        }
      ]
    }
  ]
}
```

**Replace with:**

```json
        {
          "key": "Permissions-Policy",
          "value": "camera=(), microphone=(), geolocation=()"
        }
      ]
    },
    {
      "source": "/assets/(.*)",
      "headers": [
        {
          "key": "Cache-Control",
          "value": "public, max-age=0, s-maxage=86400, must-revalidate"
        }
      ]
    },
    {
      "source": "/(.*).(png|jpg|jpeg|svg|ico|webp)",
      "headers": [
        {
          "key": "Cache-Control",
          "value": "public, max-age=604800, s-maxage=2592000"
        }
      ]
    }
  ]
}
```

> `assets/*` filenames are not content-hashed, so they must revalidate — a long
> immutable cache there would strand visitors on a stale stylesheet after a
> deploy. The images are effectively immutable and get a week in the browser.

---

## T11 — Add a 404 page

There is no `404.html`, so a mistyped URL on the domain gets Vercel's generic
error page: no navigation, no branding, and no route back to the booking CTA.

Create `404.html` at the repo root. Copy the full `<head>`, `<nav>` and
`<footer>` blocks verbatim from `contact.html` — they are identical across every
page — and change only these three things in the head:

- `<title>Page not found — Negotiators Cruz</title>`
- `<meta name="description" content="That page doesn't exist. Here's the way back.">`
- Replace the `<link rel="canonical" ...>` line with `<meta name="robots" content="noindex">`

Drop the `aria-current="page"` attribute from the nav (no nav item is current on
this page), and drop the JSON-LD if you copied it.

Body content between `<main id="main">` and `</main>`:

```html
<div class="hero compact">
  <div class="kicker">404</div>
  <h1>That page <span class="acc">doesn't exist.</span></h1>
  <p class="tagline">Either it moved or the link was wrong. Both are fixable.</p>
  <div class="actions">
    <a href="/" class="cta">Back to the homepage →</a>
    <a href="/contact" class="cta ghost">Book a call instead</a>
  </div>
</div>

<section>
  <h2>Try These</h2>
  <h3>The five pages that matter</h3>
  <div class="grid g3">
    <a class="card" href="/system" style="text-decoration:none;display:block">
      <h4 style="color:var(--gold-2)">The Cruz Protocol →</h4>
      <p>Four stages, the drills behind each one, and the failure modes.</p>
    </a>
    <a class="card" href="/academy" style="text-decoration:none;display:block">
      <h4 style="color:var(--gold-2)">The Academy →</h4>
      <p>Six rungs, free app to multi-day immersive. Start at the bottom.</p>
    </a>
    <a class="card" href="/speaking" style="text-decoration:none;display:block">
      <h4 style="color:var(--gold-2)">Speaking →</h4>
      <p>Keynote and stage formats, with the negotiation run live.</p>
    </a>
    <a class="card" href="/about" style="text-decoration:none;display:block">
      <h4 style="color:var(--gold-2)">About Dan →</h4>
      <p>Marine, author, trainer — and why it's a system, not a speech.</p>
    </a>
    <a class="card" href="/contact" style="text-decoration:none;display:block">
      <h4 style="color:var(--gold-2)">Contact →</h4>
      <p>Fifteen minutes, no pitch, an honest read on whether this fits.</p>
    </a>
  </div>
</section>
```

Vercel serves a root `404.html` automatically for unmatched routes with
`cleanUrls` on — no config change needed. Do **not** add it to `sitemap.xml`.

---

## T12 — One industry tile is missing its icon

**File: `index.html`**, line 331.

The "Who It's For" grid has eight tiles. Seven lead with an emoji; "Real Estate"
does not, so the first item in the grid sits visually out of line with the other
seven. Real estate is the flagship vertical, which makes it the conspicuous one.

**Anchor:**

```html
    <div class="industry">Real Estate</div>
```

**Replace with:**

```html
    <div class="industry">🏠 Real Estate</div>
```

> Emoji in `.industry`, `.badge` and `.icon` is consistent site-wide — commit
> `61008d6` stripped it from CTAs only, which is a different component. Adding
> the icon matches the grid; it does not undo that decision.

---

# Done criteria

Run `./docs/agent-backlog/verify.sh`. All checks must print `PASS`.

T1 is expected to report `BLOCKED` until the owner answers it. That is correct
and is not a failure.
