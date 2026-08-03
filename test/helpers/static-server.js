/**
 * Zero-dependency static server used by the Playwright suite.
 *
 * It exists to approximate how Vercel actually serves this repo, because the
 * routing rules are load-bearing for the tests: `cleanUrls` is what makes
 * every internal link (`/about`, `/contact`) resolve to `about.html` and
 * `contact.html`. Serving the directory naively would 404 on every nav link
 * and the e2e suite would be testing a site that doesn't exist in production.
 *
 * The response headers are read out of vercel.json rather than hardcoded, so
 * local runs carry the same security headers the deployed site does.
 */

'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.xml': 'application/xml; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};

/** Pull the global header block out of vercel.json (source "/:path*"). */
function vercelHeaders() {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'vercel.json'), 'utf8'));
    const global = (cfg.headers || []).find((h) => h.source === '/:path*');
    const out = {};
    for (const { key, value } of global ? global.headers : []) out[key] = value;
    return out;
  } catch {
    return {};
  }
}

/**
 * Resolve a request path the way Vercel's `cleanUrls` does.
 * Returns an absolute file path, or null if nothing matches.
 */
function resolveFile(urlPath) {
  const decoded = decodeURIComponent(urlPath.split('?')[0]);

  // Refuse anything that escapes the project root before touching the disk.
  const candidate = path.resolve(ROOT, '.' + decoded);
  if (candidate !== ROOT && !candidate.startsWith(ROOT + path.sep)) return null;

  if (decoded === '/') return path.join(ROOT, 'index.html');

  // Exact file (assets, images, robots.txt, ...).
  if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;

  // cleanUrls: /contact -> contact.html
  const asHtml = candidate + '.html';
  if (fs.existsSync(asHtml) && fs.statSync(asHtml).isFile()) return asHtml;

  return null;
}

function createServer() {
  const headers = vercelHeaders();

  return http.createServer((req, res) => {
    const file = resolveFile(req.url || '/');

    if (!file) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', ...headers });
      res.end('Not found');
      return;
    }

    const body = fs.readFileSync(file);
    res.writeHead(200, {
      'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream',
      'Content-Length': body.length,
      ...headers,
    });
    res.end(body);
  });
}

/** Start on `port` (0 = pick a free one). Resolves with { server, url, port }. */
function start(port = 0) {
  return new Promise((resolve) => {
    const server = createServer();
    server.listen(port, '127.0.0.1', () => {
      const actual = server.address().port;
      resolve({ server, port: actual, url: `http://127.0.0.1:${actual}` });
    });
  });
}

module.exports = { createServer, start, resolveFile, ROOT };

// `npm run serve` / Playwright's webServer entrypoint.
if (require.main === module) {
  const port = Number(process.env.PORT) || 4321;
  start(port).then(({ url }) => console.log(`serving ${ROOT} at ${url}`));
}
