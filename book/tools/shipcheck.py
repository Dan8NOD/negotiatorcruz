#!/usr/bin/env python3
"""Does every source file actually reach the finished book?

Written after finding the same defect twice by hand. The manual's front
matter and its three appendices were finished, committed, ticked off the
queue, and read by neither renderer, so every rendered edition ended at the
last chapter. The guide was missing its front matter and its whole back
matter, including the one call to action. Nothing failed. The builds were
green the entire time, because a renderer that never opens a file cannot
complain about it.

This checks the only thing that matters: for each source file, does a
distinctive sentence from it appear in the built HTML and in the EPUB.

    python3 book/tools/shipcheck.py            # all four books
    python3 book/tools/shipcheck.py guide      # one

Exit code 1 if anything is missing, so it can gate a release.
"""
import glob
import html as H
import os
import re
import sys
import zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
B = lambda *p: os.path.join(ROOT, *p)


def sources(pattern, drop_prefixes=("00-",), recursive=False):
    out = []
    for f in sorted(glob.glob(B(*pattern.split("/")), recursive=recursive)):
        if os.path.basename(f).startswith(drop_prefixes):
            continue
        out.append(f)
    return out


def manual_sources():
    return (sorted(glob.glob(B("book", "chapters", "*.md")))
            + [B("book", n) for n in ("front-matter.md", "back-matter-cards.md",
                                      "back-matter-reference.md", "back-matter-glossary.md")])


BOOKS = {
    "manual": dict(
        name="The Cruz Protocol",
        html=B("build", "cruz-protocol.html"),
        epub=B("build", "cruz-protocol-DRAFT.epub"),
        files=manual_sources,
    ),
    "guide": dict(
        name="Six Before Yes",
        html=B("build", "six-before-yes.html"),
        epub=B("build", "six-before-yes-DRAFT.epub"),
        files=lambda: sources("guide/*.md"),
    ),
    "drillbook": dict(
        name="The Drill Book",
        html=B("build", "the-drill-book.html"),
        epub=B("build", "the-drill-book-DRAFT.epub"),
        files=lambda: sources("drillbook/**/*.md", recursive=True),
    ),
    "everyday": dict(
        name="Same Words, Bigger Rooms",
        html=B("build", "same-words-bigger-rooms.html"),
        epub=B("build", "same-words-bigger-rooms-DRAFT.epub"),
        files=lambda: sources("everyday/*.md"),
    ),
}

# The renderers smarten quotes and the voice pass has its own punctuation, so
# compare on letters and digits only. Anything less and the check reports
# false misses, which is worse than no check because it trains you to ignore
# it.
FOLD = {0x2018: "'", 0x2019: "'", 0x201c: '"', 0x201d: '"',
        0x2014: "-", 0x2013: "-", 0x2026: "...", 0x00a0: " "}


def flatten(s):
    s = H.unescape(re.sub(r"<[^>]+>", " ", s)).translate(FOLD)
    return " ".join(re.sub(r"[^a-z0-9 ]+", " ", s.lower()).split())


def probe_for(path):
    """The longest plain prose sentence in a file, as a fingerprint.

    Front-matter files are specifications: the copy is quoted and the rest is
    an editorial note that is not supposed to print, so only the quoted part
    is a fair probe."""
    t = open(path, encoding="utf-8").read()
    if "front-matter" in os.path.basename(path):
        t = "\n".join(l.lstrip("> ") for l in t.splitlines() if l.startswith(">"))
    cands = [" ".join(x.split())
             for x in re.findall(r"(?m)^[A-Za-z][^\n#>|`*\[]{60,200}$", t)]
    if not cands:
        return None
    return flatten(max(cands, key=len))[:70] or None


def epub_text(path):
    if not os.path.isfile(path):
        return None
    z = zipfile.ZipFile(path)
    return flatten(" ".join(z.read(x).decode("utf-8", "replace")
                            for x in z.namelist() if x.endswith(".xhtml")))


def check(key):
    spec = BOOKS[key]
    if not os.path.isfile(spec["html"]):
        print(f"{spec['name']}: no build, run the make script first")
        return 1
    printed = flatten(open(spec["html"], encoding="utf-8").read())
    ebook = epub_text(spec["epub"])
    miss_p, miss_e, skipped = [], [], []
    files = spec["files"]()
    for f in files:
        probe = probe_for(f)
        if not probe:
            skipped.append(os.path.basename(f))
            continue
        if probe not in printed:
            miss_p.append(os.path.basename(f))
        if ebook is not None and probe not in ebook:
            miss_e.append(os.path.basename(f))

    # The dash rule applies to what a reader sees, not to the sources. Text
    # the build scripts emit themselves once slipped through exactly here,
    # so the check reads the finished editions rather than the markdown.
    raw_html = open(spec["html"], encoding="utf-8").read()
    dashes_p = len(re.findall(r"[\u2014\u2013]", raw_html))
    dashes_e = 0
    if os.path.isfile(spec["epub"]):
        z = zipfile.ZipFile(spec["epub"])
        dashes_e = sum(len(re.findall(r"[\u2014\u2013]", z.read(x).decode("utf-8", "replace")))
                       for x in z.namelist() if x.endswith((".xhtml", ".opf")))

    bad = bool(miss_p or miss_e or dashes_p or dashes_e)
    mark = "FAIL" if bad else "ok"
    print(f"[{mark}] {spec['name']}: {len(files)} source files"
          + (f", {len(skipped)} with no usable probe" if skipped else ""))
    if ebook is None:
        print("       no EPUB built, print only")
    for label, missing in (("print", miss_p), ("EPUB", miss_e)):
        if missing:
            print(f"       missing from {label}: {', '.join(missing)}")
    for label, n in (("print", dashes_p), ("EPUB", dashes_e)):
        if n:
            print(f"       {n} dash(es) in the rendered {label}")
    return 1 if bad else 0


if __name__ == "__main__":
    keys = [a for a in sys.argv[1:] if a in BOOKS] or list(BOOKS)
    sys.exit(max(check(k) for k in keys))
