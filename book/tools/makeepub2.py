#!/usr/bin/env python3
"""KDP-ready reflowable EPUBs for the newer books, on the manual's renderer.

Reuses makeepub.py's markdown pipeline, stylesheet, and page shell so all
the series EPUBs share one hand. Book structure comes from the SPECS table.

    python3 book/tools/makeepub2.py guide      -> build/six-before-yes-DRAFT.epub
    python3 book/tools/makeepub2.py everyday   -> build/same-words-bigger-rooms-DRAFT.epub
    python3 book/tools/makeepub2.py drillbook  -> build/the-drill-book-DRAFT.epub
    python3 book/tools/makeepub2.py            -> both
"""
import glob, html, os, re, shutil, sys, zipfile
from datetime import date

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import makeepub as ep

ROOT = os.path.dirname(os.path.dirname(HERE))
BUILD = os.path.join(ROOT, "build")
STATUS = "DRAFT"
AUTHOR = "Dan Cruz"


def everyday_files():
    """(path, part_tuple_or_None, nav_label, nav_level) in spine order."""
    b = os.path.join(ROOT, "everyday")
    parts = {
        1: ("Part I", "The Kitchen Table"),
        4: ("Part II", "Your Money"),
        8: ("Part III", "The Middle Rooms"),
        11: ("Part IV", "The Big Rooms"),
    }
    out = [(os.path.join(b, "front-matter.md"), None, "Front Matter", 0)]
    for p in sorted(glob.glob(os.path.join(b, "ch*.md"))):
        m = re.search(r"^#\s*Chapter\s*(\d+):\s*(.+?)\s*$",
                      open(p, encoding="utf-8").read(), re.M)
        n, title = int(m.group(1)), m.group(2)
        out.append((p, parts.get(n), f"{n}. {title}", 1))
    out.sort(key=lambda e: (0 if e[3] == 0 and "front" in e[0] else 1,
                            int(re.search(r"ch(\d+)", e[0]).group(1))
                            if re.search(r"ch(\d+)", e[0]) else 0))
    out.append((os.path.join(b, "back-matter.md"), None, "Back Matter", 0))
    return out


def drillbook_files():
    b = os.path.join(ROOT, "drillbook")
    groups = [("Part I", "Solo", ("Solo",)),
              ("Part II", "Pairs", ("Pairs",)),
              ("Part III", "The Room", ("The room",)),
              ("Part IV", "Live Fire", ("Live fire",))]
    out = [(os.path.join(b, "front-matter.md"), None, "Front Matter", 0),
           (os.path.join(b, "01-how-to-run-a-drill.md"), None, "How to Run a Drill", 0),
           (os.path.join(b, "02-the-two-indexes.md"), None, "The Two Indexes", 0)]
    drills = []
    for p in sorted(glob.glob(os.path.join(b, "drills", "drill-*.md"))):
        t = open(p, encoding="utf-8").read()
        num = int(re.search(r"^# Drill (\d+):", t, re.M).group(1))
        name = re.search(r"^# Drill \d+:\s*(.+?)\s*$", t, re.M).group(1)
        part = re.search(r"^STAGE .*?PART\s+(.+?)\s*$", t, re.M).group(1)
        drills.append((num, name, part, p))
    for label, name, keys in groups:
        first = True
        for num, dname, part, p in sorted(drills):
            if any(part.startswith(k) for k in keys):
                out.append((p, (label, name) if first else None,
                            f"{num:02d}. {dname}", 1))
                first = False
    out.append((os.path.join(b, "03-the-programs.md"),
                ("Part V", "The Programs"), "The Programs", 0))
    out.append((os.path.join(b, "back-matter.md"), None, "Back Matter", 0))
    return out


# The guide's seven figures live in makeguide.py, keyed by chapter, and its
# chapters carry a prose placeholder the print build swaps out. Without the
# swap the spec text ships as body copy, which is what an unfixed EPUB did.
GUIDE_FIGS = {}
try:
    sys.path.insert(0, os.path.join(ROOT, "guide", "tools"))
    import makeguide as _mg
    GUIDE_FIGS = _mg.DIAGRAMS
except Exception:
    pass

FIG_PLACEHOLDER = re.compile(r"(?s)\*\[(?:Master f|F)igure\b.*?\]\*")


def swap_guide_figure(path, md):
    """Return (markdown, figure_html_or_None) for a guide chapter."""
    m = re.search(r"ch(\d+)", os.path.basename(path))
    if not m or not GUIDE_FIGS:
        return md, None
    # Same opener scaffolding the print build consumes, from the same helper,
    # so the two editions cannot drift on what a chapter opens with.
    if hasattr(_mg, "strip_scaffolding"):
        md = _mg.strip_scaffolding(md)
    fig = GUIDE_FIGS.get(int(m.group(1)))
    if not fig or not FIG_PLACEHOLDER.search(md):
        return md, None
    return FIG_PLACEHOLDER.sub("%%FIG%%", md, count=1), ep.with_ns(fig)


def guide_files():
    """Six Before Yes. The one-page method summary and the parallel grid are
    reference spreads, so they bracket the chapters the way the print build
    orders them."""
    b = os.path.join(ROOT, "guide")
    parts = {
        2: ("Part 1", "Prepare"),
        5: ("Part 2", "Engage"),
        7: ("Part 3", "Consolidate"),
    }
    out = [(os.path.join(b, "front-matter.md"), None, "Front Matter", 0),
           (os.path.join(b, "01-method-summary.md"), None, "The Method, on One Page", 0)]
    for p in sorted(glob.glob(os.path.join(b, "ch*.md")),
                    key=lambda x: int(re.search(r"ch(\d+)", x).group(1))):
        m = re.search(r"^#\s*Chapter\s*(\d+):\s*(.+?)\s*$",
                      open(p, encoding="utf-8").read(), re.M)
        n, title = int(m.group(1)), m.group(2)
        out.append((p, parts.get(n), f"{n}. {title}", 1))
    out.append((os.path.join(b, "02-parallel-grid.md"), None, "The Parallel Grid", 0))
    out.append((os.path.join(b, "back-matter.md"), None, "Back Matter", 0))
    return out


SPECS = {
    "guide": dict(
        title="Six Before Yes",
        subtitle="The six moves that decide a negotiation before anyone says yes",
        uuid="urn:uuid:8f3a1c92-5d47-4e0b-9a61-sixbeforeyes0002",
        out="six-before-yes",
        files=guide_files,
    ),
    "everyday": dict(
        title="Same Words, Bigger Rooms",
        subtitle="Negotiation from the kitchen table to the closing room",
        uuid="urn:uuid:8f3a1c92-5d47-4e0b-9a61-samewordsbig0004",
        out="same-words-bigger-rooms",
        files=everyday_files,
    ),
    "drillbook": dict(
        title="The Drill Book",
        subtitle="The practice curriculum for the Protocol",
        uuid="urn:uuid:8f3a1c92-5d47-4e0b-9a61-thedrillbook0003",
        out="the-drill-book",
        files=drillbook_files,
    ),
}


def render(path):
    md = open(path, encoding="utf-8").read()
    gaps = len(re.findall(r"\[NEEDS:", md))
    m = re.search(r"^#\s*(.+?)\s*$", md, re.M)
    title = m.group(1) if m else os.path.basename(path)
    md = re.sub(r"^#\s.+?\n", "", md, count=1)
    md = re.sub(r"^\*[^\n]*series pattern[^\n]*\*\n", "", md, flags=re.M)
    # The method summary carries the master figure's written spec, which the
    # print build drops because the figure itself exists. Same here.
    md = md.split("### Master figure (spec)")[0].rstrip().rstrip("-").rstrip()
    md, fig = swap_guide_figure(path, md)
    body = ep.blocks(md)
    if fig:
        body = body.replace("<p>%%FIG%%</p>", fig, 1)
    if "%%FIG%%" in body:
        raise SystemExit(f"{os.path.basename(path)}: figure marker survived the render")
    return title, body, gaps


def build(key):
    spec = SPECS[key]
    stage = os.path.join(BUILD, f"epub-{key}")
    if os.path.isdir(stage):
        shutil.rmtree(stage)
    oebps = os.path.join(stage, "OEBPS")
    os.makedirs(os.path.join(stage, "META-INF"))
    os.makedirs(oebps)
    open(os.path.join(oebps, "style.css"), "w", encoding="utf-8").write(ep.CSS)

    today = date.today().isoformat()
    entries = spec["files"]()
    total_gaps = sum(len(re.findall(r"\[NEEDS:", open(p, encoding="utf-8").read()))
                     for p, *_ in entries)

    files = []
    tp = (f'<h1 class="tp-title">{html.escape(spec["title"])}</h1>'
          f'<p class="tp-sub">{html.escape(spec["subtitle"])}</p>'
          f'<div class="draft-band"><span class="big">{STATUS}</span>'
          f'Working draft &#183; {today}<br/>'
          f'{total_gaps} passages still awaiting real material.<br/>'
          f'Not for distribution.</div>'
          f'<p class="tp-author">{html.escape(AUTHOR)}</p>')
    open(os.path.join(oebps, "title.xhtml"), "w", encoding="utf-8").write(
        ep.page("Title Page", tp))
    files.append(("title", "title.xhtml", "application/xhtml+xml", True,
                  "Title Page", 0))

    pn = 0
    svg_pages = set()   # pages carrying an inline figure, for the manifest
    for i, (path, part, label, level) in enumerate(entries):
        if part:
            pn += 1
            plabel, pname = part
            pid = f"part{pn}"
            open(os.path.join(oebps, f"{pid}.xhtml"), "w", encoding="utf-8").write(
                ep.page(f"{plabel}: {pname}",
                        f'<div class="partpage"><p class="pnum">{html.escape(plabel)}</p>'
                        f'<h1>{html.escape(pname)}</h1></div>'))
            files.append((pid, f"{pid}.xhtml", "application/xhtml+xml", True,
                          f"{plabel}: {pname}", 0))
        title, body, _g = render(path)
        fid = f"s{i:02d}"
        if "<svg" in body:
            svg_pages.add(fid)
        open(os.path.join(oebps, f"{fid}.xhtml"), "w", encoding="utf-8").write(
            ep.page(title, f'<h1 class="ch">{html.escape(title)}</h1>' + body))
        files.append((fid, f"{fid}.xhtml", "application/xhtml+xml", True,
                      label, level))

    # nav
    items = [(lvl, lab, href) for _i, href, _m, _s, lab, lvl in files if lab]
    nav_li, i = [], 0
    while i < len(items):
        lvl, label, href = items[i]
        if lvl == 0:
            kids, j = [], i + 1
            while j < len(items) and items[j][0] == 1:
                kids.append(items[j]); j += 1
            sub = ("<ol>" + "".join(
                f'<li><a href="{k[2]}">{html.escape(k[1])}</a></li>' for k in kids)
                + "</ol>") if kids else ""
            nav_li.append(f'<li><a href="{href}">{html.escape(label)}</a>{sub}</li>')
            i = j
        else:
            nav_li.append(f'<li><a href="{href}">{html.escape(label)}</a></li>')
            i += 1
    open(os.path.join(oebps, "nav.xhtml"), "w", encoding="utf-8").write(
        ep.page("Contents", '<nav epub:type="toc" id="toc"><h1>Contents</h1><ol>'
                + "".join(nav_li) + '</ol></nav>'))

    pts = [f'<navPoint id="n{o}" playOrder="{o}">'
           f'<navLabel><text>{html.escape(lab)}</text></navLabel>'
           f'<content src="{href}"/></navPoint>'
           for o, (_l, lab, href) in enumerate(items, 1)]
    open(os.path.join(oebps, "toc.ncx"), "w", encoding="utf-8").write(
        '<?xml version="1.0" encoding="utf-8"?>\n'
        '<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">\n'
        f'<head><meta name="dtb:uid" content="{spec["uuid"]}"/></head>\n'
        f'<docTitle><text>{html.escape(spec["title"])}</text></docTitle>\n'
        '<navMap>' + "".join(pts) + '</navMap>\n</ncx>\n')

    manifest = ['<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>',
                '<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>',
                '<item id="css" href="style.css" media-type="text/css"/>']
    spine = []
    for fid, href, mt, in_spine, _l, _lv in files:
        props = ' properties="svg"' if fid in svg_pages else ''
        manifest.append(f'<item id="{fid}" href="{href}" media-type="{mt}"{props}/>')
        if in_spine:
            spine.append(f'<itemref idref="{fid}"/>')
    open(os.path.join(oebps, "content.opf"), "w", encoding="utf-8").write(
        '<?xml version="1.0" encoding="utf-8"?>\n'
        '<package xmlns="http://www.idpf.org/2007/opf" version="3.0" '
        'unique-identifier="bookid" xml:lang="en">\n'
        '<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">\n'
        f'<dc:identifier id="bookid">{spec["uuid"]}</dc:identifier>\n'
        f'<dc:title>{html.escape(spec["title"])}: {html.escape(spec["subtitle"])} ({STATUS})</dc:title>\n'
        f'<dc:creator>{html.escape(AUTHOR)}</dc:creator>\n'
        '<dc:language>en</dc:language>\n'
        f'<dc:date>{today}</dc:date>\n'
        f'<dc:description>{html.escape(spec["subtitle"])}. Working draft, '
        f'{total_gaps} passages awaiting real material.</dc:description>\n'
        f'<meta property="dcterms:modified">{today}T00:00:00Z</meta>\n'
        '</metadata>\n<manifest>\n' + "\n".join(manifest) +
        '\n</manifest>\n<spine toc="ncx">\n' + "\n".join(spine) +
        '\n</spine>\n</package>\n')

    open(os.path.join(stage, "META-INF", "container.xml"), "w", encoding="utf-8").write(
        '<?xml version="1.0" encoding="utf-8"?>\n'
        '<container version="1.0" '
        'xmlns="urn:oasis:names:tc:opendocument:xmlns:container">\n'
        '<rootfiles><rootfile full-path="OEBPS/content.opf" '
        'media-type="application/oebps-package+xml"/></rootfiles>\n</container>\n')

    out = os.path.join(BUILD, f'{spec["out"]}-{STATUS}.epub')
    if os.path.exists(out):
        os.remove(out)
    with zipfile.ZipFile(out, "w") as z:
        z.writestr(zipfile.ZipInfo("mimetype"), "application/epub+zip",
                   compress_type=zipfile.ZIP_STORED)
        for folder, _d, fs in os.walk(stage):
            for fn in sorted(fs):
                full = os.path.join(folder, fn)
                rel = os.path.relpath(full, stage).replace(os.sep, "/")
                z.write(full, rel, compress_type=zipfile.ZIP_DEFLATED)
    print(f'epub: {out} ({os.path.getsize(out)//1024} KB) '
          f'sections: {len(entries)}  open [NEEDS:]: {total_gaps}')
    return out


if __name__ == "__main__":
    keys = sys.argv[1:] or list(SPECS)
    for k in keys:
        build(k)
