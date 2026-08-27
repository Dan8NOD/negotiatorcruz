#!/usr/bin/env python3
"""Compile The Drill Book into a print-ready HTML book.

Reuses the manual's renderer and stylesheet so all the books share one hand.
    python3 drillbook/tools/makedrillbook.py -> build/the-drill-book.html
"""
import os, re, sys, glob, html

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.join(ROOT, "book", "tools"))
import makebook as mb

BOOK = os.path.join(ROOT, "drillbook")
BUILD = os.path.join(ROOT, "build")

CSS = open(os.path.join(ROOT, "book", "tools", "makebook.py"), encoding="utf-8").read()
CSS = CSS.split('css = """', 1)[1].split('"""', 1)[0]

# Print order groups by Part, per 00-DECISIONS.md. A drill's PART field in
# its header box decides its group; number order inside each group.
PARTS = [
    ("Part I", "Solo", "One person, their own calls, a desk.", ("Solo",)),
    ("Part II", "Pairs", "Two people, sometimes a timer or a listener.", ("Pairs",)),
    ("Part III", "The Room", "Three or more, an observer counting.", ("The room",)),
    ("Part IV", "Live Fire", "Real calls, real pipeline, real accounts.", ("Live fire",)),
]


def drill_part(text):
    m = re.search(r"^STAGE .*?PART\s+(.+?)\s*$", text, re.M)
    return m.group(1) if m else None


def build():
    body, toc = [], []

    def add_file(path, anchor, label):
        t = open(path, encoding="utf-8").read()
        body.append(f'<section class="ch" id="{anchor}">' + mb.md(t) + "</section>")
        toc.append(f'<li><a href="#{anchor}"><span class="tn">·</span> {html.escape(label)}</a></li>')

    add_file(os.path.join(BOOK, "01-how-to-run-a-drill.md"), "method", "How to Run a Drill")
    add_file(os.path.join(BOOK, "02-the-two-indexes.md"), "indexes", "The Two Indexes")

    drills = []
    for p in sorted(glob.glob(os.path.join(BOOK, "drills", "drill-*.md"))):
        t = open(p, encoding="utf-8").read()
        m = re.search(r"^#\s*(Drill\s*(\d+):\s*.+?)\s*$", t, re.M)
        if not m:
            raise SystemExit(f"{p}: no drill title")
        part = drill_part(t)
        if not part:
            raise SystemExit(f"{p}: no PART field")
        drills.append((int(m.group(2)), m.group(1), part, t))

    for pn, pt, pd, keys in PARTS:
        members = [d for d in drills if any(d[2].startswith(k) for k in keys)]
        if not members:
            continue
        body.append(f'<section class="partdiv"><div class="pn">{pn}</div>'
                    f'<h1 class="pt">{pt}</h1><p class="pd">{pd}</p></section>')
        toc.append(f'<li class="toc-part">{pn} · {pt}</li>')
        for num, title, part, t in sorted(members):
            body.append(f'<section class="ch" id="d{num}">' + mb.md(t) + "</section>")
            toc.append(f'<li><a href="#d{num}"><span class="tn">{num:02d}</span> '
                       f'{html.escape(title.split(":", 1)[1].strip())}</a></li>')

    placed = {d[0] for pn, pt, pd, keys in PARTS for d in drills
              if any(d[2].startswith(k) for k in keys)}
    missing = [d[0] for d in drills if d[0] not in placed]
    if missing:
        raise SystemExit(f"drills with unplaced PART values: {missing}")

    body.append('<section class="partdiv"><div class="pn">Part V</div>'
                '<h1 class="pt">The Programs</h1>'
                '<p class="pd">A sequence with a calendar is a curriculum.</p></section>')
    toc.append('<li class="toc-part">Part V · The Programs</li>')
    add_file(os.path.join(BOOK, "03-the-programs.md"), "programs", "The Programs")

    doc = ('<!doctype html><html lang="en"><head><meta charset="utf-8">'
           '<title>The Drill Book</title><style>' + CSS + '</style></head><body>'
           '<section class="title-pg"><div class="kick">Negotiators on Demand</div>'
           '<h1>The Drill Book</h1>'
           '<p class="sub">The practice curriculum for the Protocol</p>'
           '<p class="by">Dan Cruz</p>'
           '<p class="cred">Seven years of practice · five hosting · 1,000+ live sessions · Chicago</p>'
           '<p class="draft">Working draft, working title (see the decisions doc for the count '
           'question). Bracketed <code>[NEEDS:]</code> markers are slots for real material.<br>'
           'Nothing in them is invented.</p></section>'
           '<section class="toc"><h1>Contents</h1><ul>' + "".join(toc) + '</ul></section>'
           + "".join(body) + '</body></html>')

    os.makedirs(BUILD, exist_ok=True)
    out = os.path.join(BUILD, "the-drill-book.html")
    open(out, "w", encoding="utf-8").write(doc)
    print("html:", out, f"({len(doc)//1024} KB)")
    return out


if __name__ == "__main__":
    build()
