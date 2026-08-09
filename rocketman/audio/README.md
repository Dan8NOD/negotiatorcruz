# Audio

Rocketman makes every sound it needs out of oscillators. That is not a
placeholder and it is not going away: it ships inside the single-file build, it
works with no network and no assets, and it is what plays on a browser that
will not decode Opus.

This directory is the layer in front of it — real recordings, which win
wherever they exist.

The two coexist by design. A cue with a recording plays the recording; a cue
without one plays its synthesised voice. So a session that captures six weapons
and none of the interface produces a game that sounds recorded where it is
recorded and synthesised where it is not, rather than a game with holes in it.
**You can stop at any point and ship what you have.**

---

## The short version

```bash
# 1. What is left to record
npm run rocketman:audio:check

# 2. Drop takes into folders named after cues
#    rocketman/audio/raw/weapon.autocannon/01.wav

# 3. Build the pack
npm run rocketman:audio

# 4. Play it
npm run serve   # then open rocketman/web/rocketman.html
```

The cue list, with what each sound has to communicate and how many takes it
wants, is **[CUE-SHEET.md](./CUE-SHEET.md)**. That is the document to work
from. It is generated from `web/audio-cues.js`, so it cannot drift from the
game.

---

## Layout

```
audio/
  raw/                    your recordings, one folder per cue   (git-ignored)
    weapon.autocannon/
      01.wav
      02.wav
    music.battle/
      siege-of-the-yard.wav
  out/                    what the pack tool produces           (git-ignored)
    weapon.autocannon/
      01.webm  01.m4a
  manifest.json           what the game fetches                 (committed)
  CUE-SHEET.md            generated from web/audio-cues.js      (committed)
```

`raw/` and `out/` are deliberately kept out of git. Session files are hundreds
of megabytes, they are binary, and a repository that has ever contained them
contains them forever. Keep `raw/` wherever your other session material lives
and treat this directory as a build input.

`manifest.json` **is** committed, because it is small, it is the record of what
the pack contains, and a deploy that ships `out/` without it is a deploy that
plays nothing while looking fine.

The copy in a fresh checkout is an **empty** pack — no cues, no music — and
that is deliberate rather than a leftover. The game asks for it on first sound,
and a file that is not there answers with a 404, which the browser writes to
the console *before any of this code runs*. Nothing in JavaScript can suppress
that. A game that logs an error on every boot is a game whose console is
worthless for finding the errors that matter, so the empty manifest exists to
answer the question honestly: the pack is a thing, and it currently holds
nothing. `npm run rocketman:audio` overwrites it.

---

## Recording into it

Everything about levels, formats, lengths and what each cue has to say is in
[CUE-SHEET.md](./CUE-SHEET.md). The short form:

- **One folder per cue, named exactly as the cue is named.** A misspelled
  folder is silently ignored — the pack tool lists them under "folders that are
  not cues", which is the first place to look when a recording does not show up.
- **Takes are ordered by filename.** Name them in the order you want them heard.
- **Hand it the best version you have.** WAV or AIFF, 24-bit, 48 kHz or higher,
  peaking somewhere near −6 dBFS with no clipping.
- **Do the creative processing, not the mechanical processing.** EQ, layering,
  pitch and reverb are yours. Trimming, level-matching, mono folding and
  encoding are the pack tool's, because those have to be identical across two
  hundred files and by hand they will not be.

### Studio libraries

A library file is usually a long stereo take with several usable hits in it and
room tone around them. Two things to do to it before it lands in `raw/`:

1. **Split it into one hit per file.** The pack trims silence from the head and
   tail of each file; it cannot find four gunshots inside one recording and does
   not try to guess.
2. **Cut the tail where you want the sound to end**, not where the file ends.
   The tail trim is deliberately gentle — at −70 dB — because the decay of a
   sound *is* the sound and a tool that guesses at that will eventually cut
   something that mattered.

Licensing is yours to keep track of. Nothing here records where a file came
from, and a commercial release wants that written down somewhere.

---

## Music

Six states: `menu`, `calm`, `battle`, `desperate`, `victory`, `defeat`. Drop
tracks into `raw/music.<state>/`. More than one per state is good — the game
picks between them, and one piece of music welded to one screen is the fastest
way to wear a score out.

The four looping beds form an intensity ladder. The game climbs it one step at
a time and immediately; it comes back down one step at a time and only after
eight seconds of quiet. So `calm` and `battle` are heard next to each other
constantly, in both directions — **write them in the same key and at the same
tempo** and the transitions stop being events.

### Suno

Two things worth knowing.

**Ask for stems.** A `calm` bed that is the `battle` bed with the drums and low
brass muted gives you two states that transition perfectly, because they are
one performance. That is most of how commercial adaptive scores are actually
built, and here it costs one export.

**Loops need help.** Generative tracks do not loop seamlessly. Either declare
the loop points in `manifest.json`:

```json
"music": {
  "calm": [
    { "file": "out/music.calm/01.webm", "loopStart": 8.42, "loopEnd": 136.61 }
  ]
}
```

— which gives you a sample-accurate loop *and* an intro that plays once, and is
the better option — or crossfade the seam in an editor before the file lands in
`raw/`, which works on anything but costs you the intro.

Pick loop points on a bar line, and pick `loopEnd` a bar before the track starts
winding down.

---

## Deploying

The pack is fetched from `../audio/` relative to the page — a sibling of
`web/`, exactly the shape it has in the repository — so deploying is copying
`rocketman/audio/` alongside `rocketman/web/` and nothing else. No build flag,
no code edit. A pack with no takes in it simply plays no recordings.

Serving `web/` on its own without `audio/` beside it is the one arrangement
that breaks, and it announces itself: `samples.manifest` reads `absent` rather
than `empty`.

**Android.** `npm run rocketman:android` copies the pack into the APK
automatically. A full pack will add tens of megabytes to the download; if that
matters more than the audio does, ship a subset — the synth covers whatever you
leave out.

**Single-file build.** `npm run rocketman:build` does *not* embed the pack, and
by default that build is the synthesised palette exactly as it always was. Pass
`--with-audio` to inline it as data URIs if you need one openable file with real
sound in it, and expect the result to be large: base64 adds a third on top of
whatever the pack already weighs.

---

## Checking it is actually working

The trap with a layered design like this one is that it fails *quietly*. If the
pack does not deploy, does not decode, or is served from the wrong path, the
game sounds fine — the synth covers for it — and nothing anywhere says so.

So the mixer counts what it plays:

```js
__rocketman().audio
// { context: 'running', scheduled: 412, dropped: 3,
//   samples: { manifest: 'loaded', cues: 47, decoded: 180, failed: 0, played: 96 },
//   music:   { state: 'battle', playing: true, cached: 2 } }
```

- `samples.manifest` — `empty` is a checkout with no recordings yet, which is
  fine. `absent` means the manifest itself did not load, and since an empty one
  is committed, that is a deploy that failed to copy `audio/` — the first thing
  to check when audio "did not change anything".
- `samples.failed` — takes that fetched but would not decode. Non-zero on one
  browser and zero on another is a format problem.
- `samples.played` at zero with `cues` non-zero means the pack loaded and
  nothing has triggered a cue from it yet.

---

## Reference

| Command | |
| --- | --- |
| `npm run rocketman:audio:check` | Coverage — what is recorded, partial, missing. Needs no ffmpeg. |
| `npm run rocketman:audio` | Build `out/` and `manifest.json`. Needs ffmpeg. |
| `npm run rocketman:audio -- --only weapon.autocannon` | Rebuild one cue, leaving the rest of the pack alone. |
| `npm run rocketman:audio:sheet` | Regenerate `CUE-SHEET.md` after editing the catalogue. |

ffmpeg: `brew install ffmpeg` or `sudo apt install ffmpeg`.

| File | |
| --- | --- |
| `web/audio-cues.js` | The catalogue. Cue names, take counts, lengths, **and the mix**. |
| `web/samples.js` | Loads and plays takes. Falls back silently. |
| `web/music.js` | The score, and the state machine that keeps it from flapping. |
| `web/sound.js` | The synthesised palette, and the `play()` funnel both layers meet in. |
| `tools/audio-pack.mjs` | ffmpeg pipeline. |
| `test/audio.test.js` | Proves the catalogue covers the game and nothing is orphaned. |

### Adding a cue

1. Add it to `CUES` in `web/audio-cues.js` with a `what` that says what the
   player is supposed to learn from hearing it.
2. Play it in `web/sound.js` via `play(name, at, () => …)`, where the third
   argument is the synthesised version. It is not optional, and the suite
   checks that.
3. `npm run rocketman:audio:sheet`.

The tests will tell you if you missed a step. That is what they are for: a cue
nothing plays and a weapon with no cue are both invisible at runtime and both
fail the suite.
