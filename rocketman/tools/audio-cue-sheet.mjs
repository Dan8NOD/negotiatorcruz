/**
 * Render the cue catalogue to the sheet you take into the room.
 *
 *   node rocketman/tools/audio-cue-sheet.mjs   →  rocketman/audio/CUE-SHEET.md
 *
 * Generated rather than written because a cue sheet that disagrees with the
 * game is worse than no cue sheet: you find out on the day you sit down to
 * record, having brought the wrong list. `audio-cues.js` is the truth, this is
 * a view of it, and `npm run rocketman:audio:sheet` reconciles the two.
 *
 * The test suite regenerates it and fails if the committed copy differs, which
 * is what stops the "I will update the doc later" failure mode from surviving
 * a commit.
 */

import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  CUES,
  CUE_NAMES,
  GROUPS,
  MUSIC_STATES,
  LOUDNESS_CROSSOVER_SECONDS,
  PEAK_TARGET_DBFS,
  LUFS_TARGET,
  TRUE_PEAK_CEILING_DBTP,
  SAMPLE_RATE,
  groupOf,
} from '../web/audio-cues.js';

const here = dirname(fileURLToPath(import.meta.url));

/** Where the sheet lives. Exported so the test can read the committed copy. */
export const CUE_SHEET_PATH = join(here, '..', 'audio', 'CUE-SHEET.md');

const GROUP_TITLES = {
  weapon: 'Weapons',
  impact: 'Impacts',
  ability: 'Abilities',
  world: 'World',
  ui: 'Interface',
  ack: 'Acknowledgements',
};

const GROUP_NOTES = {
  weapon:
    'One per weapon, and no two alike. The rule each of these follows: a weapon should be identifiable with the screen covered. Rate of fire already separates them — a repeater at six shots a second and a mortar at one every three could share a recording and still be told apart — so push the other way and separate them by *timbre*. That is what lets you tell an autocannon from a turret gun when both are firing off-screen at a third of a second.',
  impact:
    'What a warhead sounds like when it arrives. The counter triangle is the central decision in the game, so these four must be four unmistakably different arrivals — the player is reading which warhead hit them off the sound alone, mid-fight, without looking.',
  ability:
    'Two abilities are missing on purpose. `jumpjet` and `siege` already announce themselves through `world.leapStart` and `world.deployDown`, and recording them again would double every activation.',
  world:
    'Everything that happens at a place on the map and is not a gun. These pan and fade with distance.',
  ui: 'Centred, never dropped, never pitch-shifted. An interface sound that goes missing reads as an *order* that went missing and the player will click again — which is why these are protected from the voice ceiling that world sounds are subject to.',
  ack:
    'The crew answering an order. Half of why an RTS feels responsive is that the acknowledgement arrives before the unit has moved a pixel.\n\nThese are the one family where take count is about *people* rather than about repetition: six takes of `ack.move` should be six readings, ideally more than one voice, because the player hears them constantly and a crew that answers identically every time is one pilot in twenty cockpits. Record them dry and close; the game puts them on a radio.',
};

function seconds([min, max]) {
  return `${min}–${max}s`;
}

/** A negative number with a real minus sign, so the tables match the prose. */
function db(value) {
  return String(value).replace('-', '−');
}

function table(names) {
  const lines = [
    '| Cue | Takes | Length | What it has to say |',
    '| --- | ----: | ------ | ------------------ |',
  ];
  for (const name of names) {
    const spec = CUES[name];
    lines.push(`| \`${name}\` | ${spec.takes} | ${seconds(spec.seconds)} | ${spec.what} |`);
  }
  return lines.join('\n');
}

/** The whole document, as a string. Exported so the test can diff it. */
export function build() {
  const totalTakes = CUE_NAMES.reduce((n, c) => n + CUES[c].takes, 0);

  const out = [];
  out.push('# Rocketman — cue sheet');
  out.push('');
  out.push(
    '**Generated from `web/audio-cues.js` by `tools/audio-cue-sheet.mjs`. Do not edit by hand** — change the catalogue and regenerate, or the sheet and the game will disagree on the day you are holding a microphone.'
  );
  out.push('');
  out.push(
    `${CUE_NAMES.length} cues, ${totalTakes} takes if every one is recorded to its full count. Nothing here is required: any cue without a recording plays its synthesised voice instead, so this is a list you can work down in any order and ship at any point.`
  );
  out.push('');

  /* ------------------------------------------------------------ delivery -- */

  out.push('## What to deliver');
  out.push('');
  out.push('One folder per cue under `rocketman/audio/raw/`, named exactly as the cue is named, one file per take:');
  out.push('');
  out.push('```');
  out.push('rocketman/audio/raw/weapon.autocannon/01.wav');
  out.push('rocketman/audio/raw/weapon.autocannon/02.wav');
  out.push('rocketman/audio/raw/ack.move/01-cruz.wav');
  out.push('rocketman/audio/raw/music.battle/siege-of-the-yard.wav');
  out.push('```');
  out.push('');
  out.push('Takes are ordered by filename, so name them in the order you want them heard.');
  out.push('');
  out.push('| | |');
  out.push('| --- | --- |');
  out.push('| **Format in** | WAV or AIFF, 24-bit, 48 kHz or higher. FLAC is fine. Anything ffmpeg reads works, but do not hand the pack an MP3 you can hand it the original of. |');
  out.push('| **Level in** | Peak somewhere around −6 dBFS with no clipping anywhere. Exact level does not matter — the pack normalises — but headroom does, because a clipped source stays clipped. |');
  out.push('| **Processing in** | Whatever the sound needs. EQ, layering, pitch, reverb: all yours, all before it reaches the folder. |');
  out.push('| **Do not** | Compress or limit for loudness, add fades, or trim tight. The pack does the trim and the level, and it does them identically across two hundred files, which by hand you will not. |');
  out.push('| **Channels** | Record what you like. World effects are folded to mono because the game pans them itself, and a stereo source through a panner is two images fighting. Interface and music stay stereo. |');
  out.push('');

  /* ------------------------------------------------------------- the mix -- */

  out.push('## What the pack does to it');
  out.push('');
  out.push(
    'Only the mechanical part — the part that has to be identical across every file, and which is therefore exactly the part you should not be doing by hand at two in the morning:'
  );
  out.push('');
  out.push('1. **Trim** the lead-in silence at −50 dB, and the tail gently at −70 dB. A sound effect has to fire the instant the game asks for it; 80 ms of room tone in front of a gunshot is 80 ms of latency nothing downstream can win back.');
  out.push('2. **Fold** world effects to mono. Interface and music stay stereo.');
  out.push(
    `3. **Normalise.** Anything shorter than ${LOUDNESS_CROSSOVER_SECONDS}s is peak-normalised to ${db(PEAK_TARGET_DBFS)} dBFS; anything longer is loudness-normalised to ${db(LUFS_TARGET)} LUFS (music to −16). The split is there because integrated loudness is measured over 400 ms blocks — ask for the LUFS of a 45 ms gunshot and you get a number describing the silence around it.`
  );
  out.push(`4. **Limit** to ${db(TRUE_PEAK_CEILING_DBTP)} dBTP, after everything. Inter-sample peaks over 0 are what turn a clean recording into a crackle once a lossy encoder has been near it.`);
  out.push(`5. **Encode** to Opus in WebM and AAC in M4A at ${SAMPLE_RATE / 1000} kHz. Two formats because Safari before 17 will not play Opus and is still live on iPads that will never update.`);
  out.push('');
  out.push(
    '**Every take of every cue comes out at the same level.** That is deliberate and it is the most important thing on this page: the mix lives in the `gain` column of `web/audio-cues.js`, not in the files. A repeater firing six times a second has to sit under a mortar firing once every three seconds, whatever the two recordings happened to peak at — and that is a decision about the game, which belongs somewhere the tests can read it and somewhere you can change without re-exporting audio.'
  );
  out.push('');
  out.push('So: **do not try to balance the cues against each other while recording.** Get each one sounding right on its own. Balance is a slider, later, in a file.');
  out.push('');

  /* ---------------------------------------------------------------- cues -- */

  out.push('## The cues');
  out.push('');
  for (const group of GROUPS) {
    const names = CUE_NAMES.filter((n) => groupOf(n) === group);
    if (!names.length) continue;
    out.push(`### ${GROUP_TITLES[group] || group}`);
    out.push('');
    if (GROUP_NOTES[group]) {
      out.push(GROUP_NOTES[group]);
      out.push('');
    }
    out.push(table(names));
    out.push('');
  }

  /* --------------------------------------------------------------- music -- */

  out.push('## Music');
  out.push('');
  out.push(
    'Six states. A state is not a track: each folder can hold as many pieces as you like and the game picks between them, because the fastest way to wear a score out is to attach exactly one piece of music to the screen it plays on.'
  );
  out.push('');
  out.push('| State | Loops | What it scores |');
  out.push('| --- | --- | --- |');
  for (const [name, spec] of Object.entries(MUSIC_STATES)) {
    out.push(`| \`music.${name}\` | ${spec.loop ? 'yes' : 'plays once'} | ${spec.what} |`);
  }
  out.push('');
  out.push(
    'The four looping beds form an intensity ladder — `menu`, `calm`, `battle`, `desperate`. The game climbs it one step at a time and immediately, and comes back down one step at a time only after eight seconds of nothing happening. So `calm` and `battle` will be heard *next to each other*, repeatedly, in both directions: write them in the same key and at the same tempo and the transitions stop being events.'
  );
  out.push('');
  out.push('### Getting a loop out of a generative track');
  out.push('');
  out.push(
    'Suno will not hand you a seamless loop, and the beds have to loop for as long as a mission lasts. Two ways through it, in order of how well they work:'
  );
  out.push('');
  out.push(
    '1. **Find the loop points and declare them.** Pick a bar line a little way in and the matching bar line near the end, and put the two times in the manifest as `loopStart` and `loopEnd`. The game loops between them sample-accurately, and everything before `loopStart` becomes an intro that plays once. This is the good option: no crossfade, no drift, and the track gets to have an opening.'
  );
  out.push(
    '2. **Crossfade the seam.** Overlap the tail onto the head by a bar or two in an editor and export the result. Works on anything, costs you the intro, and a pad that swells through the seam will still audibly duck.'
  );
  out.push('');
  out.push(
    'Ask Suno for stems if it will give them: a `calm` bed that is the `battle` bed with the drums and the low brass muted is two states that transition perfectly, because they are the same performance. That trick is most of how commercial adaptive scores are built, and it is available here for the price of an export.'
  );
  out.push('');
  out.push('Keep the beds under about three minutes. They repeat for a whole mission and the loop is doing the work anyway.');
  out.push('');

  /* -------------------------------------------------------------- ending -- */

  out.push('## Order of work');
  out.push('');
  out.push(
    'If you want the pack to feel finished as early as possible rather than uniformly half-done, record in this order. It is roughly frequency of hearing:'
  );
  out.push('');
  out.push('1. `weapon.autocannon`, `weapon.turretgun`, `impact.kinetic`, `impact.explosive`, `world.explosion` — the sound of an ordinary firefight, and the five a player hears ten thousand times.');
  out.push('2. `ui.click`, `ui.deny`, `ack.select`, `ack.move`, `ack.attack` — everything the player triggers by hand. These are heard as *responsiveness*, not as audio.');
  out.push('3. `music.calm` and `music.battle` — the two beds that cover almost all of a mission.');
  out.push('4. The rest of the weapons, then the rest of the world.');
  out.push('5. `ui.victory`, `ui.defeat`, `music.victory`, `music.defeat` — heard once per mission, remembered for the whole campaign. Worth doing last and doing well.');
  out.push('');
  out.push('Check progress at any point with:');
  out.push('');
  out.push('```');
  out.push('npm run rocketman:audio:check');
  out.push('```');
  out.push('');

  return out.join('\n');
}

// Only when run as a script. The test imports `build` and compares it against
// the committed file, which it cannot do if importing the module rewrites the
// file first — that test would pass no matter what.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  writeFileSync(CUE_SHEET_PATH, build());
  console.log(`${CUE_SHEET_PATH}  ${CUE_NAMES.length} cues`);
}
