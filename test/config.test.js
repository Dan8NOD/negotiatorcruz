/**
 * Deployment configuration.
 *
 * vercel.json is the only thing standing between this site and a set of
 * missing security headers, and `cleanUrls` is what makes every internal link
 * on the site resolve. Both are invisible locally, so they get tests.
 */

'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { ORIGIN, ROOT, read } = require('./helpers/pages.js');

const vercel = JSON.parse(read('vercel.json'));

describe('vercel.json', () => {
  test('is valid JSON against the published schema', () => {
    assert.equal(vercel.$schema, 'https://openapi.vercel.sh/vercel.json');
  });

  test('enables cleanUrls, which every internal link depends on', () => {
    // Links are written as /about, not /about.html. Turning this off would
    // 404 the entire nav.
    assert.equal(vercel.cleanUrls, true);
  });

  test('disables trailing slashes, matching the canonical URLs', () => {
    assert.equal(vercel.trailingSlash, false);
  });
});

describe('security headers', () => {
  const global = (vercel.headers || []).find((h) => h.source === '/:path*');

  test('a header rule covers every path', () => {
    assert.ok(global, 'no /:path* header block in vercel.json');
  });

  const expected = {
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'X-Frame-Options': 'SAMEORIGIN',
  };

  for (const [key, value] of Object.entries(expected)) {
    test(`sets ${key}`, () => {
      const found = global.headers.find((h) => h.key === key);
      assert.ok(found, `${key} is not set`);
      assert.equal(found.value, value);
    });
  }

  test('denies camera, microphone and geolocation', () => {
    const policy = global.headers.find((h) => h.key === 'Permissions-Policy');
    assert.ok(policy, 'Permissions-Policy is not set');

    for (const feature of ['camera', 'microphone', 'geolocation']) {
      assert.match(
        policy.value,
        new RegExp(`${feature}=\\(\\)`),
        `${feature} is not disabled`
      );
    }
  });
});

describe('robots.txt', () => {
  const robots = read('robots.txt');

  test('allows crawling of the site', () => {
    assert.match(robots, /User-agent:\s*\*/i);
    assert.match(robots, /Allow:\s*\//i);
  });

  test('keeps the lead endpoint out of the index', () => {
    assert.match(robots, /Disallow:\s*\/api\//i);
  });

  test('points at the sitemap on the canonical origin', () => {
    assert.match(robots, new RegExp(`Sitemap:\\s*${ORIGIN}/sitemap\\.xml`));
  });
});

describe('package.json', () => {
  const pkg = JSON.parse(read('package.json'));

  test('is private, so it can never be published to npm by accident', () => {
    assert.equal(pkg.private, true);
  });

  test('exposes the test entry points CI relies on', () => {
    for (const script of ['test', 'test:e2e', 'test:coverage']) {
      assert.ok(pkg.scripts[script], `missing "${script}" script`);
    }
  });

  test('pins a Node version that supports the built-in test runner', () => {
    assert.match(pkg.engines.node, />=\s*(2[0-9]|[3-9][0-9])/);
  });

  test('the test script runs every test file in the repo', () => {
    // practice-lab/test/pricing.test.js sat unexecuted after it was added:
    // the glob only covered the root test/ directory, so sixteen assertions
    // about live Stripe prices passed CI by never running. A test file that
    // nobody runs is worse than no test file — it reads as coverage.
    //
    // This walks the repo for test files and checks each one against the
    // directories the "test" script actually globs, so the next sub-project
    // added with its own tests fails here instead of going quietly dark.
    const globbed = [...pkg.scripts.test.matchAll(/"([^"]*)\*\*[^"]*"/g)].map((m) => m[1]);
    assert.ok(globbed.length > 0, 'could not parse any globs out of the test script');

    const found = [];
    (function walk(dir) {
      for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
        if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
        const rel = dir ? `${dir}/${entry.name}` : entry.name;
        if (entry.isDirectory()) walk(rel);
        else if (entry.name.endsWith('.test.js')) found.push(rel);
      }
    })('');

    assert.ok(found.length > 0, 'expected to find test files');

    const orphaned = found.filter((f) => !globbed.some((prefix) => f.startsWith(prefix)));
    assert.deepEqual(
      orphaned,
      [],
      `these test files are never executed by "npm test":\n  ${orphaned.join('\n  ')}`
    );
  });
});
