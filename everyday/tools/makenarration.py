#!/usr/bin/env python3
"""Derive audiobook narration scripts for Same Words, Bigger Rooms.

Reuses the manual's narrate() pipeline so both audiobooks read the boxes,
tables, and quotes the same way. Canonical source is everyday/ch*.md.
Everything in everyday/audio/ is generated. Edit the chapters, re-run this.

    python3 everyday/tools/makenarration.py
"""
import glob, os, re, sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
sys.path.insert(0, os.path.join(ROOT, "book", "tools"))
import build as manual_build

BOOK = os.path.join(ROOT, "everyday")
AUD = os.path.join(BOOK, "audio")


def main():
    files = sorted(glob.glob(os.path.join(BOOK, "ch*.md")),
                   key=lambda f: int(re.search(r"ch(\d+)", f).group(1)))
    if not files:
        sys.exit("no chapters found")
    os.makedirs(AUD, exist_ok=True)
    for f in glob.glob(os.path.join(AUD, "*.txt")):
        os.remove(f)
    wrote = 0
    for f in files:
        md = open(f, encoding="utf-8").read()
        txt = manual_build.narrate(md)
        out = os.path.join(AUD, os.path.basename(f).replace(".md", ".txt"))
        open(out, "w", encoding="utf-8").write(txt)
        wrote += 1
    print(f"narration: {wrote} files -> everyday/audio/")


if __name__ == "__main__":
    main()
