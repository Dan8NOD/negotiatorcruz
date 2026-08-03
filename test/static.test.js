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

const {
  ROOT, ORIGIN, PAGES, ERROR_PAGES, read, exists, attrs, meta, title, canonical, markupOnly,
} = require('./helpers/pages.js');
const { resolveFile } = require('./helpers/static-server.js');

const ROUTES = PAGES.map((p) => p.route);

describe('the page set', () => {
  test('every expected page is present', () => {
    assert.deepEqual(
      PAGES.map((p) => p.file),
      ['about.html', 'academy.html', 'contact.html', 'index.html', 'speaking.html', 'system.html']
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
  for (const page of PAGES) {
    test(`${page.file} declares the canonical for ${page.route}`, () => {
      assert.equal(canonical(page.html), ORIGIN + (page.route === '/' ? '/' : page.route));
    });
  }

  test('no page declares more than one canonical', () => {
    for (const page of PAGES) {
      const count = (page.html.match(/rel\s*=\s*"canonical"/gi) || []).length;
      assert.equal(count, 1, `${page.file} has ${count} canonical links`);
    }
  });

  test('every canonical, og:url and sitemap entry shares one origin', () => {
    // This used to read the domain out of CNAME. That file was a GitHub Pages
    // artifact and was removed once it was confirmed Vercel serves the domain,
    // so there is no longer a single file naming it. Cross-checking the three
    // places the origin actually appears is a stronger check anyway: a stray
    // http:// or a www. drift shows up here rather than passing silently.
    const urls = [
      ...PAGES.map((p) => canonical(p.html)),
      ...PAGES.map((p) => meta(p.html, 'og:url')),
      ...(read('sitemap.xml').match(/<loc>([^<]+)<\/loc>/g) || []).map((l) =>
        l.replace(/<\/?loc>/g, '')
      ),
    ].filter(Boolean);

    assert.ok(urls.length >= PAGES.length * 3, 'expected a canonical, og:url and sitemap entry per page');
    for (const url of urls) {
      assert.ok(url.startsWith(ORIGIN + '/'), `${url} does not start with ${ORIGIN}`);
    }
  });
});

describe('error documents', () => {
  for (const page of ERROR_PAGES) {
    test(`${page.file} is marked noindex`, () => {
      assert.match(meta(page.html, 'robots') || '', /noindex/);
    });

    test(`${page.file} declares no canonical`, () => {
      // A canonical on an error page tells search engines the URL they hit is
      // the authoritative version of something. It is not.
      assert.equal(canonical(page.html), null);
    });

    test(`${page.file} stays out of the sitemap`, () => {
      const locs = read('sitemap.xml');
      assert.ok(!locs.includes(page.route), `${page.route} should not be advertised`);
    });

    test(`${page.file} still carries a title and a usable description`, () => {
      assert.ok((title(page.html) || '').length > 10, 'error pages still get a real title');
      assert.ok(
        (meta(page.html, 'description') || '').length >= 50,
        'description should say what happened and where to go'
      );
    });

    test(`${page.file} offers a route back into the site`, () => {
      // The whole point of a custom 404: a dead end costs the visitor.
      const links = attrs(markupOnly(page.html), 'href').filter((h) => h.startsWith('/'));
      assert.ok(links.includes('/'), 'should link home');
      assert.ok(links.includes('/contact'), 'should offer the booking route');
    });
  }
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
    for (const page of PAGES) {
      assert.ok(
        locs.includes(canonical(page.html)),
        `${page.file}'s canonical is not in the sitemap`
      );
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
