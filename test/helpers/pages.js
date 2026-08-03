/**
 * Shared page loading for the static-integrity suites.
 *
 * The site has no build step, so "the HTML" is just the files on disk and
 * regex is an honest way to read them. These helpers exist so the individual
 * suites assert on behaviour rather than each re-deriving the file list.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const ORIGIN = 'https://negotiatorcruz.com';

/** Every top-level page, with the public route Vercel's cleanUrls serves it at. */
const PAGES = fs
  .readdirSync(ROOT)
  .filter((f) => f.endsWith('.html'))
  .sort()
  .map((file) => ({
    file,
    route: file === 'index.html' ? '/' : '/' + file.replace(/\.html$/, ''),
    get html() {
      return read(file);
    },
  }));

/** Does this page tell crawlers to stay away? */
function isNoindex(html) {
  const robots = /<meta[^>]+name\s*=\s*"robots"[^>]*content\s*=\s*"([^"]*)"/i.exec(html);
  return !!robots && /\bnoindex\b/i.test(robots[1]);
}

/**
 * The pages that are meant to be found.
 *
 * A noindex page is deliberately outside the index: it declares no canonical
 * and it stays out of sitemap.xml, so asserting either against it contradicts
 * the reason it is noindex in the first place. 404.html is the current case —
 * see backlog T11, which specifies `robots: noindex` *instead of* a canonical
 * and says explicitly not to add it to the sitemap.
 *
 * Derived from the markup rather than a filename list, so a future noindex
 * page gets the same treatment without anyone remembering to update this.
 * Everything that is simply page quality — a title, a description, alt text,
 * one <h1>, the Open Graph set — is still asserted against every page via
 * PAGES, because a 404 is a page a human reads too.
 */
const INDEXABLE_PAGES = PAGES.filter((p) => !isNoindex(p.html));

function read(file) {
  return fs.readFileSync(path.join(ROOT, file), 'utf8');
}

function exists(relative) {
  const p = path.resolve(ROOT, '.' + relative);
  return p.startsWith(ROOT) && fs.existsSync(p) && fs.statSync(p).isFile();
}

/** All values of an attribute across a document, e.g. attrs(html, 'href'). */
function attrs(html, name) {
  const out = [];
  const re = new RegExp(`${name}\\s*=\\s*"([^"]*)"`, 'gi');
  let m;
  while ((m = re.exec(html))) out.push(m[1]);
  return out;
}

/** Content of a <meta> tag by name= or property=. */
function meta(html, key) {
  const re = new RegExp(
    `<meta[^>]+(?:name|property)\\s*=\\s*"${key}"[^>]*content\\s*=\\s*"([^"]*)"`,
    'i'
  );
  const m = html.match(re);
  return m ? m[1] : null;
}

function title(html) {
  const m = html.match(/<title>([\s\S]*?)<\/title>/i);
  return m ? m[1].trim() : null;
}

function canonical(html) {
  const m = html.match(/<link[^>]+rel\s*=\s*"canonical"[^>]*href\s*=\s*"([^"]*)"/i);
  return m ? m[1] : null;
}

/** Strip <script>/<style> so link checks don't trip over JS string literals. */
function markupOnly(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '');
}

module.exports = {
  ROOT,
  ORIGIN,
  PAGES,
  INDEXABLE_PAGES,
  isNoindex,
  read,
  exists,
  attrs,
  meta,
  title,
  canonical,
  markupOnly,
};
