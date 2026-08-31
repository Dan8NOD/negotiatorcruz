#!/usr/bin/env python3
"""Derive audiobook narration scripts for Six Before Yes.

Reuses the manual's narrate() pipeline so all three audiobooks read boxes,
tables, and quotes the same way. Canonical source is guide/ch*.md plus the
one-page method summary, which becomes the opening track. The parallel grid
is not narrated: it is a visual centerfold, and its content reaches the ear
through Chapter 4, which teaches it.

Guide-specific cleaning before the shared pipeline: the chapters carry
bracketed italic stage directions (chapter opener notes, figure specs, the
centerfold marker, the blueprint device counts). Those are print
instructions, not prose, and they are stripped whole.

Everything in guide/audio/ is generated. Edit the chapters, re-run this.

    python3 guide/tools/makenarration.py
"""
import glob, os, re, sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
sys.path.insert(0, os.path.join(ROOT, "book", "tools"))
import build as manual_build

GUIDE = os.path.join(ROOT, "guide")
AUD = os.path.join(GUIDE, "audio")


def clean(md):
    return re.sub(r"(?s)\*\[.*?\]\*", "", md)


def main():
    files = sorted(glob.glob(os.path.join(GUIDE, "ch*.md")),
                   key=lambda f: int(re.search(r"ch(\d+)", f).group(1)))
    if not files:
        sys.exit("no chapters found")
    os.makedirs(AUD, exist_ok=True)
    for f in glob.glob(os.path.join(AUD, "*.txt")):
        os.remove(f)

    summary = open(os.path.join(GUIDE, "01-method-summary.md"),
                   encoding="utf-8").read()
    summary = re.sub(r"(?s)^.*?(## SIX BEFORE YES)", r"\1", summary, count=1)
    summary = summary.split("### Master figure (spec)")[0].rstrip().rstrip("-").rstrip()
    txt = manual_build.narrate(clean(summary))
    open(os.path.join(AUD, "00-method-summary.txt"), "w",
         encoding="utf-8").write(txt)
    wrote = 1

    for f in files:
        md = open(f, encoding="utf-8").read()
        txt = manual_build.narrate(clean(md))
        out = os.path.join(AUD, os.path.basename(f).replace(".md", ".txt"))
        open(out, "w", encoding="utf-8").write(txt)
        wrote += 1
    print(f"narration: {wrote} files -> guide/audio/")


if __name__ == "__main__":
    main()
