#!/usr/bin/env python3
"""Render the 33 field cards as a print-ready deck with cut marks.

Source: the boxed cards in book/back-matter-cards.md, which are the
canonical card texts. Cards print two-up on US Letter at 6in x 4in,
landscape orientation per card, with corner cut marks.

    python3 book/tools/makecards.py -> build/field-card-deck.html
"""
import os, re, html

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
SRC = os.path.join(ROOT, "book", "back-matter-cards.md")
BUILD = os.path.join(ROOT, "build")

CSS = """
@page { size: letter portrait; margin: 0.45in; }
* { margin: 0; padding: 0; box-sizing: border-box; }
body { font-family: 'DejaVu Sans Mono', 'Courier New', monospace;
       background: #fff; color: #2a2317; }
.sheet { display: flex; flex-direction: column; align-items: center;
         gap: 0.55in; page-break-after: always; padding-top: 0.25in; }
.cardwrap { position: relative; width: 6in; height: 4in; }
.card { width: 6in; height: 4in; border: 0.5pt solid #c9bfa8;
        display: flex; align-items: center; justify-content: center;
        overflow: hidden; }
.card pre { font-size: 8.6pt; line-height: 1.12; white-space: pre; }
.mark { position: absolute; width: 0.22in; height: 0.22in; }
.mark.tl { top: -0.24in; left: -0.24in;
           border-right: 0.75pt solid #555; border-bottom: 0.75pt solid #555; }
.mark.tr { top: -0.24in; right: -0.24in;
           border-left: 0.75pt solid #555; border-bottom: 0.75pt solid #555; }
.mark.bl { bottom: -0.24in; left: -0.24in;
           border-right: 0.75pt solid #555; border-top: 0.75pt solid #555; }
.mark.br { bottom: -0.24in; right: -0.24in;
           border-left: 0.75pt solid #555; border-top: 0.75pt solid #555; }
.cover { text-align: center; padding-top: 3in; page-break-after: always;
         font-family: Georgia, serif; }
.cover h1 { font-size: 26pt; }
.cover p { margin-top: 0.7em; color: #5b5343; font-size: 11pt; }
"""


def cards():
    t = open(SRC, encoding="utf-8").read()
    found = []
    for m in re.finditer(r"```\n(┌.*?└[^\n]*)\n```", t, re.S):
        found.append(m.group(1))
    if len(found) != 33:
        raise SystemExit(f"expected 33 cards, found {len(found)}")
    return found


def build():
    marks = ('<div class="mark tl"></div><div class="mark tr"></div>'
             '<div class="mark bl"></div><div class="mark br"></div>')
    wraps = [f'<div class="cardwrap">{marks}<div class="card">'
             f'<pre>{html.escape(c)}</pre></div></div>' for c in cards()]

    sheets = []
    for i in range(0, len(wraps), 2):
        sheets.append('<div class="sheet">' + "".join(wraps[i:i + 2]) + "</div>")

    doc = ('<!doctype html><html lang="en"><head><meta charset="utf-8">'
           '<title>The Field Card Deck</title><style>' + CSS + '</style></head><body>'
           '<div class="cover"><h1>The Field Card Deck</h1>'
           '<p>All 33 field cards from The Cruz Protocol, print size 6in x 4in.</p>'
           '<p>Print single-sided on card stock, cut on the corner marks,<br>'
           'laminate if the desk is busy. One card per desk beats a book per shelf.</p>'
           '<p>Negotiators on Demand · Dan Cruz</p></div>'
           + "".join(sheets) + '</body></html>')

    os.makedirs(BUILD, exist_ok=True)
    out = os.path.join(BUILD, "field-card-deck.html")
    open(out, "w", encoding="utf-8").write(doc)
    print("html:", out, f"({len(doc)//1024} KB, {len(sheets)} sheets + cover)")
    return out


if __name__ == "__main__":
    build()
