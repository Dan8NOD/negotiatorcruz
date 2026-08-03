/**
 * Per-page metadata.
 *
 * The site's whole job is being found and being shared, so the social and
 * search tags are load-bearing. Every page carries a full set today; these
 * tests make sure a new page can't ship without one.
 *
 * The length bounds below are deliberately generous — they catch "someone
 * pasted a paragraph into the description", not "this is two characters over
 * what Google renders". See the note on truncation in TESTING.md.
 */

'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { ORIGIN, PAGES, read, meta, title, canonical } = require('./helpers/pages.js');

describe('document basics', () => {
  for (const page of PAGES) {
    describe(page.file, () => {
      test('declares a language', () => {
        assert.match(page.html, /<html[^>]+lang\s*=\s*"en"/i);
      });

      test('is responsive', () => {
        const viewport = meta(page.html, 'viewport');
        assert.ok(viewport, 'missing viewport meta');
        assert.match(viewport, /width=device-width/);
      });

      test('declares a charset', () => {
        assert.match(page.html, /<meta[^>]+charset\s*=\s*"utf-8"/i);
      });

      test('has a unique, sensibly sized title', () => {
        const t = title(page.html);
        assert.ok(t, 'missing <title>');
        assert.ok(t.length >= 10, `title is too short: ${t}`);
        assert.ok(t.length <= 100, `title is ${t.length} chars: ${t}`);
      });

      test('has a meta description', () => {
        const d = meta(page.html, 'description');
        assert.ok(d, 'missing meta description');
        assert.ok(d.length >= 50, `description is too short (${d.length})`);
        assert.ok(d.length <= 250, `description is ${d.length} chars`);
      });
    });
  }

  test('every page title is distinct', () => {
    const titles = PAGES.map((p) => title(p.html));
    assert.equal(new Set(titles).size, titles.length, 'two pages share a title');
  });

  test('every meta description is distinct', () => {
    const descriptions = PAGES.map((p) => meta(p.html, 'description'));
    assert.equal(new Set(descriptions).size, descriptions.length, 'two pages share a description');
  });
});

describe('Open Graph and Twitter cards', () => {
  for (const page of PAGES) {
    describe(page.file, () => {
      test('carries the full Open Graph set', () => {
        for (const key of ['og:type', 'og:site_name', 'og:title', 'og:description', 'og:url', 'og:image']) {
          const value = meta(page.html, key);
          assert.ok(value, `missing ${key}`);
          assert.ok(value.trim().length > 0, `${key} is empty`);
        }
      });

      test('og:url agrees with the canonical link', () => {
        assert.equal(meta(page.html, 'og:url'), canonical(page.html));
      });

      test('og:image is absolute and sized for the card', () => {
        assert.match(meta(page.html, 'og:image'), new RegExp(`^${ORIGIN}/`));
        assert.equal(meta(page.html, 'og:image:width'), '1200');
        assert.equal(meta(page.html, 'og:image:height'), '630');
      });

      test('uses a large Twitter summary card', () => {
        assert.equal(meta(page.html, 'twitter:card'), 'summary_large_image');
      });

      test('og:site_name is consistent across the site', () => {
        assert.equal(meta(page.html, 'og:site_name'), 'Negotiators Cruz');
      });
    });
  }
});

describe('structured data', () => {
  test('every JSON-LD block on the site parses', () => {
    let blocks = 0;

    for (const page of PAGES) {
      const scripts = [
        ...page.html.matchAll(
          /<script[^>]+type\s*=\s*"application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi
        ),
      ];

      for (const [, body] of scripts) {
        blocks++;
        let parsed;
        assert.doesNotThrow(() => {
          parsed = JSON.parse(body);
        }, `invalid JSON-LD in ${page.file}`);

        const roots = Array.isArray(parsed) ? parsed : [parsed];
        for (const root of roots) {
          assert.ok(root['@context'], `JSON-LD in ${page.file} has no @context`);

          // A root is either a single node or a @graph of them.
          const nodes = root['@graph'] || [root];
          assert.ok(nodes.length > 0, `empty @graph in ${page.file}`);

          for (const node of nodes) {
            assert.ok(node['@type'], `a JSON-LD node in ${page.file} has no @type`);
          }
        }
      }
    }

    assert.ok(blocks > 0, 'expected at least one structured-data block');
  });

  test('every internal @id reference resolves inside the graph', () => {
    // `worksFor`, `founder` and `provider` all point at "#org" / "#dan". A
    // typo there silently breaks the entity linking that the markup exists for.
    const block = read('index.html').match(
      /<script[^>]+type\s*=\s*"application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/i
    );
    assert.ok(block, 'index.html should carry the structured data');

    const graph = JSON.parse(block[1])['@graph'];
    const defined = new Set(graph.map((n) => n['@id']).filter(Boolean));

    const referenced = [];
    JSON.stringify(graph, (key, value) => {
      // A bare { "@id": ... } object is a reference, not a definition.
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        const keys = Object.keys(value);
        if (keys.length === 1 && keys[0] === '@id') referenced.push(value['@id']);
      }
      return value;
    });

    assert.ok(referenced.length > 0, 'expected the graph to cross-reference its nodes');
    for (const id of referenced) {
      assert.ok(defined.has(id), `@id ${id} is referenced but never defined`);
    }
  });

  test('the structured data points at the canonical origin', () => {
    const block = read('index.html').match(
      /<script[^>]+type\s*=\s*"application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/i
    );
    const urls = [...block[1].matchAll(/"(?:url|@id|logo|image)":\s*"(https?:\/\/[^"]+)"/g)]
      .map((m) => m[1])
      .filter((u) => u.includes('negotiatorcruz'));

    assert.ok(urls.length > 0);
    for (const url of urls) {
      assert.ok(url.startsWith(ORIGIN), `structured data uses a non-canonical origin: ${url}`);
    }
  });
});

describe('accessibility basics in markup', () => {
  for (const page of PAGES) {
    test(`${page.file} gives every image an alt attribute`, () => {
      const imgs = page.html.match(/<img\b[^>]*>/gi) || [];
      for (const img of imgs) {
        assert.match(img, /\balt\s*=/i, `image without alt in ${page.file}: ${img}`);
      }
    });

    test(`${page.file} has exactly one <h1>`, () => {
      const count = (page.html.match(/<h1\b/gi) || []).length;
      assert.equal(count, 1, `${page.file} has ${count} h1 elements`);
    });
  }
});
