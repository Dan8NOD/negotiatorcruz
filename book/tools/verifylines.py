#!/usr/bin/env python3
"""Verify that quoted script lines match the shipped catalog.

The everyday book's rule 2 (and the manual's rule 4) promise that every
script line inside a THE WORDS box is a shipped line, verbatim, with only
two transforms allowed: dash conversion (em dashes become periods or
commas) and slot rendering ({em} becomes a blank or a plain rendering).
This tool enforces the promise mechanically.

    python3 book/tools/verifylines.py [paths...]   # default: everyday/

Exit 1 if any quoted line in a fenced script box neither matches the
catalog nor appears on the authored-lines allowlist below.
"""
import os, re, sys, json

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
CATALOG = os.path.join(ROOT, "book", "data", "negotiation_labels.json")

# Lines inside script boxes that are deliberately authored, not shipped:
# stems taught as stems, worked examples explicitly labeled as fills, and
# clean-language pinning rendered in the book's compressed form. Each entry
# is normalized text (see norm below). Keep this list short and honest.
ALLOW = {
    # ch1: the four stems and the softener, taught as stems
    "it seems like", "it sounds like", "it looks like", "it feels like",
    "it probably seems like",
    # ch1: the two fills, labeled in prose as vocabulary demonstrations
    "it sounds like theres some real wariness underneath this",
    "it seems like the fatigue is doing a lot of the negotiating for you right now",
    # ch6: clean-language pins, the book's compressed rendering of the
    # shipped word-specific lines (the shipped originals carry the same
    # word and question, wrapped differently)
    "complicated complicated how",
    "later later meaning when specifically",
    "maybe what would move that to a yes",
    "stuck what kind of stuck is that",
}


def norm(s):
    s = s.replace("’", "'").replace("‘", "'")
    s = s.replace("…", " ").replace("...", " ")
    s = re.sub(r'[—–,.:!?;()\[\]"“”]', " ", s)
    s = re.sub(r"\s+", " ", s).strip().lower()
    # numeral spelling is presentation, not wording (the manual's own
    # assembled chapters spell the mirror's "3" as "three")
    for d, w in (("3", "three"), ("2", "two"), ("4", "four"),
                 ("5", "five"), ("6", "six")):
        s = re.sub(rf"\b{d}\b", w, s)
    return s


def catalog_patterns():
    data = json.load(open(CATALOG, encoding="utf-8"))
    exact, wild = set(), []
    for row in data["lines"]:
        t = row["template"]
        n = norm(t)
        if "{em}" in t.lower():
            pat = re.escape(norm(t.replace("{em}", "EMSLOT").replace("{Em}", "EMSLOT")))
            pat = pat.replace("EMSLOT", r"[\w' ]+")
            wild.append(re.compile("^" + pat + "$"))
            # also accept the blank rendering
            exact.add(norm(t.replace("{em}", "______").replace("{Em}", "______")))
        else:
            exact.add(n)
    return exact, wild


def box_lines(path):
    """Yield logical lines from fenced script boxes, continuations joined."""
    t = open(path, encoding="utf-8").read()
    for block in re.findall(r"```\n(.*?)```", t, re.S):
        if "┌" in block:
            continue  # bordered field cards are compressions, checked by eye
        # Entries sit at two spaces of indent. True wraps are deeper, so
        # only those get joined to the line above.
        joined = re.sub(r"\n   +(?=\S)", " ", block)
        for line in joined.split("\n"):
            line = line.strip()
            if line:
                yield line


def is_header(line):
    # Box headers open with two or more capitalized words in caps, and may
    # carry a lowercase tail after a comma: "LET IT SIT, the silence".
    return bool(re.match(r"^[A-Z][A-Z0-9' ]+[A-Z](,.*)?$", line))


def parts(line):
    """Pieces of a line that must each match: quotes, brackets, remainder."""
    got = []
    for m in re.finditer(r'"([^"]{12,})"', line):
        if not m.group(1).isupper():
            got.append(m.group(1))
    for m in re.finditer(r"\[([^\]]{12,})\]", line):
        got.append(m.group(1))
    rest = re.sub(r'"[^"]*"', " ", line)
    rest = re.sub(r"\[[^\]]*\]", " ", rest).strip(" ,.")
    if len(rest) > 20:
        got.append(rest)
    return got


def main(paths):
    exact, wild = catalog_patterns()

    def ok(q):
        n = norm(q)
        if not n or n in exact or n in ALLOW:
            return True
        return any(w.match(n) for w in wild)

    bad = 0
    for path in paths:
        for line in box_lines(path):
            if is_header(line) or ok(line):
                continue
            for q in parts(line):
                if ok(q):
                    continue
                if "______" in q and ok(q.replace("______", "something")):
                    continue
                print(f"UNMATCHED  {os.path.relpath(path, ROOT)}: {q!r}")
                bad += 1
    print(("FAIL: " + str(bad) + " unmatched") if bad else "OK: every boxed line matches the catalog or the allowlist")
    return 1 if bad else 0


def drift(paths, lo=0.82, hi=0.999):
    """Near-miss mode, for books whose boxes carry more than scripts.

    The manual and the drill book legitimately mix annotations, lowercase
    sub-headers, worked dialogue (a mirror echoes invented counterpart
    speech, so it can never match a fixed catalog), and composite recovery
    lines that wrap a shipped line in authored framing. Strict mode is
    therefore the wrong instrument for them.

    What is still worth catching there is a line that is plainly trying to
    be a catalog line and gets the wording slightly wrong. So: report only
    candidates whose closest catalog match scores between lo and hi. Below
    lo the line is not attempting to be a shipped line. At hi it is one.
    A composite that fully contains a shipped line is correct by design and
    is skipped.
    """
    from difflib import SequenceMatcher
    data = json.load(open(CATALOG, encoding="utf-8"))
    cat = []
    for row in data["lines"]:
        t = row["template"]
        if "{em}" in t.lower():
            continue  # slot lines are handled by strict mode
        cat.append((norm(t), t))

    def close(n):
        best, bt = 0.0, ""
        for cn, ct in cat:
            r = SequenceMatcher(None, n, cn).ratio()
            if r > best:
                best, bt = r, ct
        return best, bt

    hits = 0
    for path in paths:
        for line in box_lines(path):
            if is_header(line):
                continue
            # A line whose whole text matches a shipped line is correct even
            # when it carries a leading quote and a trailing instruction, as
            # the encourager and clean-language boxes do. Check it intact
            # before splitting, or the split halves report as drift.
            if close(norm(line))[0] >= hi:
                continue
            for q in parts(line):
                n = norm(q)
                if len(n) < 18:
                    continue
                best, bt = close(n)
                if best >= hi:
                    continue
                # composite: authored framing that carries a shipped line whole
                if any(cn in n for cn, _ in cat):
                    continue
                if lo <= best < hi:
                    print(f"DRIFT? {os.path.relpath(path, ROOT)}")
                    print(f"   book: {q}")
                    print(f"   ship: {bt}   ({best:.2f})")
                    hits += 1
    print(f"{hits} near-miss line(s) to eyeball" if hits
          else "OK: no near-misses, every close line matches exactly")
    return 0


if __name__ == "__main__":
    args = sys.argv[1:]
    mode = drift if "--drift" in args else main
    args = [a for a in args if a != "--drift"]
    if not args:
        import glob
        args = sorted(glob.glob(os.path.join(ROOT, "everyday", "ch*.md")))
    sys.exit(mode(args))
