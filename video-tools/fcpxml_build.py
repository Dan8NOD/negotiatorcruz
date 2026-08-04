#!/usr/bin/env python3
"""
fcpxml_build.py — turn folders of video into Final Cut Pro timelines.

Batch-friendly: point it at an external drive of family footage and it will
recursively scan, probe (with a cache so the drive is only read once),
sort chronologically, and emit one FCP project per day/folder if asked.

Usage:
    # self-test: generates synthetic clips with ffmpeg, then builds + verifies
    python3 fcpxml_build.py --selftest

    # whole external drive of family footage, one project per day
    python3 fcpxml_build.py --dir "/Volumes/Family Drive/Slice of Life" \
        --group-by day --name "Slice of Life" --event "Slice of Life" \
        --out slice_of_life.fcpxml

    # one folder, single timeline (original behaviour)
    python3 fcpxml_build.py --dir ~/Movies/Raw --out rough.fcpxml --name "Test Cut"

    # from a manifest (this is the hook for the vision-AI index)
    python3 fcpxml_build.py --manifest shots.json --out rough.fcpxml

Manifest format (JSON list). 'in'/'out' are seconds, optional:
    [
      {"path": "/abs/path/a.mov", "in": 12.5, "out": 18.0, "name": "hook"},
      {"path": "/abs/path/b.mov"}
    ]

Probe results are cached in a SQLite file (default: probe_cache.sqlite next
to the output) keyed on path + mtime + size, so re-runs never re-read media
that hasn't changed. Source media is never modified.
"""

import argparse
import datetime
import json
import sqlite3
import subprocess
import sys
import urllib.parse
from fractions import Fraction
from pathlib import Path
from xml.etree import ElementTree as ET

FCPXML_VERSION = "1.11"  # FCP 10.6.6+; imports cleanly into FCP 11

# Phones, camcorders, and cameras that show up in a family archive.
VIDEO_EXTS = {".mov", ".mp4", ".m4v", ".mxf", ".avi", ".mts", ".m2ts", ".3gp", ".mpg", ".mpeg"}


# --------------------------------------------------------------------------
# Frame math. This is where nearly every FCPXML generator goes wrong.
# FCP requires every time value to be a rational number that lands exactly
# on a frame boundary. Floats will silently produce clips FCP refuses to
# import, or worse, imports one frame off. We use Fraction end to end.
# --------------------------------------------------------------------------

# Canonical frame durations FCP recognises, keyed by nominal fps.
# Fraction() reduces on construction, so the FCP-canonical *string* is stored
# alongside it — 30fps must serialise as 100/3000s, not 1/30s.
KNOWN_RATES = {
    Fraction(24000, 1001): (Fraction(1001, 24000), "1001/24000s"),   # 23.976
    Fraction(24, 1):       (Fraction(100, 2400),   "100/2400s"),
    Fraction(25, 1):       (Fraction(100, 2500),   "100/2500s"),
    Fraction(30000, 1001): (Fraction(1001, 30000), "1001/30000s"),   # 29.97
    Fraction(30, 1):       (Fraction(100, 3000),   "100/3000s"),
    Fraction(50, 1):       (Fraction(100, 5000),   "100/5000s"),
    Fraction(60000, 1001): (Fraction(1001, 60000), "1001/60000s"),   # 59.94
    Fraction(60, 1):       (Fraction(100, 6000),   "100/6000s"),
}
CANONICAL_STR = {frac: text for frac, text in KNOWN_RATES.values()}
# Denominator FCP uses for time values at each frame duration.
TIMEBASE = {frac: int(text.rstrip("s").split("/")[1]) for frac, text in KNOWN_RATES.values()}


def normalise_rate(rate: Fraction) -> Fraction:
    """Snap a probed frame rate to the nearest broadcast-standard rate."""
    best = min(KNOWN_RATES, key=lambda r: abs(float(r) - float(rate)))
    if abs(float(best) - float(rate)) > 0.05:
        # Unusual rate (timelapse, screen capture). Use it literally.
        return Fraction(1, 1) / rate
    return KNOWN_RATES[best][0]


def to_rational(seconds: Fraction, frame_dur: Fraction) -> str:
    """Convert seconds to an FCPXML time string snapped to a frame boundary.

    Deliberately does NOT reduce the fraction. FCP writes times over the
    timebase denominator (e.g. 300300/30000s, not 1001/100s) and staying in
    that form keeps our output byte-comparable to FCP's own exports.
    """
    frames = round(Fraction(seconds) / frame_dur)
    if frames == 0:
        return "0s"
    base = TIMEBASE.get(frame_dur, frame_dur.denominator)
    per_frame = frame_dur.numerator * (base // frame_dur.denominator)
    return f"{frames * per_frame}/{base}s"


def parse_rational(text: str) -> Fraction:
    """Inverse of to_rational, for verification."""
    text = text.rstrip("s")
    if "/" in text:
        num, den = text.split("/")
        return Fraction(int(num), int(den))
    return Fraction(int(text))


def frame_dur_str(frame_dur: Fraction) -> str:
    """FCP writes 100/3000s for 30fps, not 1/30s. Restore the canonical form."""
    return CANONICAL_STR.get(frame_dur, f"{frame_dur.numerator}/{frame_dur.denominator}s")


def file_url(path: Path) -> str:
    """FCP needs a percent-encoded absolute file:// URL."""
    return "file://" + urllib.parse.quote(str(path.resolve()))


# --------------------------------------------------------------------------
# Probing, with a cache so a 12TB drive is only ever read once
# --------------------------------------------------------------------------

def probe(path: Path) -> dict:
    """Pull the handful of fields FCPXML actually needs out of a media file."""
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-print_format", "json",
         "-show_streams", "-show_format", str(path)],
        capture_output=True, text=True, check=True,
    )
    data = json.loads(out.stdout)

    video = next((s for s in data["streams"] if s["codec_type"] == "video"), None)
    audio = next((s for s in data["streams"] if s["codec_type"] == "audio"), None)
    if video is None:
        raise ValueError(f"No video stream in {path}")

    num, den = video["r_frame_rate"].split("/")
    rate = Fraction(int(num), int(den))
    frame_dur = normalise_rate(rate)

    duration = Fraction(data["format"]["duration"]).limit_denominator(1_000_000)

    return {
        "path": path,
        "width": int(video["width"]),
        "height": int(video["height"]),
        "frame_dur": frame_dur,
        "duration": duration,
        "has_audio": audio is not None,
        "audio_channels": int(audio["channels"]) if audio else 0,
        "audio_rate": int(audio["sample_rate"]) if audio else 48000,
        "created": capture_time(data, path),
    }


def capture_time(probe_data: dict, path: Path) -> str:
    """Best-effort capture timestamp as local-time ISO string.

    Phones and cameras write creation_time into the container (usually UTC);
    fall back to file mtime when it's absent. Used for chronological sort
    and --group-by day.
    """
    tags = probe_data.get("format", {}).get("tags", {})
    raw = tags.get("creation_time") or tags.get("com.apple.quicktime.creationdate")
    if raw:
        try:
            dt = datetime.datetime.fromisoformat(raw.replace("Z", "+00:00"))
            if dt.tzinfo is not None:
                dt = dt.astimezone()
            # Cameras that lost their clock write epoch-ish dates; ignore those.
            if dt.year > 1980:
                return dt.replace(tzinfo=None).isoformat(timespec="seconds")
        except ValueError:
            pass
    mtime = datetime.datetime.fromtimestamp(path.stat().st_mtime)
    return mtime.isoformat(timespec="seconds")


def _to_jsonable(info: dict) -> str:
    d = dict(info)
    d["path"] = str(info["path"])
    d["frame_dur"] = f"{info['frame_dur'].numerator}/{info['frame_dur'].denominator}"
    d["duration"] = f"{info['duration'].numerator}/{info['duration'].denominator}"
    return json.dumps(d)


def _from_jsonable(text: str) -> dict:
    d = json.loads(text)
    d["path"] = Path(d["path"])
    n, den = d["frame_dur"].split("/")
    d["frame_dur"] = Fraction(int(n), int(den))
    n, den = d["duration"].split("/")
    d["duration"] = Fraction(int(n), int(den))
    return d


class ProbeCache:
    """SQLite cache of probe results, keyed on path + mtime + size.

    A moved or re-encoded file misses the cache and gets re-probed; an
    untouched file on the 12TB drive is never read twice.
    """

    def __init__(self, db_path: Path):
        self.conn = sqlite3.connect(db_path)
        self.conn.execute(
            "CREATE TABLE IF NOT EXISTS probes ("
            " path TEXT NOT NULL, mtime_ns INTEGER NOT NULL, size INTEGER NOT NULL,"
            " data TEXT NOT NULL, PRIMARY KEY (path, mtime_ns, size))"
        )
        self.hits = 0
        self.misses = 0

    def _key(self, path: Path):
        st = path.stat()
        return (str(path.resolve()), st.st_mtime_ns, st.st_size)

    def probe(self, path: Path) -> dict:
        key = self._key(path)
        row = self.conn.execute(
            "SELECT data FROM probes WHERE path=? AND mtime_ns=? AND size=?", key
        ).fetchone()
        if row:
            self.hits += 1
            return _from_jsonable(row[0])
        self.misses += 1
        info = probe(path)
        self.conn.execute(
            "INSERT OR REPLACE INTO probes (path, mtime_ns, size, data) VALUES (?,?,?,?)",
            (*key, _to_jsonable(info)),
        )
        self.conn.commit()
        return info

    def close(self):
        self.conn.close()


def format_name(w: int, h: int, frame_dur: Fraction) -> str:
    fps = float(1 / frame_dur)
    tag = f"{fps:.2f}".rstrip("0").rstrip(".").replace(".", "")
    return f"FFVideoFormat{h}p{tag}"


# --------------------------------------------------------------------------
# Grouping — a family archive becomes one FCP project per day or folder
# --------------------------------------------------------------------------

def group_clips(clips: list[dict], mode: str) -> list[tuple[str | None, list[dict]]]:
    """Split clips into (group_name, clips) buckets, chronological within each.

    'none'   -> one project, clips in chronological order
    'day'    -> one project per capture day (YYYY-MM-DD)
    'folder' -> one project per parent folder name
    """
    ordered = sorted(clips, key=lambda c: (c.get("created") or "", str(c["path"])))
    if mode == "none":
        return [(None, ordered)]

    groups: dict[str, list[dict]] = {}
    for c in ordered:
        if mode == "day":
            key = (c.get("created") or "")[:10] or "undated"
        else:  # folder
            key = c["path"].parent.name
        groups.setdefault(key, []).append(c)
    return sorted(groups.items())


def dominant_format(clips: list[dict]) -> tuple[int, int, Fraction]:
    """Most common (width, height, frame_dur) in the group, weighted by count.

    The sequence format drives the whole project and FCP conforms everything
    else to it, so the majority format wins — not merely whichever clip
    happens to land first chronologically.
    """
    counts: dict[tuple[int, int, Fraction], int] = {}
    for c in clips:
        key = (c["width"], c["height"], c["frame_dur"])
        counts[key] = counts.get(key, 0) + 1
    return max(counts, key=lambda k: counts[k])


# --------------------------------------------------------------------------
# FCPXML construction
# --------------------------------------------------------------------------

def build(groups: list[tuple[str | None, list[dict]]],
          project_name: str, event_name: str) -> ET.ElementTree:
    """Build one library/event containing one project per group."""
    all_clips = [c for _, group in groups for c in group]
    if not all_clips:
        raise ValueError("No clips to build from.")

    root = ET.Element("fcpxml", version=FCPXML_VERSION)
    resources = ET.SubElement(root, "resources")
    next_id = 1

    # One <format> per unique (width, height, frame rate) across all groups.
    fmt_ids: dict[tuple[int, int, Fraction], str] = {}
    for c in all_clips:
        key = (c["width"], c["height"], c["frame_dur"])
        if key in fmt_ids:
            continue
        fid = f"r{next_id}"
        next_id += 1
        fmt_ids[key] = fid
        ET.SubElement(
            resources, "format",
            id=fid,
            name=format_name(*key),
            frameDuration=frame_dur_str(key[2]),
            width=str(key[0]),
            height=str(key[1]),
            colorSpace="1-1-1 (Rec. 709)",
        )

    # One <asset> per unique source file; multiple clips can reference the same one.
    asset_ids: dict[Path, str] = {}
    for c in all_clips:
        if c["path"] in asset_ids:
            continue
        aid = f"r{next_id}"
        next_id += 1
        asset_ids[c["path"]] = aid

        attrs = {
            "id": aid,
            "name": c["path"].stem,
            "start": "0s",
            "duration": to_rational(c["duration"], c["frame_dur"]),
            "hasVideo": "1",
            "format": fmt_ids[(c["width"], c["height"], c["frame_dur"])],
            "videoSources": "1",
        }
        if c["has_audio"]:
            attrs.update({
                "hasAudio": "1",
                "audioSources": "1",
                "audioChannels": str(c["audio_channels"]),
                "audioRate": str(c["audio_rate"]),
            })
        asset = ET.SubElement(resources, "asset", **attrs)
        ET.SubElement(asset, "media-rep",
                      kind="original-media",
                      src=file_url(c["path"]))

    library = ET.SubElement(root, "library")
    event = ET.SubElement(library, "event", name=event_name)

    for group_name, clips in groups:
        seq_key = dominant_format(clips)
        seq_fmt_id = fmt_ids[seq_key]
        frame_dur = seq_key[2]
        name = project_name if group_name is None else f"{project_name} — {group_name}"

        project = ET.SubElement(event, "project", name=name)
        sequence = ET.SubElement(
            project, "sequence",
            format=seq_fmt_id,
            tcStart="0s",
            tcFormat="NDF",
            audioLayout="stereo",
            audioRate="48k",
        )
        spine = ET.SubElement(sequence, "spine")

        # Lay clips end to end. 'offset' is position on the timeline;
        # 'start' is the in-point inside the source. Both must be frame-exact.
        playhead = Fraction(0)
        for c in clips:
            src_in = Fraction(c.get("in") or 0).limit_denominator(1_000_000)
            src_out = Fraction(c["out"]).limit_denominator(1_000_000) if c.get("out") else c["duration"]
            seg = src_out - src_in
            if seg <= 0:
                print(f"  ! skipping {c['path'].name}: in/out is empty", file=sys.stderr)
                continue
            # Snap the segment to the clip's own frame grid so the playhead
            # only ever advances by whole frames.
            seg = round(seg / c["frame_dur"]) * c["frame_dur"]
            if seg <= 0:
                continue

            ET.SubElement(
                spine, "asset-clip",
                ref=asset_ids[c["path"]],
                name=c.get("name") or c["path"].stem,
                offset=to_rational(playhead, frame_dur),
                start=to_rational(src_in, c["frame_dur"]),
                duration=to_rational(seg, c["frame_dur"]),
                format=fmt_ids[(c["width"], c["height"], c["frame_dur"])],
                tcFormat="NDF",
            )
            playhead += seg

        sequence.set("duration", to_rational(playhead, frame_dur))

    ET.indent(root, space="    ")
    return ET.ElementTree(root)


def verify_frame_alignment(tree: ET.ElementTree) -> None:
    """Assert every time value in the document lands on a frame boundary.

    Every new time-handling path must pass through here (project convention).
    Raises AssertionError on the first misaligned value.
    """
    root = tree.getroot()
    fmt_dur = {
        f.get("id"): parse_rational(f.get("frameDuration"))
        for f in root.iter("format")
    }
    for seq in root.iter("sequence"):
        seq_dur = fmt_dur[seq.get("format")]
        total = parse_rational(seq.get("duration"))
        assert (total / seq_dur).denominator == 1, \
            f"sequence duration {seq.get('duration')} off frame grid"
        for clip in seq.iter("asset-clip"):
            clip_dur = fmt_dur[clip.get("format")]
            for attr, grid in (("offset", seq_dur), ("start", clip_dur), ("duration", clip_dur)):
                val = parse_rational(clip.get(attr))
                assert (val / grid).denominator == 1, \
                    f"{clip.get('name')}: {attr}={clip.get(attr)} off frame grid"


def write(tree: ET.ElementTree, out: Path) -> None:
    xml = ET.tostring(tree.getroot(), encoding="unicode")
    out.write_text(
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        "<!DOCTYPE fcpxml>\n" + xml + "\n",
        encoding="utf-8",
    )


# --------------------------------------------------------------------------

def make_test_clips(dest: Path) -> list[Path]:
    """Synthesise clips so the loop can be proven with zero real media.

    Two 'days' of footage and one odd-rate clip, to exercise chronological
    sort, --group-by day, and mixed-framerate conforming.
    """
    dest.mkdir(parents=True, exist_ok=True)
    specs = [
        ("navy",      4, 30, "2024-06-01T10:00:00Z"),
        ("maroon",    3, 30, "2024-06-01T15:30:00Z"),
        ("darkgreen", 5, 30, "2024-06-02T09:00:00Z"),
        ("indigo",    3, 25, "2024-06-02T18:45:00Z"),
    ]
    made = []
    for i, (color, secs, rate, created) in enumerate(specs, 1):
        p = dest / f"test_{i:02d}.mov"
        subprocess.run([
            "ffmpeg", "-y", "-v", "error",
            "-f", "lavfi", "-i", f"color=c={color}:s=1920x1080:r={rate}:d={secs}",
            "-f", "lavfi", "-i", f"sine=frequency={220 * i}:duration={secs}:sample_rate=48000",
            "-c:v", "prores_ks", "-profile:v", "0", "-pix_fmt", "yuv422p",
            "-c:a", "pcm_s16le", "-ac", "2",
            "-metadata", f"creation_time={created}",
            "-shortest", str(p),
        ], check=True)
        made.append(p)
    return made


def selftest() -> int:
    print("Generating synthetic test clips...")
    work = Path("fcpxml_selftest")
    paths = make_test_clips(work)

    cache = ProbeCache(work / "probe_cache.sqlite")
    clips = [cache.probe(p) for p in paths]
    # Second pass must be all cache hits.
    clips = [cache.probe(p) for p in paths]
    assert cache.hits == len(paths), f"cache broken: {cache.hits} hits, {cache.misses} misses"
    print(f"Probe cache: {cache.hits} hits / {cache.misses} misses after re-probe")

    # Flat timeline (original behaviour).
    flat = build(group_clips(clips, "none"), "Selftest Flat", "Selftest")
    verify_frame_alignment(flat)
    write(flat, work / "selftest_flat.fcpxml")

    # One project per capture day.
    groups = group_clips(clips, "day")
    days = [g for g, _ in groups]
    assert days == ["2024-06-01", "2024-06-02"], f"day grouping broken: {days}"
    grouped = build(groups, "Selftest", "Selftest")
    verify_frame_alignment(grouped)
    n_projects = len(grouped.getroot().findall(".//project"))
    assert n_projects == 2, f"expected 2 projects, got {n_projects}"
    write(grouped, work / "selftest_by_day.fcpxml")

    cache.close()
    print("\nSelf-test PASSED:")
    print(f"  {work / 'selftest_flat.fcpxml'}   — 4 clips, one timeline")
    print(f"  {work / 'selftest_by_day.fcpxml'} — same clips, one project per day")
    print("All time values verified frame-aligned.")
    return 0


def scan_dir(top: Path) -> list[Path]:
    """Recursively find video files, skipping hidden files and FCP's own bundles."""
    found = []
    for p in sorted(top.rglob("*")):
        if not p.is_file() or p.name.startswith("."):
            continue
        if p.suffix.lower() not in VIDEO_EXTS:
            continue
        # Skip anything inside an FCP library or iMovie bundle on the drive.
        if any(part.endswith((".fcpbundle", ".imovielibrary", ".theater")) for part in p.parts):
            continue
        found.append(p)
    return found


def main() -> int:
    ap = argparse.ArgumentParser(description="Build Final Cut Pro timelines from video files.")
    src = ap.add_mutually_exclusive_group(required=True)
    src.add_argument("--dir", type=Path, help="folder of video files (scanned recursively)")
    src.add_argument("--manifest", type=Path, help="JSON list of shots")
    src.add_argument("--selftest", action="store_true", help="generate synthetic clips, build, verify")
    ap.add_argument("--out", type=Path, default=Path("rough.fcpxml"))
    ap.add_argument("--name", default="Rough Cut", help="project name (group name is appended)")
    ap.add_argument("--event", default="AI Rough Cuts", help="event name")
    ap.add_argument("--group-by", choices=["none", "day", "folder"], default="none",
                    help="one FCP project per capture day or per folder (default: one timeline)")
    ap.add_argument("--min-dur", type=float, default=0.0,
                    help="skip clips shorter than this many seconds")
    ap.add_argument("--cache", type=Path, default=None,
                    help="probe-cache SQLite path (default: probe_cache.sqlite next to --out)")
    ap.add_argument("--no-cache", action="store_true", help="probe everything fresh")
    args = ap.parse_args()

    if args.selftest:
        return selftest()

    entries: list[dict] = []
    if args.dir:
        found = scan_dir(args.dir)
        if not found:
            print(f"No video files under {args.dir}", file=sys.stderr)
            return 1
        print(f"Found {len(found)} video files under {args.dir}")
        entries = [{"path": p} for p in found]
    else:
        for row in json.loads(args.manifest.read_text()):
            entries.append({
                "path": Path(row["path"]),
                "in": row.get("in"),
                "out": row.get("out"),
                "name": row.get("name"),
            })

    cache = None
    if not args.no_cache:
        cache_path = args.cache or args.out.resolve().parent / "probe_cache.sqlite"
        cache = ProbeCache(cache_path)

    clips = []
    skipped = 0
    for e in entries:
        try:
            info = cache.probe(e["path"]) if cache else probe(e["path"])
        except (subprocess.CalledProcessError, ValueError, KeyError) as err:
            print(f"  ! skipping {e['path'].name}: {err}", file=sys.stderr)
            skipped += 1
            continue
        if float(info["duration"]) < args.min_dur:
            skipped += 1
            continue
        info.update({k: v for k, v in e.items() if k in ("in", "out", "name") and v is not None})
        clips.append(info)

    if cache:
        print(f"Probed {cache.misses} files, {cache.hits} from cache")
        cache.close()
    if skipped:
        print(f"Skipped {skipped} files (unreadable or under --min-dur)")
    if not clips:
        print("Nothing usable to build from.", file=sys.stderr)
        return 1

    groups = group_clips(clips, args.group_by)
    tree = build(groups, args.name, args.event)
    verify_frame_alignment(tree)
    write(tree, args.out)

    total = sum(
        (Fraction(c["out"]) if c.get("out") else c["duration"]) - Fraction(c.get("in") or 0)
        for c in clips
    )
    label = f"{len(groups)} projects" if args.group_by != "none" else "1 timeline"
    print(f"\nWrote {args.out}  —  {len(clips)} clips, {label}, {float(total):.2f}s total")
    print("Double-click it, or: open -a 'Final Cut Pro' " + str(args.out))
    return 0


if __name__ == "__main__":
    sys.exit(main())
