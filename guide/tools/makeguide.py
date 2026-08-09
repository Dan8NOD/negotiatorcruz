#!/usr/bin/env python3
"""Compile Six Before Yes into a print-ready HTML guide.

Reuses the manual's renderer and stylesheet so both books share one hand.
    python3 guide/tools/makeguide.py  ->  build/six-before-yes.html
"""
import os, re, sys, html

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.join(ROOT, "book", "tools"))
import makebook as mb

GUIDE = os.path.join(ROOT, "guide")
BUILD = os.path.join(ROOT, "build")

CSS = open(os.path.join(ROOT, "book", "tools", "makebook.py"), encoding="utf-8").read()
CSS = CSS.split('css = """', 1)[1].split('"""', 1)[0]

ORDER = [("ch1-the-problem.md",      None),
         ("ch2-know-your-exit.md",   ("Part 1", "Prepare", "Three of six steps. Everything here happens before contact.")),
         ("ch3-find-the-stakes.md",  None),
         ("ch4-map-the-room.md",     None),
         ("ch5-pick-your-path.md",   ("Part 2", "Engage", "Plan meets room.")),
         ("ch6-run-the-protocol.md", None),
         ("ch7-lock-and-log.md",     ("Part 3", "Consolidate", "Closing and learning, the same activity at different times."))]


def build():
    body, toc = [], []

    summary = open(os.path.join(GUIDE, "01-method-summary.md"), encoding="utf-8").read()
    summary = re.sub(r"(?s)^.*?(## SIX BEFORE YES)", r"\1", summary, count=1)
    body.append('<section class="ch" id="summary">' + mb.md(summary) + "</section>")
    toc.append('<li><a href="#summary"><span class="tn">·</span> The method, on one page</a></li>')

    for i, (fn, part) in enumerate(ORDER, 1):
        p = os.path.join(GUIDE, fn)
        if not os.path.exists(p):
            continue
        if part:
            pn, pt, pd = part
            body.append(f'<section class="partdiv"><div class="pn">{pn}</div>'
                        f'<h1 class="pt">{pt}</h1><p class="pd">{pd}</p></section>')
            toc.append(f'<li class="toc-part">{pn} · {pt}</li>')
        t = open(p, encoding="utf-8").read()
        m = re.search(r"^#\s*Chapter\s*\d+\s*[:—-]\s*(.+?)\s*$", t, re.M)
        title = m.group(1) if m else fn
        body.append(f'<section class="ch" id="g{i}">' + mb.md(t) + "</section>")
        toc.append(f'<li><a href="#g{i}"><span class="tn">{i}</span> {html.escape(title)}</a></li>')

    grid = open(os.path.join(GUIDE, "02-parallel-grid.md"), encoding="utf-8").read()
    body.append('<section class="ch" id="grid">' + mb.md(grid) + "</section>")
    toc.append('<li><a href="#grid"><span class="tn">·</span> The state grid (pull-out)</a></li>')

    doc = ('<!doctype html><html lang="en"><head><meta charset="utf-8">'
           '<title>Six Before Yes</title><style>' + CSS + '</style></head><body>'
           '<section class="title-pg"><div class="kick">Negotiators on Demand</div>'
           '<h1>Six Before Yes</h1>'
           '<p class="sub">Most negotiations are lost outside the room</p>'
           '<p class="by">Dan Cruz</p>'
           '<p class="cred">Seven years of practice · five hosting · 1,000+ live sessions · Chicago</p>'
           '<p class="draft">Working draft. Bracketed <code>[NEEDS:]</code> markers are slots for real<br>'
           'cases and named expert voices. Nothing in them is invented.</p></section>'
           '<section class="toc"><h1>Contents</h1><ul>' + "".join(toc) + '</ul></section>'
           + "".join(body) + '</body></html>')

    os.makedirs(BUILD, exist_ok=True)
    out = os.path.join(BUILD, "six-before-yes.html")
    open(out, "w", encoding="utf-8").write(doc)
    print("html:", out, f"({len(doc)//1024} KB)")
    return out


if __name__ == "__main__":
    build()
