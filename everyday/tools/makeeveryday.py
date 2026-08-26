#!/usr/bin/env python3
"""Compile Same Words, Bigger Rooms into a print-ready HTML book.

Reuses the manual's renderer and stylesheet so all the books share one hand.
    python3 everyday/tools/makeeveryday.py -> build/same-words-bigger-rooms.html
"""
import os, re, sys, html

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.join(ROOT, "book", "tools"))
import makebook as mb

BOOK = os.path.join(ROOT, "everyday")
BUILD = os.path.join(ROOT, "build")

CSS = open(os.path.join(ROOT, "book", "tools", "makebook.py"), encoding="utf-8").read()
CSS = CSS.split('css = """', 1)[1].split('"""', 1)[0]

# Chapters appear here as they get written. A missing file is skipped so the
# book builds at every stage of the queue.
ORDER = [
    ("ch1-the-argument-you-are-actually-having.md",
     ("Part I", "The Kitchen Table", "The same tools, smallest room first.")),
    ("ch2-listening-is-not-waiting.md", None),
    ("ch3-the-repair.md", None),
    ("ch4-the-raise.md",
     ("Part II", "Your Money", "Asking, buying, and refusing to be billed.")),
    ("ch5-the-big-purchase.md", None),
    ("ch6-the-bill-you-should-not-pay.md", None),
    ("ch7-the-landlord-and-the-contractor.md", None),
    ("ch8-the-job-offer.md",
     ("Part III", "The Middle Rooms", "Career moves, where the stakes start compounding.")),
    ("ch9-no-without-the-burn.md", None),
    ("ch10-torn-ready-not-yet.md", None),
    ("ch11-the-same-words-with-six-zeros.md",
     ("Part IV", "The Big Rooms", "One deal, walked start to finish, with the receipts.")),
    ("ch12-what-they-believe.md", None),
]


def build():
    body, toc = [], []

    fm = os.path.join(BOOK, "front-matter.md")
    if os.path.exists(fm):
        body.append('<section class="ch" id="front">'
                    + mb.md(open(fm, encoding="utf-8").read()) + "</section>")

    for i, (fn, part) in enumerate(ORDER, 1):
        p = os.path.join(BOOK, fn)
        if not os.path.exists(p):
            continue
        if part:
            pn, pt, pd = part
            body.append(f'<section class="partdiv"><div class="pn">{pn}</div>'
                        f'<h1 class="pt">{pt}</h1><p class="pd">{pd}</p></section>')
            toc.append(f'<li class="toc-part">{pn} · {pt}</li>')
        t = open(p, encoding="utf-8").read()
        m = re.search(r"^#\s*Chapter\s*\d+\s*[:]\s*(.+?)\s*$", t, re.M)
        title = m.group(1) if m else fn
        body.append(f'<section class="ch" id="e{i}">' + mb.md(t) + "</section>")
        toc.append(f'<li><a href="#e{i}"><span class="tn">{i}</span> {html.escape(title)}</a></li>')

    bm = os.path.join(BOOK, "back-matter.md")
    if os.path.exists(bm):
        body.append('<section class="ch" id="back">'
                    + mb.md(open(bm, encoding="utf-8").read()) + "</section>")
        toc.append('<li><a href="#back"><span class="tn">·</span> Back matter</a></li>')

    doc = ('<!doctype html><html lang="en"><head><meta charset="utf-8">'
           '<title>Same Words, Bigger Rooms</title><style>' + CSS + '</style></head><body>'
           '<section class="title-pg"><div class="kick">Negotiators on Demand</div>'
           '<h1>Same Words, Bigger Rooms</h1>'
           '<p class="sub">Negotiation from the kitchen table to the closing room</p>'
           '<p class="by">Dan Cruz</p>'
           '<p class="cred">Seven years of practice · five hosting · 1,000+ live sessions · Chicago</p>'
           '<p class="draft">Working draft, working title. Bracketed <code>[NEEDS:]</code> markers are slots<br>'
           'for real stories. Nothing in them is invented.</p></section>'
           '<section class="toc"><h1>Contents</h1><ul>' + "".join(toc) + '</ul></section>'
           + "".join(body) + '</body></html>')

    os.makedirs(BUILD, exist_ok=True)
    out = os.path.join(BUILD, "same-words-bigger-rooms.html")
    open(out, "w", encoding="utf-8").write(doc)
    print("html:", out, f"({len(doc)//1024} KB)")
    return out


if __name__ == "__main__":
    build()
