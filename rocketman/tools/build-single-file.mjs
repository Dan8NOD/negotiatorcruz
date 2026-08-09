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

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const webDir = join(here, '..', 'web');
const audioDir = join(here, '..', 'audio');
const outDir = join(here, '..', 'dist');

/**
 * Inline the recorded audio pack as data URIs.
 *
 * Off by default, and the default is the right one for almost every use of
 * this build: the synthesised palette is a complete game, weighs nothing, and
 * is what makes "one file you can email" work at all. A full pack is tens of
 * megabytes and base64 adds a third on top of that, which turns a 400 KB
 * attachment into something no mail server will take.
 *
 * `--with-audio` exists because the case where you *do* want it — handing
 * someone the finished thing, with the real sound, as one file that needs no
 * server — is a real case and there is otherwise no way to get there. Fetching
 * is not an option here: the file is opened over `file://`, where a request for
 * a sibling file is cross-origin and refused.
 */
const withAudio = process.argv.includes('--with-audio');

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

// Always emitted, even with no pack and even without `--with-audio`.
//
// This build's whole promise is one file that makes no network requests, and
// the sample bank's default is to fetch `../audio/manifest.json`. Over
// `file://` that fetch is cross-origin, and the browser writes a CORS error to
// the console before any code here can catch it — so the fix is not to let the
// fetch happen. An empty inlined pack means the bank finds nothing, reports
// nothing, and the game is the synthesised palette exactly as intended.
const audio = (withAudio ? inlineAudio() : null) || emptyAudio();
const out = html.replace(tag, `${audio}<script>\n${safe}</script>`);
const outPath = join(outDir, 'rocketman.html');
writeFileSync(outPath, out);

console.log(`${outPath}  ${(out.length / 1024).toFixed(0)} KB`);

/**
 * The pack, as one global the sample bank reads instead of fetching.
 *
 * Only the WebM is inlined, not the M4A fallback. Carrying both would nearly
 * double an already enormous file to serve a browser that will not open a
 * `file://` HTML page with an inline module anyway — and if the WebM will not
 * decode, the synth is right there.
 */
function emptyAudio() {
  return '<script>window.__ROCKETMAN_AUDIO__={"version":1,"formats":[],"cues":{},"music":{}};</script>\n';
}

function inlineAudio() {
  const manifestPath = join(audioDir, 'manifest.json');
  if (!existsSync(manifestPath)) {
    console.warn('--with-audio: no audio/manifest.json — building the synthesised palette instead.');
    console.warn('Run `npm run rocketman:audio` first. See rocketman/audio/README.md.');
    return null;
  }

  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  let missing = 0;
  let bytes = 0;

  const embed = (file) => {
    const path = join(audioDir, file);
    if (!existsSync(path)) {
      missing++;
      return null;
    }
    const data = readFileSync(path);
    bytes += data.length;
    return `data:audio/webm;base64,${data.toString('base64')}`;
  };

  const cues = {};
  for (const [cue, entry] of Object.entries(manifest.cues || {})) {
    const takes = (entry.takes || []).map((t) => embed(t.webm)).filter(Boolean);
    if (takes.length) cues[cue] = { takes: takes.map((webm) => ({ webm })) };
  }

  const music = {};
  for (const [state, tracks] of Object.entries(manifest.music || {})) {
    const list = tracks
      .map((t) => {
        const file = embed(t.file);
        return file ? { ...t, file, m4a: undefined } : null;
      })
      .filter(Boolean);
    if (list.length) music[state] = list;
  }

  const inlined = { version: manifest.version, formats: ['webm'], cues, music };
  // `<` cannot appear raw inside a script element. Base64 contains none, but
  // the JSON structure around it is generated and this is one line.
  const json = JSON.stringify(inlined).replace(/</g, '\\u003c');

  console.log(
    `--with-audio: ${Object.keys(cues).length} cues, ${Object.keys(music).length} music states, ` +
      `${(bytes / 1024 / 1024).toFixed(1)} MB before base64`
  );
  if (missing) console.warn(`--with-audio: ${missing} file(s) in the manifest are not on disk — rebuild the pack.`);

  return `<script>window.__ROCKETMAN_AUDIO__=${json};</script>\n`;
}
