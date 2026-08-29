#!/usr/bin/env python3
"""Compile the segmented chapters into a KDP-ready reflowable EPUB 3.

The chapters are authored split (chNNa = method, chNNb = practice) because that
suits drafting and the audio scripts. A reader should never see that seam, so
this rejoins each pair into one chapter and drops the "Part 1 of 2" scaffolding.

Run:  python3 book/tools/makeepub.py  ->  build/cruz-protocol-DRAFT.epub
"""
import glob, html, os, re, shutil, sys, zipfile
from datetime import date

ROOT  = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CH    = os.path.join(ROOT, "chapters")
BUILD = os.path.join(os.path.dirname(ROOT), "build")
STAGE = os.path.join(BUILD, "epub")

TITLE    = "The Cruz Protocol"
SUBTITLE = "A Field Manual for Commercial Negotiation"
AUTHOR   = "Dan Cruz"
UUID     = "urn:uuid:8f3a1c92-5d47-4e0b-9a61-cruzprotocol0001"
STATUS   = "DRAFT"

PARTS = {
    0: ("Part 0",   "The Standard",  "What the method is, and how to use it."),
    1: ("Part I",   "Read",          "Diagnose before you ask."),
    2: ("Part II",  "Disarm",        "Defuse before you steer."),
    3: ("Part III", "Steer",         "Move them without pressure."),
    4: ("Part IV",  "Close",         "Restraint as technique."),
    5: ("Part V",   "Applications",  "Where the buyer sees themselves."),
    6: ("Part VI",  "Installation",  "How it gets installed and audited."),
}

# The six drawn figures live in makebook.py, keyed by chapter. The EPUB
# shipped without any of them: the print build injected them and this one
# never looked. Inline SVG is legal in EPUB 3, but the pages are XHTML, so
# the element needs an explicit namespace that HTML lets you omit.
_HERE = os.path.dirname(os.path.abspath(__file__))
if _HERE not in sys.path:
    sys.path.insert(0, _HERE)
try:
    import makebook as _mb
    DIAGRAMS = _mb.DIAGRAMS
except Exception:
    DIAGRAMS = {}

SVG_NS = ' xmlns="http://www.w3.org/2000/svg"'


def with_ns(fig):
    return fig.replace("<svg ", "<svg" + SVG_NS + " ", 1) if "xmlns" not in fig else fig


def add_figure(num, body_html):
    """Place the chapter's figure after its first section heading, which is
    where the print build puts it."""
    fig = DIAGRAMS.get(num)
    if not fig:
        return body_html, False
    if "</h2>" in body_html:
        return body_html.replace("</h2>", "</h2>" + with_ns(fig), 1), True
    return with_ns(fig) + body_html, True


def part_of(n):
    return 0 if n <= 3 else 1 if n <= 9 else 2 if n <= 14 else 3 if n <= 20 \
        else 4 if n <= 25 else 5 if n <= 30 else 6

# ───────────────────────── inline markdown ─────────────────────────

def smarten(s):
    """Typographer's quotes for prose. Runs only on text that has already had
    its code spans stashed, and never on fenced blocks (those bypass inline()
    entirely), so literal quotes in scripts and cards are untouched.

    Double quotes alternate open/close statefully within the fragment rather
    than by lookbehind: context rules fail on this corpus's interrupted-speech
    endings ("so what if we—"), where a quote directly after an em dash must
    CLOSE. Alternation gets every balanced fragment right by construction.
    Apostrophes keep contextual rules — they are mostly not paired."""
    out, open_q = [], False
    for ch in s:
        if ch == '"':
            out.append("\u201c" if not open_q else "\u201d")
            open_q = not open_q
        else:
            out.append(ch)
    s = "".join(out)
    s = re.sub(r"(?<=[\w.,!?\u201d])'", "\u2019", s)   # can't, reps', …"'
    s = re.sub(r"(^|[\s\(\[\{—–\-*_])'(?=\w)", "\\1\u2018", s)
    s = s.replace("'", "\u2019")                        # anything left: closer
    return s

def inline(s):
    """Escape, then apply inline markup. Code spans are pulled out first so
    their contents never get treated as markup or smart-quoted."""
    spans = []
    def stash(m):
        spans.append(m.group(1))
        return f"\x00{len(spans)-1}\x00"
    s = re.sub(r"`([^`]+)`", stash, s)
    s = html.escape(s, quote=False)
    s = smarten(s)
    s = re.sub(r"\*\*(.+?)\*\*", r"<strong>\1</strong>", s)
    s = re.sub(r"(?<![\*\w])\*([^\*\n]+?)\*(?!\*)", r"<em>\1</em>", s)
    s = re.sub(r"\[([^\]]+)\]\((https?://[^\)]+)\)", r'<a href="\2">\1</a>', s)
    def pop(m):
        return "<code>" + html.escape(spans[int(m.group(1))], quote=False) + "</code>"
    return re.sub(r"\x00(\d+)\x00", pop, s)

# ───────────────────────── block markdown ─────────────────────────

def blocks(md):
    """Markdown -> XHTML fragments. Deliberately narrow: it handles exactly the
    constructs these chapters use, and nothing else."""
    out, i = [], 0
    lines = md.split("\n")
    while i < len(lines):
        ln = lines[i]

        # fenced block -> field card / script box
        if ln.startswith("```"):
            i += 1
            buf = []
            while i < len(lines) and not lines[i].startswith("```"):
                buf.append(lines[i]); i += 1
            i += 1
            body = html.escape("\n".join(buf), quote=False)
            # E-readers do not horizontal-scroll <pre>; a line that doesn't fit
            # is simply clipped. Step wide cards down so the widest line fits a
            # phone-sized column instead of losing its right edge.
            width = max((len(l) for l in buf), default=0)
            cls = "card wide" if width > 84 else "card"
            out.append(f'<pre class="{cls}">{body}</pre>')
            continue

        # table
        if ln.startswith("|"):
            rows = []
            while i < len(lines) and lines[i].startswith("|"):
                rows.append(lines[i]); i += 1
            cells = [[c.strip() for c in r.strip().strip("|").split("|")] for r in rows]
            cells = [c for c in cells if not all(re.fullmatch(r":?-{2,}:?", x or "-") for x in c)]
            if cells:
                head, body = cells[0], cells[1:]
                t = ['<table><thead><tr>']
                t += [f"<th>{inline(c)}</th>" for c in head]
                t.append("</tr></thead><tbody>")
                for r in body:
                    t.append("<tr>" + "".join(f"<td>{inline(c)}</td>" for c in r) + "</tr>")
                t.append("</tbody></table>")
                out.append('<div class="tw">' + "".join(t) + "</div>")
            continue

        # blockquote (evidence / gap callouts)
        if ln.startswith(">"):
            buf = []
            while i < len(lines) and (lines[i].startswith(">") or
                                      (buf and lines[i].strip() and not lines[i].startswith(("#", "|", "```", "-")))):
                buf.append(re.sub(r"^>\s?", "", lines[i])); i += 1
            inner = "\n".join(buf).strip()
            cls = "gap" if "[NEEDS:" in inner else "pull"
            # Collapse soft-wrapped lines inside a paragraph before inline markup:
            # bold and italic spans routinely straddle a line break in these
            # sources, and the inline regexes are not DOTALL by design (a stray
            # unmatched ** should not swallow the rest of the chapter).
            frag = blocks(inner) if any(inner.startswith(p) for p in ("#", "|", "```")) else \
                   "".join(f"<p>{inline(' '.join(p.split()))}</p>"
                           for p in re.split(r"\n\s*\n", inner) if p.strip())
            out.append(f'<blockquote class="{cls}">{frag}</blockquote>')
            continue

        # headings
        m = re.match(r"^(#{1,4})\s+(.*)$", ln)
        if m:
            lvl, txt = len(m.group(1)), m.group(2).strip()
            tag = {1: "h1", 2: "h2", 3: "h3", 4: "h4"}[lvl]
            cls = ' class="card-h"' if txt.upper().startswith("FIELD CARD") else ""
            out.append(f"<{tag}{cls}>{inline(txt)}</{tag}>")
            i += 1
            continue

        # horizontal rule
        if re.fullmatch(r"-{3,}|\*{3,}", ln.strip()):
            out.append('<hr class="sep" />'); i += 1; continue

        # lists
        if re.match(r"^\s*[-*]\s+", ln) or re.match(r"^\s*\d+\.\s+", ln):
            ordered = bool(re.match(r"^\s*\d+\.\s+", ln))
            items = []
            while i < len(lines) and (re.match(r"^\s*[-*]\s+", lines[i]) or
                                      re.match(r"^\s*\d+\.\s+", lines[i]) or
                                      (items and lines[i].startswith("  ") and lines[i].strip())):
                if re.match(r"^\s*[-*]\s+", lines[i]) or re.match(r"^\s*\d+\.\s+", lines[i]):
                    items.append(re.sub(r"^\s*(?:[-*]|\d+\.)\s+", "", lines[i]))
                else:
                    items[-1] += " " + lines[i].strip()
                i += 1
            tag = "ol" if ordered else "ul"
            out.append(f"<{tag}>" + "".join(f"<li>{inline(x)}</li>" for x in items) + f"</{tag}>")
            continue

        # paragraph
        if ln.strip():
            buf = []
            while i < len(lines) and lines[i].strip() and not lines[i].startswith(("#", "|", ">", "```")) \
                    and not re.fullmatch(r"-{3,}", lines[i].strip()) \
                    and not re.match(r"^\s*[-*]\s+", lines[i]) and not re.match(r"^\s*\d+\.\s+", lines[i]):
                buf.append(lines[i].strip()); i += 1
            text = " ".join(buf)
            cls = ' class="gap"' if "[NEEDS:" in text else ""
            out.append(f"<p{cls}>{inline(text)}</p>")
            continue
        i += 1
    return "".join(out)

# ───────────────────────── chapter assembly ─────────────────────────

def load_chapters():
    """Rejoin chNNa + chNNb into one chapter, dropping the split scaffolding."""
    found = {}
    for path in sorted(glob.glob(os.path.join(CH, "ch*.md"))):
        base = os.path.basename(path)
        m = re.match(r"ch(\d+)([ab])?-(.+)\.md$", base)
        if not m:
            continue
        num, seg = int(m.group(1)), (m.group(2) or "a")
        found.setdefault(num, {})[seg] = open(path, encoding="utf-8").read()

    chapters = []
    for num in sorted(found):
        segs = found[num]
        title = None
        body_parts = []
        for seg in ("a", "b"):
            if seg not in segs:
                continue
            md = segs[seg]
            # Headings are "# Chapter 8: Tactical Silence". This pattern
            # still required a dash, so every title came back None and
            # all 33 chapters shipped in the EPUB as bare "Chapter N".
            t = re.search(r"^#\s*Chapter\s*\d+\s*[:\u2014-]\s*(.+?)\s*$", md, re.M)
            if t and not title:
                title = t.group(1).strip()
            # strip the chapter h1, the "Part N of 2" subtitle, the part label,
            # the cross-reference note, and any leading rule
            md = re.sub(r"^#\s+Chapter.*$", "", md, flags=re.M)
            md = re.sub(r"^###\s+Part \d of \d.*$", "", md, flags=re.M)
            md = re.sub(r"^\*\*Part [0IVX]+\s*·.*$", "", md, flags=re.M)
            md = re.sub(r"^\*Part \d of \d covers.*$", "", md, flags=re.M)
            # Some [NEEDS:] markers are wrapped in backticks. As a code span the
            # contents render literally, so any emphasis inside shows its
            # asterisks. These are author notes rendered as callouts, not code —
            # unwrap them so they typeset as prose.
            md = re.sub(r"`(\[NEEDS:.*?\])`", r"\1", md, flags=re.S)
            md = md.strip()
            md = re.sub(r"\A(-{3,}\s*)+", "", md).strip()
            body_parts.append(md)
        chapters.append({
            "num": num,
            "title": title or f"Chapter {num}",
            "html": blocks("\n\n".join(body_parts)),
            "gaps": sum(p.count("[NEEDS:") for p in body_parts),
        })
    return chapters

# ───────────────────────── EPUB packaging ─────────────────────────

CSS = """
@page { margin: 1.2em; }
html { font-size: 100%; }
body { font-family: Georgia, "Times New Roman", serif; line-height: 1.55;
       margin: 0 5%; text-align: left; widows: 2; orphans: 2; }
h1, h2, h3, h4 { font-family: Georgia, serif; line-height: 1.2; page-break-after: avoid;
                 text-align: left; }
h1 { font-size: 1.7em; margin: 1.2em 0 .2em; }
h1.ch { margin-top: 0; }
figure.dia { margin: 1.4em 0; text-align: center; page-break-inside: avoid; }
figure.dia svg { width: 100%; height: auto; }
figure.dia figcaption { font-size: .82em; font-style: italic; color: #6b6252;
                        margin-top: .4em; text-align: center; }
.chnum { font-size: .72em; letter-spacing: .18em; text-transform: uppercase;
         color: #7a6a45; margin: 0 0 .3em; font-family: sans-serif; }
h2 { font-size: 1.2em; margin: 1.6em 0 .4em; border-bottom: 1px solid #d8d2c2;
     padding-bottom: .18em; }
h3 { font-size: 1.02em; margin: 1.2em 0 .3em; font-style: italic; }
h2.card-h { border-bottom: none; letter-spacing: .06em; font-size: 1.02em;
            text-transform: uppercase; font-family: sans-serif; margin-top: 1.8em; }
p { margin: 0 0 .75em; text-indent: 0; }
strong { font-weight: bold; }
ul, ol { margin: 0 0 .9em 1.3em; padding: 0; }
li { margin-bottom: .35em; }
hr.sep { border: none; border-top: 1px solid #d8d2c2; margin: 1.5em 15%; }
pre.card { font-family: "Courier New", monospace; font-size: .68em; line-height: 1.32;
           white-space: pre; overflow-x: auto; background: #f6f4ee;
           border: 1px solid #ddd6c4; border-left: 3px solid #b08b3f;
           padding: .7em .8em; margin: 1em 0; page-break-inside: avoid; }
pre.card.wide { font-size: .58em; line-height: 1.3; }
/* Phone-portrait columns are the only surface too narrow for a 78-char card.
   E-ink Kindles are >=758px and never match; KF8 and app readers honour
   media queries. Smaller but complete beats larger with the right edge cut. */
@media (max-width: 480px) {
  pre.card { font-size: .46em; padding: .6em .5em; }
}
blockquote.pull { margin: 1.1em 6%; padding-left: .9em; border-left: 3px solid #b08b3f;
                  font-style: italic; }
blockquote.gap, p.gap { background: #fdf6e3; border: 1px dashed #c9a227;
                        padding: .7em .8em; margin: 1em 0; font-size: .92em;
                        font-style: normal; }
blockquote.gap p { margin: 0 0 .4em; }
.tw { overflow-x: auto; margin: 1em 0; }
table { border-collapse: collapse; width: 100%; font-size: .84em; }
th, td { border: 1px solid #d8d2c2; padding: .35em .5em; text-align: left;
         vertical-align: top; }
th { background: #f2efe6; font-family: sans-serif; font-size: .92em; }
code { font-family: "Courier New", monospace; font-size: .9em; }
.center { text-align: center; }
.draft-band { border: 2px solid #a3341f; color: #a3341f; padding: .8em 1em;
              margin: 1.6em 0; text-align: center; font-family: sans-serif; }
.draft-band .big { font-size: 1.3em; letter-spacing: .22em; font-weight: bold; display: block; }
.tp-title { font-size: 2.3em; margin: 2.2em 0 .1em; text-align: center; line-height: 1.1; }
.tp-sub { text-align: center; font-style: italic; font-size: 1.05em; color: #5b5344;
          margin: 0 0 2em; }
.tp-author { text-align: center; letter-spacing: .2em; font-family: sans-serif;
             font-size: .95em; margin-top: 2.5em; }
.partpage { text-align: center; margin-top: 30%; }
.partpage .pnum { font-family: sans-serif; letter-spacing: .28em; font-size: .8em;
                  color: #7a6a45; }
.partpage h1 { font-size: 2.4em; margin: .2em 0; border: none; }
.partpage .psub { font-style: italic; color: #5b5344; }
nav ol { list-style: none; margin-left: 0; }
nav ol ol { margin-left: 1em; font-size: .95em; }
"""

def page(title, body, cls=""):
    return ('<?xml version="1.0" encoding="utf-8"?>\n'
            '<!DOCTYPE html>\n'
            '<html xmlns="http://www.w3.org/1999/xhtml" '
            'xmlns:epub="http://www.idpf.org/2007/ops" lang="en" xml:lang="en">\n'
            f'<head><meta charset="utf-8"/><title>{html.escape(title)}</title>'
            '<link rel="stylesheet" type="text/css" href="style.css"/></head>\n'
            f'<body class="{cls}">\n{body}\n</body>\n</html>\n')

def build():
    chapters = load_chapters()
    if not chapters:
        raise SystemExit("no chapters found")
    total_gaps = sum(c["gaps"] for c in chapters)

    if os.path.isdir(STAGE):
        shutil.rmtree(STAGE)
    oebps = os.path.join(STAGE, "OEBPS")
    os.makedirs(os.path.join(STAGE, "META-INF"))
    os.makedirs(oebps)

    with open(os.path.join(oebps, "style.css"), "w", encoding="utf-8") as f:
        f.write(CSS)

    cover_src = os.path.join(BUILD, "cover.jpg")
    has_cover = os.path.isfile(cover_src)
    if has_cover:
        shutil.copy(cover_src, os.path.join(oebps, "cover.jpg"))

    files = []   # (id, href, media-type, in_spine, nav_label, nav_level)
    svg_pages = set()   # pages carrying an inline figure, for the manifest

    if has_cover:
        with open(os.path.join(oebps, "cover.xhtml"), "w", encoding="utf-8") as f:
            f.write(page("Cover",
                         '<div class="center"><img src="cover.jpg" alt="Cover" '
                         'style="max-width:100%;height:auto"/></div>'))
        files.append(("cover", "cover.xhtml", "application/xhtml+xml", True, None, 0))

    today = date.today().isoformat()
    tp = (f'<h1 class="tp-title">{html.escape(TITLE)}</h1>'
          f'<p class="tp-sub">{html.escape(SUBTITLE)}</p>'
          f'<div class="draft-band"><span class="big">{STATUS}</span>'
          f'Working draft &#183; {today}<br/>'
          f'{total_gaps} passages still awaiting real field material.<br/>'
          f'Not for distribution.</div>'
          f'<p class="tp-author">{html.escape(AUTHOR)}</p>')
    with open(os.path.join(oebps, "title.xhtml"), "w", encoding="utf-8") as f:
        f.write(page("Title Page", tp))
    files.append(("title", "title.xhtml", "application/xhtml+xml", True, "Title Page", 0))

    seen_parts = set()
    for c in chapters:
        p = part_of(c["num"])
        if p not in seen_parts:
            seen_parts.add(p)
            label, name, blurb = PARTS[p]
            pid = f"part{p}"
            with open(os.path.join(oebps, f"{pid}.xhtml"), "w", encoding="utf-8") as f:
                f.write(page(f"{label}: {name}",
                             f'<div class="partpage"><p class="pnum">{html.escape(label)}</p>'
                             f'<h1>{html.escape(name)}</h1>'
                             f'<p class="psub">{html.escape(blurb)}</p></div>'))
            files.append((pid, f"{pid}.xhtml", "application/xhtml+xml", True,
                          f"{label}: {name}", 0))

        cid = f"ch{c['num']:02d}"
        chapter_html, has_svg = add_figure(c["num"], c["html"])
        if has_svg:
            svg_pages.add(cid)
        body = (f'<p class="chnum">Chapter {c["num"]}</p>'
                f'<h1 class="ch">{html.escape(c["title"])}</h1>' + chapter_html)
        with open(os.path.join(oebps, f"{cid}.xhtml"), "w", encoding="utf-8") as f:
            f.write(page(f"Chapter {c['num']}: {c['title']}", body))
        files.append((cid, f"{cid}.xhtml", "application/xhtml+xml", True,
                      f"{c['num']}. {c['title']}", 1))

    # back matter: the open evidence list, so the draft carries its own to-do
    rows = "".join(
        f"<tr><td>{c['num']}</td><td>{html.escape(c['title'])}</td>"
        f"<td>{c['gaps']}</td></tr>"
        for c in chapters if c["gaps"])
    back = ('<h1>Open Evidence</h1>'
            f'<p>This draft carries <strong>{total_gaps}</strong> passages marked '
            '<code>[NEEDS:]</code>, places where a real client situation, number, '
            'or outcome belongs. Nothing in the manual is invented, which is why '
            'these are blank rather than filled with plausible examples.</p>'
            '<div class="tw"><table><thead><tr><th>Ch</th><th>Chapter</th>'
            '<th>Open</th></tr></thead><tbody>' + rows + '</tbody></table></div>')
    with open(os.path.join(oebps, "back.xhtml"), "w", encoding="utf-8") as f:
        f.write(page("Open Evidence", back))
    files.append(("back", "back.xhtml", "application/xhtml+xml", True, "Open Evidence", 0))

    # nav
    items = []
    for _id, href, _mt, _sp, label, lvl in files:
        if not label:
            continue
        items.append((lvl, label, href))
    nav_li = []
    i = 0
    while i < len(items):
        lvl, label, href = items[i]
        if lvl == 0:
            kids = []
            j = i + 1
            while j < len(items) and items[j][0] == 1:
                kids.append(items[j]); j += 1
            sub = ""
            if kids:
                sub = "<ol>" + "".join(
                    f'<li><a href="{k[2]}">{html.escape(k[1])}</a></li>' for k in kids) + "</ol>"
            nav_li.append(f'<li><a href="{href}">{html.escape(label)}</a>{sub}</li>')
            i = j
        else:
            nav_li.append(f'<li><a href="{href}">{html.escape(label)}</a></li>')
            i += 1
    nav_body = ('<nav epub:type="toc" id="toc"><h1>Contents</h1><ol>'
                + "".join(nav_li) + '</ol></nav>')
    with open(os.path.join(oebps, "nav.xhtml"), "w", encoding="utf-8") as f:
        f.write(page("Contents", nav_body))

    # ncx (KDP still likes it)
    pts, order = [], 1
    for _id, href, _mt, _sp, label, lvl in files:
        if not label:
            continue
        pts.append(f'<navPoint id="n{order}" playOrder="{order}">'
                   f'<navLabel><text>{html.escape(label)}</text></navLabel>'
                   f'<content src="{href}"/></navPoint>')
        order += 1
    ncx = ('<?xml version="1.0" encoding="utf-8"?>\n'
           '<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">\n'
           f'<head><meta name="dtb:uid" content="{UUID}"/></head>\n'
           f'<docTitle><text>{html.escape(TITLE)}</text></docTitle>\n'
           '<navMap>' + "".join(pts) + '</navMap>\n</ncx>\n')
    with open(os.path.join(oebps, "toc.ncx"), "w", encoding="utf-8") as f:
        f.write(ncx)

    # opf
    manifest = ['<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>',
                '<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>',
                '<item id="css" href="style.css" media-type="text/css"/>']
    if has_cover:
        manifest.append('<item id="coverimg" href="cover.jpg" media-type="image/jpeg" '
                        'properties="cover-image"/>')
    spine = []
    for _id, href, mt, in_spine, _l, _lv in files:
        props = ' properties="svg"' if _id in svg_pages else ''
        manifest.append(f'<item id="{_id}" href="{href}" media-type="{mt}"{props}/>')
        if in_spine:
            spine.append(f'<itemref idref="{_id}"/>')

    opf = ('<?xml version="1.0" encoding="utf-8"?>\n'
           '<package xmlns="http://www.idpf.org/2007/opf" version="3.0" '
           'unique-identifier="bookid" xml:lang="en">\n'
           '<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">\n'
           f'<dc:identifier id="bookid">{UUID}</dc:identifier>\n'
           f'<dc:title>{html.escape(TITLE)}: {html.escape(SUBTITLE)} ({STATUS})</dc:title>\n'
           f'<dc:creator>{html.escape(AUTHOR)}</dc:creator>\n'
           '<dc:language>en</dc:language>\n'
           f'<dc:date>{today}</dc:date>\n'
           f'<dc:description>{html.escape(SUBTITLE)}. Working draft. '
           f'{total_gaps} passages awaiting real field material.</dc:description>\n'
           f'<meta property="dcterms:modified">{today}T00:00:00Z</meta>\n'
           + ('<meta name="cover" content="coverimg"/>\n' if has_cover else '') +
           '</metadata>\n<manifest>\n' + "\n".join(manifest) +
           '\n</manifest>\n<spine toc="ncx">\n' + "\n".join(spine) +
           '\n</spine>\n</package>\n')
    with open(os.path.join(oebps, "content.opf"), "w", encoding="utf-8") as f:
        f.write(opf)

    with open(os.path.join(STAGE, "META-INF", "container.xml"), "w", encoding="utf-8") as f:
        f.write('<?xml version="1.0" encoding="utf-8"?>\n'
                '<container version="1.0" '
                'xmlns="urn:oasis:names:tc:opendocument:xmlns:container">\n'
                '<rootfiles><rootfile full-path="OEBPS/content.opf" '
                'media-type="application/oebps-package+xml"/></rootfiles>\n</container>\n')

    out = os.path.join(BUILD, f"cruz-protocol-{STATUS}.epub")
    if os.path.exists(out):
        os.remove(out)
    # mimetype must be first and stored uncompressed
    with zipfile.ZipFile(out, "w") as z:
        z.writestr(zipfile.ZipInfo("mimetype"), "application/epub+zip",
                   compress_type=zipfile.ZIP_STORED)
        for folder, _dirs, fs in os.walk(STAGE):
            for fn in sorted(fs):
                full = os.path.join(folder, fn)
                rel = os.path.relpath(full, STAGE).replace(os.sep, "/")
                z.write(full, rel, compress_type=zipfile.ZIP_DEFLATED)

    kb = os.path.getsize(out) // 1024
    print(f"epub: {out} ({kb} KB)")
    print(f"chapters: {len(chapters)}  open [NEEDS:]: {total_gaps}  "
          f"cover: {'yes' if has_cover else 'MISSING'}")
    return out

if __name__ == "__main__":
    build()
