/**
 * Turn a folder of raw recordings into the pack the game loads.
 *
 *   node rocketman/tools/audio-pack.mjs --check     what is still unrecorded
 *   node rocketman/tools/audio-pack.mjs             build audio/out/
 *   node rocketman/tools/audio-pack.mjs --only weapon.autocannon
 *
 * ## What goes in
 *
 * One folder per cue, named exactly as the cue is named in `audio-cues.js`,
 * holding one file per take in any format ffmpeg reads:
 *
 *   rocketman/audio/raw/weapon.autocannon/01.wav
 *   rocketman/audio/raw/weapon.autocannon/02.wav
 *   rocketman/audio/raw/music.battle/siege-of-the-yard.wav
 *
 * Takes are ordered by filename, so name them in the order you would want to
 * hear them and the pack is reproducible. Nothing here reads file metadata,
 * modification times, or anything else that changes between two machines
 * holding the same recordings: the same folder must produce the same manifest
 * or the diff is noise and nobody reads it.
 *
 * ## What comes out
 *
 * `audio/out/` — Opus in WebM plus AAC in M4A for Safari before 17, and a
 * `manifest.json` the game fetches on boot. Two formats is not belt and braces;
 * Safari 16 is still live on iPads that will never update, and the fallback is
 * a fifth of the work of caring.
 *
 * ## What this tool refuses to do
 *
 * It does not touch the *character* of a recording. No EQ, no reverb, no
 * compression, no gates. Those are decisions made in a room with monitors, by
 * someone listening, and a build script that quietly reshapes a take is a
 * build script that will one day undo an hour of somebody's work without
 * saying so.
 *
 * What it does is the mechanical part, the part that must be identical across
 * two hundred files: trim the silence, normalise the level, resample, encode,
 * and measure. Everything it changes it records in the manifest, so any file
 * in the pack can be traced back to what was done to it.
 */

import { readdirSync, readFileSync, statSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { dirname, join, extname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  CUES,
  CUE_NAMES,
  MUSIC_STATES,
  LOUDNESS_CROSSOVER_SECONDS,
  PEAK_TARGET_DBFS,
  LUFS_TARGET,
  TRUE_PEAK_CEILING_DBTP,
  SAMPLE_RATE,
  groupOf,
} from '../web/audio-cues.js';

const here = dirname(fileURLToPath(import.meta.url));
const audioDir = join(here, '..', 'audio');
const rawDir = join(audioDir, 'raw');
const outDir = join(audioDir, 'out');

/** Anything ffmpeg will read. Everything else in a take folder is ignored. */
const SOURCE_EXTENSIONS = new Set(['.wav', '.aif', '.aiff', '.flac', '.mp3', '.m4a', '.ogg', '.opus']);

/**
 * Music cue folders are `music.<state>` and are packed differently from
 * effects: stereo, longer, loudness-normalised, and looked up by state rather
 * than by cue.
 */
const MUSIC_PREFIX = 'music.';

/* ================================================================== ffmpeg */

function ffmpegAvailable() {
  try {
    execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
    execFileSync('ffprobe', ['-version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function ffmpeg(args) {
  return execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
}

/** Probe one number out of a file, or null if ffprobe will not say. */
function probeDuration(file) {
  try {
    const out = execFileSync(
      'ffprobe',
      ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file],
      { encoding: 'utf8' }
    );
    const n = parseFloat(out.trim());
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

/**
 * Measure a file the way the normaliser will need it measured.
 *
 * `volumedetect` gives peak, `ebur128` gives integrated loudness. Both come
 * off one decode pass because decoding a folder of 24-bit 96k session files
 * twice is the difference between a pack that builds in a minute and one that
 * builds in three.
 */
function measure(file) {
  // `spawnSync` rather than `execFileSync`, because both numbers are written
  // to stderr on a *successful* run and execFileSync only ever hands back
  // stdout. Reaching them through the error path meant a second decode pass
  // whenever ffmpeg did its job properly, which was always.
  const run = spawnSync(
    'ffmpeg',
    ['-hide_banner', '-i', file, '-af', 'volumedetect,ebur128=peak=true', '-f', 'null', '-'],
    { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }
  );
  const stderr = String(run.stderr || '');
  const peak = /max_volume:\s*(-?\d+(?:\.\d+)?)\s*dB/.exec(stderr);
  // ebur128 prints a running summary and then a final one. The last `I:` is
  // the integrated figure for the whole file, which is the one that matters.
  const lufs = [...stderr.matchAll(/I:\s*(-?\d+(?:\.\d+)?)\s*LUFS/g)].pop();
  return {
    peakDb: peak ? parseFloat(peak[1]) : null,
    lufs: lufs ? parseFloat(lufs[1]) : null,
  };
}

/* ================================================================ the build */

/**
 * The filter chain for one take.
 *
 * Reads as a list because that is what it is, and because the order matters in
 * ways that are not obvious: trimming before measuring is what stops a take
 * with two seconds of room tone in front of it from measuring quiet and coming
 * out hot.
 *
 * @param {{durationSeconds: number, music: boolean, measured: {peakDb: number|null}}} ctx
 */
function filterChain({ durationSeconds, music, measured }) {
  const chain = [];

  if (!music) {
    // Lead-in silence, gone. A sound effect has to fire the instant the game
    // asks for it, and 80 ms of room tone in front of a gunshot is 80 ms of
    // latency that no amount of scheduling can win back.
    //
    // -50 dB rather than -60: studio libraries are often dithered or have a
    // low noise floor riding under the head, and -60 leaves that in.
    chain.push('silenceremove=start_periods=1:start_threshold=-50dB:start_silence=0');
    // The tail is trimmed too, but gently — the decay of a sound is the sound.
    chain.push('areverse,silenceremove=start_periods=1:start_threshold=-70dB:start_silence=0.05,areverse');
    // A two-millisecond fade at each end. Not audible, and it removes the
    // click that a trim at a non-zero crossing otherwise puts on the front of
    // every single take in the pack.
    chain.push('afade=t=in:st=0:d=0.002');
  }

  // World effects collapse to mono: they are panned by the game, and a stereo
  // source fed through a StereoPanner is two images fighting. Music and the
  // interface stay stereo, which is where the width belongs.
  chain.push(music ? 'aformat=channel_layouts=stereo' : null);

  // The level. Short things by peak, long things by loudness — see
  // LOUDNESS_CROSSOVER_SECONDS in audio-cues.js for why measuring a 45 ms
  // gunshot in LUFS is measuring the silence around it.
  if (music || durationSeconds >= LOUDNESS_CROSSOVER_SECONDS) {
    chain.push(
      `loudnorm=I=${music ? -16 : LUFS_TARGET}:TP=${TRUE_PEAK_CEILING_DBTP}:LRA=11`
    );
  } else if (measured.peakDb !== null) {
    chain.push(`volume=${(PEAK_TARGET_DBFS - measured.peakDb).toFixed(2)}dB`);
  }

  // A true-peak limiter after everything, because loudnorm's single pass
  // overshoots and an inter-sample peak over 0 dBFS is what turns a clean
  // recording into a crackle once it has been through a lossy encoder.
  chain.push(`alimiter=limit=${dbToLinear(TRUE_PEAK_CEILING_DBTP).toFixed(4)}`);

  return chain.filter(Boolean).join(',');
}

function dbToLinear(db) {
  return Math.pow(10, db / 20);
}

/** Encode one take into both formats. Returns the manifest entry. */
function packTake(cue, sourceFile, index, { music }) {
  const cueOut = join(outDir, cue);
  mkdirSync(cueOut, { recursive: true });

  const stem = String(index + 1).padStart(2, '0');
  const measured = measure(sourceFile);
  const durationSeconds = probeDuration(sourceFile) || 0;
  const chain = filterChain({ durationSeconds, music, measured });

  const channels = music ? '2' : '1';
  const webm = join(cueOut, `${stem}.webm`);
  const m4a = join(cueOut, `${stem}.m4a`);

  // Opus at 96k mono / 128k stereo is transparent for this material and about
  // a fifth the size of the WAV. Bitrate is not the place to economise on a
  // pack that is already going to be the largest thing the game ships.
  ffmpeg([
    '-i', sourceFile,
    '-af', chain,
    '-ac', channels,
    '-ar', String(SAMPLE_RATE),
    '-c:a', 'libopus',
    '-b:a', music ? '128k' : '96k',
    '-vbr', 'on',
    // Opus encodes music and speech with different psychoacoustic models and
    // gets both noticeably wrong if told the opposite. `audio` is right for
    // everything here including the acknowledgements, which are speech but
    // are heard as effects.
    '-application', 'audio',
    webm,
  ]);

  ffmpeg([
    '-i', sourceFile,
    '-af', chain,
    '-ac', channels,
    '-ar', String(SAMPLE_RATE),
    '-c:a', 'aac',
    '-b:a', music ? '160k' : '128k',
    m4a,
  ]);

  const finalDuration = probeDuration(webm) || 0;
  const finalMeasure = measure(webm);

  return {
    entry: {
      webm: `out/${cue}/${stem}.webm`,
      m4a: `out/${cue}/${stem}.m4a`,
    },
    report: {
      source: basename(sourceFile),
      seconds: Number(finalDuration.toFixed(3)),
      peakDb: finalMeasure.peakDb,
      lufs: finalMeasure.lufs,
      bytes: statSync(webm).size,
    },
  };
}

/* ================================================================ discovery */

/** cue name -> source files, sorted, for every folder that has any. */
function findTakes() {
  const found = new Map();
  if (!existsSync(rawDir)) return found;

  for (const name of readdirSync(rawDir).sort()) {
    const dir = join(rawDir, name);
    if (!statSync(dir).isDirectory()) continue;
    const files = readdirSync(dir)
      .filter((f) => SOURCE_EXTENSIONS.has(extname(f).toLowerCase()))
      .sort()
      .map((f) => join(dir, f));
    if (files.length) found.set(name, files);
  }
  return found;
}

/** Every cue name the game knows, plus the music states. */
function knownNames() {
  return new Set([...CUE_NAMES, ...Object.keys(MUSIC_STATES).map((s) => MUSIC_PREFIX + s)]);
}

/* ================================================================== report */

function coverage(found) {
  const known = knownNames();
  const rows = [];

  for (const cue of CUE_NAMES) {
    const takes = found.get(cue) || [];
    rows.push({
      cue,
      group: groupOf(cue),
      have: takes.length,
      want: CUES[cue].takes,
    });
  }
  for (const state of Object.keys(MUSIC_STATES)) {
    const cue = MUSIC_PREFIX + state;
    rows.push({ cue, group: 'music', have: (found.get(cue) || []).length, want: 1 });
  }

  const stray = [...found.keys()].filter((name) => !known.has(name));
  return { rows, stray };
}

function printCoverage(found) {
  const { rows, stray } = coverage(found);
  const byGroup = new Map();
  for (const row of rows) {
    if (!byGroup.has(row.group)) byGroup.set(row.group, []);
    byGroup.get(row.group).push(row);
  }

  let done = 0;
  let partial = 0;
  let missing = 0;

  for (const [group, groupRows] of byGroup) {
    const complete = groupRows.filter((r) => r.have >= r.want).length;
    console.log(`\n${group}  ${complete}/${groupRows.length} cues at full take count`);
    for (const row of groupRows) {
      const mark = row.have === 0 ? '·' : row.have >= row.want ? '✓' : '~';
      if (row.have === 0) missing++;
      else if (row.have >= row.want) done++;
      else partial++;
      // Only the incomplete ones are worth a line once a group is finished;
      // a wall of ticks is not a report, it is a thing you scroll past.
      if (row.have < row.want) {
        console.log(`  ${mark} ${row.cue.padEnd(28)} ${row.have}/${row.want}`);
      }
    }
    if (complete === groupRows.length) console.log('  all recorded');
  }

  console.log(`\n${done} complete, ${partial} partial, ${missing} not started`);
  if (stray.length) {
    console.log(`\nFolders that are not cues (ignored — check the spelling):`);
    for (const name of stray) console.log(`  ${name}`);
  }
  return { done, partial, missing, stray };
}

/* ==================================================================== main */

function main() {
  const args = process.argv.slice(2);
  const check = args.includes('--check');
  const onlyIndex = args.indexOf('--only');
  const only = onlyIndex >= 0 ? args[onlyIndex + 1] : null;

  const found = findTakes();

  if (!found.size) {
    console.log(`No recordings found under ${rawDir}`);
    console.log('One folder per cue, named exactly as the cue is. See audio/README.md.');
    printCoverage(found);
    return;
  }

  if (check) {
    printCoverage(found);
    return;
  }

  if (!ffmpegAvailable()) {
    console.error('ffmpeg and ffprobe are required to build the pack, and one of them is missing.');
    console.error('  macOS:  brew install ffmpeg');
    console.error('  Debian: sudo apt install ffmpeg');
    console.error('\nRun with --check to see coverage without building.');
    process.exitCode = 1;
    return;
  }

  const known = knownNames();
  const manifestPath = join(audioDir, 'manifest.json');

  // A clean rebuild, unless a single cue was asked for. Incremental by default
  // is tempting and wrong: the pack is the thing deployed, a stale file in it
  // is a sound the game plays that nothing in the repository explains, and the
  // whole build is a couple of minutes.
  //
  // `--only` is the deliberate exception — you have re-recorded one gun and do
  // not want to re-encode two hundred files to hear it. That means starting
  // from the manifest already on disk rather than from an empty one: building
  // a fresh manifest here would leave `out/` full of every other cue's audio
  // and the manifest listing exactly one, which is a pack that silently loses
  // everything you did not just rebuild.
  let manifest = { version: 1, formats: ['webm', 'm4a'], cues: {}, music: {} };
  if (only && existsSync(manifestPath)) {
    try {
      const existing = JSON.parse(readFileSync(manifestPath, 'utf8'));
      manifest = { ...manifest, ...existing, cues: existing.cues || {}, music: existing.music || {} };
    } catch {
      console.warn('manifest.json is unreadable; --only is rebuilding it from just this cue.');
    }
  }
  if (!only && existsSync(outDir)) rmSync(outDir, { recursive: true, force: true });

  const report = [];

  for (const [cue, files] of found) {
    if (!known.has(cue)) continue;
    if (only && cue !== only) continue;

    const music = cue.startsWith(MUSIC_PREFIX);
    const entries = [];
    process.stdout.write(`${cue} `);

    files.forEach((file, i) => {
      try {
        const { entry, report: row } = packTake(cue, file, i, { music });
        entries.push(entry);
        report.push({ cue, ...row });
        process.stdout.write('.');
      } catch (err) {
        process.stdout.write('!');
        report.push({ cue, source: basename(file), error: String(err.message || err).slice(0, 200) });
      }
    });
    process.stdout.write('\n');

    if (!entries.length) continue;
    if (music) {
      const state = cue.slice(MUSIC_PREFIX.length);
      manifest.music[state] = entries.map((e) => ({ file: e.webm, m4a: e.m4a }));
    } else {
      manifest.cues[cue] = { takes: entries };
    }
  }

  mkdirSync(outDir, { recursive: true });
  // Sorted keys, no timestamps: the manifest is committed, and a build that
  // reorders it on every run makes the diff useless.
  manifest.cues = Object.fromEntries(Object.entries(manifest.cues).sort(([a], [b]) => a.localeCompare(b)));
  manifest.music = Object.fromEntries(Object.entries(manifest.music).sort(([a], [b]) => a.localeCompare(b)));
  writeFileSync(join(audioDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');

  /* ------------------------------------------------------------ warnings -- */

  const problems = [];
  for (const row of report) {
    if (row.error) {
      problems.push(`${row.cue}/${row.source}: ${row.error}`);
      continue;
    }
    const spec = CUES[row.cue];
    if (!spec) continue;
    const [min, max] = spec.seconds;
    // Length is a warning and never a truncation. A take that runs long is
    // usually a take that is right and a spec that was guessed, and the person
    // who can tell the difference is the one who recorded it.
    if (row.seconds < min) {
      problems.push(`${row.cue}/${row.source}: ${row.seconds}s, shorter than the ${min}s this cue expects`);
    } else if (row.seconds > max) {
      problems.push(`${row.cue}/${row.source}: ${row.seconds}s, longer than the ${max}s this cue expects`);
    }
  }

  const bytes = report.reduce((n, r) => n + (r.bytes || 0), 0);
  console.log(`\n${report.filter((r) => !r.error).length} takes packed, ${(bytes / 1024 / 1024).toFixed(1)} MB`);
  console.log(`manifest: ${join(audioDir, 'manifest.json')}`);

  if (problems.length) {
    console.log(`\n${problems.length} thing${problems.length === 1 ? '' : 's'} to look at:`);
    for (const p of problems) console.log(`  ${p}`);
  }

  printCoverage(found);
}

main();
