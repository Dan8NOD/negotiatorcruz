# Video Edit Automation — Final Cut Pro

## What this project is

A compiler that turns a vision-AI media index into Final Cut Pro timelines.
We are NOT building an editor. We generate `.fcpxml` files; FCP imports them
and a human finishes the cut.

Owner: Dan Cruz. Library is ~12TB of HD video, already sorted, labeled, and
categorized by a vision AI. That index exists as JSON/CSV files.

Workflow order:
1. **Slice-of-life family videos** (current) — external hard drive, mixed
   phone/camera footage, batch-built into one FCP project per day so a human
   can skim and trim each day's footage fast.
2. **NOD content** (next) — talking-head / course content; whisper-driven
   selects.

## Architecture

```
vision-AI index (JSON/CSV)
        |
        v
  shot selection logic          <- the actual product; where the value is
        |
        +-- whisper (word-level timestamps: silence cuts, filler removal, selects)
        +-- ffprobe (duration, fps, resolution, audio layout)
        |
        v
  FCPXML writer  (fcpxml_build.py)
        |
        v
  .fcpxml -> double-click -> timeline in Final Cut Pro
        |
  ffmpeg for proxies so we never thrash the 12TB
```

## Hard-won FCPXML constraints — do not relearn these

These were validated by building and inspecting real output. Respect them.

1. **Never use floats for time.** FCP requires every time value to be a
   rational that lands exactly on a frame boundary. Use `fractions.Fraction`
   end to end. Float math produces files FCP silently refuses, or imports
   one frame off.

2. **Do not let Fraction reduce serialized time strings.** `Fraction(100, 3000)`
   becomes `1/30` on construction. FCP's own exports write `100/3000s`. We keep
   canonical strings in a lookup table (`CANONICAL_STR`, `TIMEBASE`) and
   serialize over the timebase denominator: 4 seconds at 30fps is
   `12000/3000s`, not `4/1s`. Both parse, but matching FCP's convention
   eliminates a whole class of import mysteries.

3. **NTSC rates are 1001-based.** 23.976 = `1001/24000s`, 29.97 = `1001/30000s`,
   59.94 = `1001/60000s`. Probed rates get snapped to the nearest broadcast
   standard; anything more than 0.05fps off is treated as a genuine oddball
   (timelapse, screen capture) and used literally.

4. **The sequence format comes from the first clip** and FCP conforms
   everything else to it. Mixed-framerate libraries must be bucketed by format
   before building, or put the hero clip first.

5. **`offset` vs `start`.** On `<asset-clip>`: `offset` is the position on the
   timeline, `start` is the in-point inside the source media. Both must be
   frame-exact. Multiple `<asset-clip>` elements can reference one `<asset>` —
   that is the talking-head pattern (one long take, many selects).

6. **`src` must be a percent-encoded absolute `file://` URL.** Use
   `urllib.parse.quote`. Spaces and non-ASCII in filenames break import.

7. **Import is scriptable, export is not.** Apple offers no programmatic way to
   pull a timeline back out of FCP; that requires File > Export XML by hand.
   Design the pipeline one-way: code builds, FCP finishes. Do not architect
   anything that assumes a round trip.

8. **FCPXML version 1.11** targets FCP 10.6.6+ and imports cleanly into FCP 11.
   Only move to 1.13 if a specific feature requires it.

## Current state

`fcpxml_build.py` works and is validated. It takes a folder (scanned
recursively), a JSON manifest, or `--selftest` (synthesizes clips with ffmpeg,
needs no real media) and emits frame-accurate FCPXML. Verified against 30fps,
25fps, and 29.97 NTSC with fractional in/out points; every build runs a
frame-alignment verifier over the finished XML before writing.

Batch features for the slice-of-life drive:

- **Recursive scan** of a whole drive; skips hidden files and anything inside
  `.fcpbundle` / `.imovielibrary` bundles. `--min-dur` drops pocket clips.
- **SQLite probe cache** keyed on path + mtime + size (Next-up item 3, done).
  Re-runs never re-read untouched media. `--cache PATH` / `--no-cache`.
- **Chronological ordering** from container `creation_time` (converted to
  local time; falls back to file mtime; pre-1980 camera-clock garbage ignored).
- **`--group-by day|folder`** emits one FCP project per capture day or folder
  inside a single event — the skim-and-trim unit for family footage.
- **Mixed formats**: one `<format>` resource per unique (w, h, rate); each
  sequence uses the *dominant* format of its group, not just the first clip's.
- **Resilient batch runs**: unreadable files are skipped with a warning, never
  fatal.

Typical slice-of-life invocation:

```
python3 fcpxml_build.py --dir "/Volumes/Family Drive" --group-by day \
    --name "Slice of Life" --event "Slice of Life" --min-dur 1.0 \
    --out slice_of_life.fcpxml
```

Manifest format — this is the integration point for the vision index:

```json
[
  {"path": "/abs/path/a.mov", "in": 12.5, "out": 18.0, "name": "hook"},
  {"path": "/abs/path/b.mov"}
]
```

## Next up

1. Adapter from the real vision-AI index JSON/CSV -> manifest format.
2. Whisper integration for word-level timestamps; silence and filler-word cuts
   (needed when we move to NOD talking-head content).
3. ~~Media database (SQLite; key on path + mtime + size).~~ Done — ProbeCache.
4. Proxy generation with ffmpeg for anything the pipeline touches repeatedly.
5. Markers and keywords in the FCPXML so the vision labels survive into FCP.
6. `--group-by month` / `--group-by event` (gap-based clustering: a >N-hour
   gap in capture time starts a new project) for denser family archives.

## Conventions

- Python 3.12, standard library first. Justify every dependency.
- Never mutate or move source media. This library is irreplaceable.
- Any new time handling gets a frame-alignment assertion in tests.
- Test with `--selftest` before touching real footage.

## Prior art worth reading, not copying

Several Final Cut MCP servers exist (dreliq9/fcp-mcp, DareDev256/fcp-mcp-server)
covering FCPXML parse/write, AppleScript live control, and ffprobe analysis.
Useful reference for edge cases. Our differentiator is the selection logic over
an existing 12TB labeled index, not the XML plumbing.
