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

/**
 * Error documents are not content pages, and the difference is not cosmetic:
 * they carry `noindex` and deliberately have no canonical, stay out of the
 * sitemap, and are unreachable from the nav. Running the per-page content
 * assertions against them fails on every one of those properties — for being
 * correct. They get their own suite instead; see ERROR_PAGES.
 */
const ERROR_FILES = new Set(['404.html']);

const asPage = (file) => ({
  file,
  route: file === 'index.html' ? '/' : '/' + file.replace(/\.html$/, ''),
  get html() {
    return read(file);
  },
});

const ALL_HTML = fs
  .readdirSync(ROOT)
  .filter((f) => f.endsWith('.html'))
  .sort();

/** Every indexable page, with the public route Vercel's cleanUrls serves it at. */
const PAGES = ALL_HTML.filter((f) => !ERROR_FILES.has(f)).map(asPage);

/** Error documents, held to their own rules. */
const ERROR_PAGES = ALL_HTML.filter((f) => ERROR_FILES.has(f)).map(asPage);

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
  ERROR_PAGES,
  read,
  exists,
  attrs,
  meta,
  title,
  canonical,
  markupOnly,
};
