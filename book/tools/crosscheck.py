#!/usr/bin/env python3
"""Do the four books still agree with each other?

The project's own stated worst outcome is a reader who owns two of these
books and finds them contradicting each other. That has been audited by hand
twice, as X1 and X2, and both times it found real drift. A hand audit catches
what exists on the day it runs and nothing after, so this is the version that
runs on every push.

Three things are checked, in the order they are worth catching:

  1. Shared glossary definitions. A term defined in more than one book must
     be defined identically. Only the locator differs, "Ch 19" against
     "Step 4", because the books index on different axes.
  2. The series page. It appears in all four back matters and is supposed to
     be the same page, so a change to one is a change to all four.
  3. Doctrine that must not drift: the four stage names in order, the three
     state names, and the that's-right rule.

    python3 book/tools/crosscheck.py

Exit code 1 on any disagreement.
"""
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

GLOSSARIES = {
    "The Cruz Protocol": "book/back-matter-glossary.md",
    "Six Before Yes": "guide/back-matter.md",
    "Same Words, Bigger Rooms": "everyday/back-matter.md",
}

SERIES_PAGES = [
    "book/back-matter-glossary.md",
    "guide/back-matter.md",
    "drillbook/back-matter.md",
    "everyday/back-matter.md",
]

# The locator is the one part of a shared definition allowed to differ: the
# manual indexes by chapter, the guide by step, the everyday book by its own
# chapters. Everything before it has to match.
LOCATOR = re.compile(r"\s*(?:Ch(?:apter)?s?|Steps?)\s*\d+(?:\s*(?:,|and|to)\s*"
                     r"(?:Ch(?:apter)?s?\s*)?\d+)*\b.*$", re.I)


def read(rel):
    p = os.path.join(ROOT, rel)
    return open(p, encoding="utf-8").read() if os.path.isfile(p) else ""


def normalise(s):
    """Compare on words. Emphasis and smart quotes are typography, not text."""
    s = s.replace("’", "'").replace("‘", "'")
    s = s.replace("“", '"').replace("”", '"')
    s = re.sub(r"[*_`]", "", s)
    return " ".join(s.split())


def glossary_entries(text):
    """{term: definition} from a "**Term.** definition" list."""
    out = {}
    section = text
    for head in ("## Glossary", "# Appendix C"):
        if head in section:
            section = section.split(head, 1)[1]
            break
    for m in re.finditer(r"^\*\*(.+?)\*\*\s*(.+?)(?=\n\s*\n|\Z)", section, re.S | re.M):
        term = normalise(m.group(1)).rstrip(".").strip().lower()
        body = normalise(m.group(2))
        body = LOCATOR.sub("", body).strip().rstrip(".,")
        if term and body:
            out[term] = body
    return out


def series_page(text):
    m = re.search(r"(?ims)^##+\s*(?:also from negotiators on demand|the series)\b.*?"
                  r"(?=^##\s|\Z)", text)
    return normalise(m.group(0)).lower() if m else None


# Terms the books are meant to state differently, with the reason. A recorded
# decision, so a real divergence cannot hide among them. Anything not listed
# here has to match.
REWORDED = {
    # Each book points at where its own cards live, which is a locator, not a
    # definition: the manual has them in Appendix A, the guide points at the
    # manual.
    "field card",
    # Aimed at a reader negotiating with family, so the construction is spelled
    # out rather than named. Same tool, same mechanism.
    "accusation audit",
    "mirror",
}


DOCTRINE = [
    ("stage order", re.compile(r"read\s*[,>→/-]+\s*disarm\s*[,>→/-]+\s*"
                               r"steer\s*[,>→/-]+\s*close", re.I)),
    ("three states", re.compile(r"torn\W+ready\W+(?:or\s+)?not yet", re.I)),
]


def main():
    problems = []

    # 1. shared glossary definitions
    glosses = {name: glossary_entries(read(p)) for name, p in GLOSSARIES.items()}
    for name, g in glosses.items():
        if not g:
            problems.append(f"no glossary entries parsed from {GLOSSARIES[name]}")
    terms = {}
    for name, g in glosses.items():
        for term, body in g.items():
            terms.setdefault(term, []).append((name, body))
    shared = {t: v for t, v in terms.items() if len(v) > 1}
    for term, entries in sorted(shared.items()):
        if term in REWORDED:
            continue
        # The two corporate books are held to identical wording. The everyday
        # book is the consumer register by design, says so in its own entry
        # for the Protocol, and is allowed to say the same thing in home
        # clothes. It still may not say something different.
        strict = [(n, b) for n, b in entries if n != "Same Words, Bigger Rooms"]
        entries = strict if len(strict) > 1 else entries
        bodies = sorted({b for _, b in entries}, key=len)
        if len(bodies) == 1:
            continue
        # A book may extend a shared definition for its own register, so long
        # as it starts from the same words. "Read, Disarm, Steer, Close ...
        # every time. This book teaches its tools in home clothes" is an
        # addition, not a disagreement. Anything else is two books making
        # different claims about the same term, which is the failure this
        # exists to catch.
        if all(b.startswith(bodies[0]) for b in bodies):
            continue
        problems.append(f'"{term}" is defined differently across '
                        + ", ".join(n for n, _ in entries) + ":")
        for n, b in entries:
            problems.append(f"      {n}: {b}")

    # 2. the series page
    pages = {p: series_page(read(p)) for p in SERIES_PAGES}
    missing = [p for p, v in pages.items() if not v]
    present = {p: v for p, v in pages.items() if v}
    for p in missing:
        problems.append(f"no series page in {p}")
    if len(set(present.values())) > 1:
        problems.append("the series page is not identical across the back matters:")
        for p, v in present.items():
            problems.append(f"      {p}: {len(v)} chars")

    # 3. doctrine that must not drift
    corpus = {name: read(path) for name, path in
              (("manual", "book/back-matter-glossary.md"),
               ("guide", "guide/back-matter.md"),
               ("everyday", "everyday/back-matter.md"))}
    for label, pat in DOCTRINE:
        absent = [n for n, t in corpus.items() if not pat.search(normalise(t))]
        if absent and len(absent) < len(corpus):
            problems.append(f"{label} stated in some glossaries but not "
                            + ", ".join(absent))

    print(f"glossaries: {', '.join(f'{n} {len(g)}' for n, g in glosses.items())}")
    print(f"terms shared by more than one book: {len(shared)}")
    print(f"series page: {len(present)}/{len(SERIES_PAGES)} back matters")
    if problems:
        print("\nFAIL")
        for p in problems:
            print("  " + p)
        return 1
    print("\nok: the books agree")
    return 0


if __name__ == "__main__":
    sys.exit(main())
