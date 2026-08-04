/**
 * Build the whole game into one self-contained HTML file.
 *
 * The dev workflow stays what it is — open rocketman.html on any static
 * server, ES modules load raw, no build step. This exists for the *other*
 * distribution problem: handing the game to someone as a thing they can
 * open. One file, no server, no network requests, playable from a browser
 * tab, an email attachment, or a claude.ai artifact page.
 *
 * The page was already self-contained by design (inline CSS, data-URI icon);
 * the only external reference is the module script, so the build is: bundle
 * web/main.js into a single classic script with esbuild, and inline it where
 * the module tag was.
 *
 *   node rocketman/tools/build-single-file.mjs   →  rocketman/dist/rocketman.html
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const webDir = join(here, '..', 'web');
const outDir = join(here, '..', 'dist');

mkdirSync(outDir, { recursive: true });

// IIFE rather than ESM output, so the result runs from file:// too — module
// scripts are blocked by CORS on file://, and "double-click the file" is
// exactly the use case this build serves.
const js = execFileSync(
  'npx',
  ['esbuild', join(webDir, 'main.js'), '--bundle', '--format=iife', '--charset=utf8'],
  { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }
);

const html = readFileSync(join(webDir, 'rocketman.html'), 'utf8');
const tag = '<script type="module" src="./main.js"></script>';
if (!html.includes(tag)) {
  throw new Error('rocketman.html no longer contains the module script tag this build replaces');
}

// `</script>` inside a script element ends it no matter what the JS grammar
// says, so the bundle cannot be inlined verbatim if it ever contains that
// byte sequence. Splitting the literal is the standard escape.
const safe = js.replace(/<\/script/gi, '<\\/script');

const out = html.replace(tag, `<script>\n${safe}</script>`);
const outPath = join(outDir, 'rocketman.html');
writeFileSync(outPath, out);

console.log(`${outPath}  ${(out.length / 1024).toFixed(0)} KB`);
