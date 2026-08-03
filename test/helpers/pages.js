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

/** Every top-level HTML file, indexed or not. */
const ALL_PAGES = fs
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

/**
 * Every *indexed* page — the ones that are part of the public site.
 *
 * Pages carrying `robots: noindex` are deliberately excluded. The suites that
 * consume PAGES assert indexed-content invariants: a canonical link, an entry
 * in sitemap.xml, reachability from the home page nav, a full Open Graph set.
 * An error page satisfies none of those *by design* — it must not be in the
 * sitemap, nothing should link to it, and a canonical for /404 would be wrong.
 *
 * This is derived from the page's own robots meta rather than a hardcoded
 * filename list, so the next noindex page added is handled without touching
 * this file. 404.html was added without that exclusion existing, which is what
 * turned ten of these assertions red on main.
 */
const PAGES = ALL_PAGES.filter((p) => !/<meta\s+name=["']robots["'][^>]*noindex/i.test(p.html));

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
  ALL_PAGES,
  read,
  exists,
  attrs,
  meta,
  title,
  canonical,
  markupOnly,
};
