/**
 * Static integrity: links, assets, and the sitemap.
 *
 * These are the failures that actually happen on a hand-maintained static
 * site — a page gets renamed and three nav links quietly 404, or a new page
 * ships without a sitemap entry. Everything below passes today, which is the
 * point: it freezes a currently-correct site so a regression is loud.
 */

'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { ROOT, ORIGIN, PAGES, INDEXABLE_PAGES, read, exists, attrs, canonical, markupOnly } =
  require('./helpers/pages.js');
const { resolveFile } = require('./helpers/static-server.js');

// Canonicals and the sitemap describe what search engines should index, so
// they are asserted against the indexable set. 404.html is noindex by design
// (backlog T11) and belongs in neither.
const ROUTES = INDEXABLE_PAGES.map((p) => p.route);

describe('the page set', () => {
  test('every expected page is present', () => {
    assert.deepEqual(
      PAGES.map((p) => p.file),
      ['404.html', 'about.html', 'academy.html', 'contact.html', 'index.html',
       'speaking.html', 'system.html']
    );
  });

  test('404.html is the only page held out of the index', () => {
    // If a second page ever goes noindex, that should be a deliberate decision
    // someone makes here rather than something the sitemap quietly drops.
    assert.deepEqual(
      PAGES.filter((p) => !INDEXABLE_PAGES.includes(p)).map((p) => p.file),
      ['404.html']
    );
  });
});

describe('internal links', () => {
  for (const page of PAGES) {
    test(`${page.file} links only to routes that resolve`, () => {
      const html = markupOnly(page.html);
      const internal = attrs(html, 'href').filter((h) => h.startsWith('/'));

      assert.ok(internal.length > 0, 'expected at least the nav links');

      for (const href of internal) {
        assert.ok(
          resolveFile(href) !== null,
          `${page.file} links to ${href}, which resolves to nothing`
        );
      }
    });

    test(`${page.file} references only assets that exist`, () => {
      const html = markupOnly(page.html);
      const srcs = attrs(html, 'src').filter((s) => s.startsWith('/'));

      for (const src of srcs) {
        assert.ok(exists(src), `${page.file} references missing asset ${src}`);
      }
    });
  }

  test('no page links to a .html extension directly', () => {
    // cleanUrls means /about is the canonical form; /about.html would work but
    // splits the URL across two addresses for crawlers.
    for (const page of PAGES) {
      const internal = attrs(markupOnly(page.html), 'href').filter((h) => h.startsWith('/'));
      for (const href of internal) {
        assert.ok(
          !href.endsWith('.html'),
          `${page.file} links to ${href}; use the clean URL instead`
        );
      }
    }
  });

  test('every page is reachable from the home page nav or footer', () => {
    // ROUTES is the indexable set: nothing links to /404 on purpose — a
    // visitor arrives there by mistyping a URL, not by following a nav item.
    const home = markupOnly(read('index.html'));
    const linked = new Set(attrs(home, 'href').map((h) => h.split(/[?#]/)[0]));

    for (const route of ROUTES) {
      if (route === '/') continue;
      assert.ok(linked.has(route), `${route} is orphaned — nothing on the home page links to it`);
    }
  });

  test('external links are safe by construction', () => {
    for (const page of PAGES) {
      const html = markupOnly(page.html);
      const anchors = html.match(/<a\b[^>]*>/gi) || [];

      for (const a of anchors) {
        if (!/href\s*=\s*"https?:\/\//i.test(a)) continue;
        if (!/target\s*=\s*"_blank"/i.test(a)) continue;
        assert.ok(
          /rel\s*=\s*"[^"]*noopener/i.test(a),
          `${page.file} opens a new tab without rel="noopener": ${a}`
        );
      }
    }
  });
});

describe('canonical URLs', () => {
  for (const page of INDEXABLE_PAGES) {
    test(`${page.file} declares the canonical for ${page.route}`, () => {
      assert.equal(canonical(page.html), ORIGIN + (page.route === '/' ? '/' : page.route));
    });
  }

  test('no indexable page declares more than one canonical', () => {
    for (const page of INDEXABLE_PAGES) {
      const count = (page.html.match(/rel\s*=\s*"canonical"/gi) || []).length;
      assert.equal(count, 1, `${page.file} has ${count} canonical links`);
    }
  });

  test('a noindex page declares no canonical at all', () => {
    // The pair is the point: noindex plus a self-canonical is a contradictory
    // signal, telling crawlers both to skip the page and to treat it as the
    // preferred version of itself.
    for (const page of PAGES.filter((p) => !INDEXABLE_PAGES.includes(p))) {
      assert.equal(canonical(page.html), null,
        `${page.file} is noindex but still declares a canonical`);
    }
  });

  test('the canonical origin matches the domain robots.txt advertises', () => {
    // Was asserted against CNAME until b2d3c55 deleted it — that file is a
    // GitHub Pages artifact and the site deploys on Vercel, where the domain
    // lives in project settings rather than the repo. The test outlived the
    // file it read and had been failing ever since.
    //
    // robots.txt is the remaining in-repo declaration of the origin, and it is
    // one a crawler actually reads, so a domain change that forgets it is
    // worth failing over.
    const sitemapLine = /^\s*Sitemap:\s*(\S+)\s*$/im.exec(read('robots.txt'));
    assert.ok(sitemapLine, 'robots.txt should advertise the sitemap');
    assert.equal(new URL(sitemapLine[1]).origin, ORIGIN);
  });
});

describe('sitemap.xml', () => {
  const locs = (read('sitemap.xml').match(/<loc>([^<]+)<\/loc>/g) || []).map((l) =>
    l.replace(/<\/?loc>/g, '')
  );

  test('lists every page exactly once', () => {
    const expected = ROUTES.map((r) => ORIGIN + (r === '/' ? '/' : r)).sort();
    assert.deepEqual([...locs].sort(), expected);
  });

  test('has no duplicate entries', () => {
    assert.equal(new Set(locs).size, locs.length);
  });

  test('every entry matches the canonical the page declares', () => {
    for (const page of INDEXABLE_PAGES) {
      assert.ok(
        locs.includes(canonical(page.html)),
        `${page.file}'s canonical is not in the sitemap`
      );
    }
  });

  test('no noindex page appears in the sitemap', () => {
    for (const page of PAGES.filter((p) => !INDEXABLE_PAGES.includes(p))) {
      const url = ORIGIN + (page.route === '/' ? '/' : page.route);
      assert.ok(!locs.includes(url), `${page.file} is noindex but listed in the sitemap`);
    }
  });

  test('every lastmod is a valid ISO date', () => {
    const mods = (read('sitemap.xml').match(/<lastmod>([^<]+)<\/lastmod>/g) || []).map((m) =>
      m.replace(/<\/?lastmod>/g, '')
    );
    for (const d of mods) {
      assert.match(d, /^\d{4}-\d{2}-\d{2}/, `bad lastmod: ${d}`);
      assert.ok(!Number.isNaN(Date.parse(d)), `unparseable lastmod: ${d}`);
    }
  });
});

describe('assets on disk', () => {
  test('the shared stylesheet and script exist and are non-empty', () => {
    for (const f of ['assets/site.css', 'assets/site.js']) {
      const p = path.join(ROOT, f);
      assert.ok(fs.existsSync(p), `${f} is missing`);
      assert.ok(fs.statSync(p).size > 0, `${f} is empty`);
    }
  });

  test('the social card referenced by og:image exists', () => {
    for (const page of PAGES) {
      const og = page.html.match(/property\s*=\s*"og:image"[^>]*content\s*=\s*"([^"]*)"/i);
      assert.ok(og, `${page.file} has no og:image`);

      const url = og[1];
      assert.ok(url.startsWith(ORIGIN), `${page.file} og:image is not absolute: ${url}`);
      assert.ok(exists(url.slice(ORIGIN.length)), `og:image target missing: ${url}`);
    }
  });

  test('every url() in the stylesheet resolves', () => {
    const css = read('assets/site.css');
    const refs = [...css.matchAll(/url\(\s*['"]?([^'")]+)['"]?\s*\)/g)].map((m) => m[1]);

    for (const ref of refs) {
      if (/^(data:|https?:|\/\/)/.test(ref)) continue;
      const target = ref.startsWith('/') ? ref : '/assets/' + ref;
      assert.ok(exists(target), `site.css references missing ${ref}`);
    }
  });
});

describe('the ?offer= contract between pages and the contact form', () => {
  // /speaking and /academy deep-link into the form with a preselected offer.
  // If the <option> values drift, the prefill silently does nothing and the
  // lead arrives with no offer attached.
  const options = [
    ...read('contact.html').matchAll(/<option value="([^"]*)"/g),
  ].map((m) => m[1]);

  test('the offer select exposes the expected values', () => {
    assert.deepEqual(options, [
      '',
      'keynote',
      'half-day',
      'one-day',
      'multi-day',
      'negotiator-hour',
      'other',
    ]);
  });

  test('every ?offer= link on the site matches an option value', () => {
    let checked = 0;

    for (const page of PAGES) {
      const links = [...markupOnly(page.html).matchAll(/href="[^"]*\?offer=([^"&#]+)/g)];
      for (const [, value] of links) {
        checked++;
        assert.ok(
          options.includes(value),
          `${page.file} links to ?offer=${value}, which is not an option in contact.html`
        );
      }
    }

    assert.ok(checked > 0, 'expected the CTAs to deep-link into the form');
  });
});

describe('deployment hygiene', () => {
  test('api/ contains no test files', () => {
    // Vercel turns every .js file under api/ into a serverless function, so a
    // stray test file there would ship as a public endpoint.
    for (const f of fs.readdirSync(path.join(ROOT, 'api'))) {
      assert.ok(!/\.(test|spec)\./.test(f), `api/${f} would deploy as a function`);
    }
  });

  test('the lead function keeps its zero-dependency promise', () => {
    // The file header explains the constraint: no package.json at runtime and
    // no build step, so the function talks to PostgREST over bare fetch.
    const pkg = JSON.parse(read('package.json'));
    assert.deepEqual(pkg.dependencies ?? {}, {}, 'runtime dependencies would need a build step');

    const src = read('api/lead.js');
    const imports = [
      ...src.matchAll(/\brequire\(\s*['"]([^'"]+)['"]/g),
      ...src.matchAll(/\bfrom\s+['"]([^'"]+)['"]/g),
    ].map((m) => m[1]);

    for (const spec of imports) {
      assert.ok(
        spec.startsWith('.') || spec.startsWith('node:'),
        `api/lead.js pulls in "${spec}"; it must stay dependency-free`
      );
    }
  });
});
