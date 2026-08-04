#!/usr/bin/env python3
"""Compile the segmented chapters into a print-ready HTML book.

ASCII field cards become styled HTML cards. Adds SVG diagrams.
Run:  python3 book/tools/makebook.py  ->  build/cruz-protocol.html
"""
import glob, html, os, re, sys

ROOT  = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CH    = os.path.join(ROOT, "chapters")
BUILD = os.path.join(os.path.dirname(ROOT), "build")

PARTS = {0:("Part 0","The Standard","What the method is, and how to use it."),
         1:("Part I","Read","Diagnose before you ask."),
         2:("Part II","Disarm","Defuse before you steer."),
         3:("Part III","Steer","Move them without pressure."),
         4:("Part IV","Close","Restraint as technique."),
         5:("Part V","Applications","Where the buyer sees themselves."),
         6:("Part VI","Installation","How it gets installed and audited.")}

def part_of(n):
    return 0 if n<=3 else 1 if n<=9 else 2 if n<=14 else 3 if n<=20 else 4 if n<=25 else 5 if n<=30 else 6

# ---------- field card parsing ----------
BOX = "┌┐└┘├┤─│"

def parse_card(block):
    lines = [l for l in block.split("\n") if l.strip()]
    inner = []
    for l in lines:
        s = l.strip()
        if not s or set(s) <= set(BOX+" "):
            continue
        s = s.strip("│").rstrip()
        if set(s.strip()) <= set(BOX+" ") and s.strip():
            continue
        inner.append(s)
    if not inner:
        return None
    # header: TITLE ....... Part X · STAGE
    head = inner[0].strip()
    m = re.match(r"^(.*?)\s{2,}(Part .*)$", head)
    title, tag = (m.group(1).strip(), m.group(2).strip()) if m else (head, "")
    rows, lead, cur = [], [], None
    for l in inner[1:]:
        if not l.strip():
            continue
        body = l[2:] if l.startswith("  ") else l
        m = re.match(r"^([A-Z][A-Z0-9'&\-\? ]{1,13})\s{2,}(.*)$", body.strip())
        if m and len(m.group(1).strip()) >= 2:
            if cur: rows.append(cur)
            cur = [m.group(1).strip(), [m.group(2).strip()]]
        elif cur is not None:
            cur[1].append(body.strip())
        else:
            lead.append(body.strip())
    if cur: rows.append(cur)
    # rejoin lines that are soft wraps rather than separate items
    for r in rows:
        merged = []
        for v in r[1]:
            if merged and v[:1].islower() and merged[-1] and merged[-1][-1] not in ".!?\u2014":
                merged[-1] = merged[-1] + " " + v
            elif merged and merged[-1].endswith("\u2014"):
                merged[-1] = merged[-1] + " " + v
            elif merged and merged[-1].count('"') % 2 == 1:
                merged[-1] = merged[-1] + " " + v
            else:
                merged.append(v)
        r[1] = merged
    return {"title": title, "tag": tag, "lead": " ".join(lead), "rows": rows}

def card_html(c):
    out = [f'<div class="card"><div class="card-h"><span class="card-t">{html.escape(c["title"])}</span>']
    if c["tag"]:
        out.append(f'<span class="card-tag">{html.escape(c["tag"])}</span>')
    out.append("</div>")
    if c["lead"]:
        out.append(f'<p class="card-lead">{html.escape(c["lead"])}</p>')
    if c["rows"]:
        out.append('<dl class="card-rows">')
        for label, vals in c["rows"]:
            txt = "<br>".join(html.escape(v) for v in vals if v)
            out.append(f"<dt>{html.escape(label)}</dt><dd>{txt}</dd>")
        out.append("</dl>")
    out.append("</div>")
    return "\n".join(out)

# ---------- markdown ----------
def md(t):
    out, i, lines = [], 0, t.split("\n")
    while i < len(lines):
        l = lines[i]
        if l.strip().startswith("```"):
            j, buf = i+1, []
            while j < len(lines) and not lines[j].strip().startswith("```"):
                buf.append(lines[j]); j += 1
            block = "\n".join(buf)
            if "┌" in block:
                c = parse_card(block)
                out.append(card_html(c) if c else "")
            else:
                out.append('<pre class="script">'+html.escape(block)+"</pre>")
            i = j+1; continue
        if l.strip().startswith("|"):
            j, buf = i, []
            while j < len(lines) and lines[j].strip().startswith("|"):
                buf.append(lines[j]); j += 1
            rows = [r.strip().strip("|").split("|") for r in buf]
            rows = [r for r in rows if not all(set(c.strip()) <= set("-: ") for c in r)]
            if rows:
                out.append("<table><thead><tr>"+"".join(f"<th>{inline(c.strip())}</th>" for c in rows[0])+"</tr></thead><tbody>")
                for r in rows[1:]:
                    out.append("<tr>"+"".join(f"<td>{inline(c.strip())}</td>" for c in r)+"</tr>")
                out.append("</tbody></table>")
            i = j; continue
        if re.match(r"^\s*>\s?", l):
            j, buf = i, []
            while j < len(lines) and (re.match(r"^\s*>", lines[j]) or (buf and lines[j].strip()=="" and j+1<len(lines) and re.match(r"^\s*>", lines[j+1]))):
                buf.append(re.sub(r"^\s*>\s?","",lines[j])); j += 1
            out.append('<blockquote>'+md("\n".join(buf))+'</blockquote>'); i = j; continue
        m = re.match(r"^(#{1,6})\s+(.*)$", l)
        if m:
            if re.match(r"^FIELD CARD\b", m.group(2).strip(), re.I):
                i += 1; continue
            lv = len(m.group(1)); out.append(f"<h{lv}>{inline(m.group(2))}</h{lv}>"); i += 1; continue
        if re.match(r"^\s*[-*]\s+", l):
            j, buf = i, []
            while j < len(lines) and re.match(r"^\s*[-*]\s+", lines[j]):
                buf.append(re.sub(r"^\s*[-*]\s+","",lines[j])); j += 1
            out.append("<ul>"+"".join(f"<li>{inline(b)}</li>" for b in buf)+"</ul>"); i = j; continue
        if re.match(r"^\s*\d+\.\s+", l):
            j, buf = i, []
            while j < len(lines) and re.match(r"^\s*\d+\.\s+", lines[j]):
                buf.append(re.sub(r"^\s*\d+\.\s+","",lines[j])); j += 1
            out.append("<ol>"+"".join(f"<li>{inline(b)}</li>" for b in buf)+"</ol>"); i = j; continue
        if re.match(r"^---+\s*$", l):
            i += 1; continue
        if l.strip():
            j, buf = i, []
            while j < len(lines) and lines[j].strip() and not re.match(r"^(#{1,6}\s|\s*[-*]\s|\s*\d+\.\s|\||>|```|---+\s*$)", lines[j]):
                buf.append(lines[j].strip()); j += 1
            out.append("<p>"+inline(" ".join(buf))+"</p>"); i = j; continue
        i += 1
    return "\n".join(x for x in out if x)

def inline(s):
    s = html.escape(s)
    s = re.sub(r"`([^`]+)`", r"<code>\1</code>", s)
    s = re.sub(r"\*\*(.+?)\*\*", r"<strong>\1</strong>", s)
    s = re.sub(r"(?<!\*)\*([^*]+)\*(?!\*)", r"<em>\1</em>", s)
    return s

DIAGRAMS = {2: '''<figure class="dia"><svg viewBox="0 0 720 150" role="img" aria-label="Read, Disarm, Steer, Close in sequence">
<defs><marker id="a" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6" fill="none" stroke="#8a6a2f" stroke-width="1.4"/></marker></defs>
''' + "".join(
 f'<g><rect x="{10+178*i}" y="30" width="150" height="76" rx="7" fill="#fdfbf6" stroke="#8a6a2f" stroke-width="1.4"/>'
 f'<text x="{85+178*i}" y="56" text-anchor="middle" font-size="15" font-weight="700" fill="#2a2317">{n}</text>'
 f'<text x="{85+178*i}" y="78" text-anchor="middle" font-size="10.5" fill="#5b5343">{d}</text>'
 f'<text x="{85+178*i}" y="94" text-anchor="middle" font-size="9" fill="#8a6a2f">Ch {c}</text></g>'
 + (f'<line x1="{162+178*i}" y1="68" x2="{182+178*i}" y2="68" stroke="#8a6a2f" stroke-width="1.4" marker-end="url(#a)"/>' if i<3 else '')
 for i,(n,d,c) in enumerate([("READ","diagnose","4–9"),("DISARM","defuse","10–14"),("STEER","redirect","15–20"),("CLOSE","resolve","21–25")])
) + '''<text x="360" y="132" text-anchor="middle" font-size="10" fill="#5b5343" font-style="italic">In order. Every time. Each stage produces the input the next one requires.</text>
</svg><figcaption>The four stages.</figcaption></figure>''',
 19: '''<figure class="dia"><svg viewBox="0 0 620 220" role="img" aria-label="Ackerman ladder with decelerating steps">
<line x1="70" y1="185" x2="590" y2="185" stroke="#c9bfa8" stroke-width="1"/>
''' + "".join(
 f'<g><rect x="{92+120*i}" y="{185-h}" width="72" height="{h}" rx="4" fill="#fdfbf6" stroke="#8a6a2f" stroke-width="1.4"/>'
 f'<text x="{128+120*i}" y="{178-h}" text-anchor="middle" font-size="13" font-weight="700" fill="#2a2317">{p}%</text>'
 f'<text x="{128+120*i}" y="200" text-anchor="middle" font-size="9.5" fill="#5b5343">step {i+1}</text></g>'
 for i,(p,h) in enumerate([(65,70),(85,95),(95,110),(100,118)])
) + '''<text x="200" y="42" text-anchor="middle" font-size="11" font-weight="600" fill="#8a6a2f">+20</text>
<text x="320" y="42" text-anchor="middle" font-size="11" font-weight="600" fill="#8a6a2f">+10</text>
<text x="440" y="42" text-anchor="middle" font-size="11" font-weight="600" fill="#8a6a2f">+5</text>
<text x="310" y="18" text-anchor="middle" font-size="10.5" fill="#5b5343" font-style="italic">Steps must decelerate — that shrinking gap is the signal there is a floor.</text>
</svg><figcaption>The Ackerman ladder. End on a non-round number.</figcaption></figure>'''}

def build():
    files = sorted(glob.glob(os.path.join(CH,"ch*.md")),
                   key=lambda f:(int(re.search(r"ch(\d+)",os.path.basename(f)).group(1)),
                                 re.search(r"ch\d+([ab])?",os.path.basename(f)).group(1) or "a"))
    chapters = {}
    for f in files:
        n = int(re.search(r"ch(\d+)",os.path.basename(f)).group(1))
        chapters.setdefault(n,[]).append(open(f,encoding="utf-8").read())

    body, toc, cur = [], [], None
    for n in sorted(chapters):
        p = part_of(n)
        if p != cur:
            pn, pt, pd = PARTS[p]
            body.append(f'<section class="partdiv"><div class="pn">{pn}</div><h1 class="pt">{pt}</h1><p class="pd">{pd}</p></section>')
            toc.append(f'<li class="toc-part">{pn} · {pt}</li>')
            cur = p
        txt = chapters[n][0]
        for extra in chapters[n][1:]:
            extra = re.sub(r"(?s)^#\s*Chapter.*?\n---\n","",extra,count=1)
            txt += "\n\n" + extra
        txt = re.sub(r"(?m)^### Part \d of 2 · .*$","",txt)
        txt = re.sub(r"(?m)^\*Continues in Part 2 of 2.*$","",txt)
        txt = re.sub(r"(?m)^\*Part 1 of 2 covers.*$","",txt)
        title = re.search(r"^#\s*Chapter\s*\d+\s*[—-]\s*(.+?)\s*$",txt,re.M).group(1)
        h = md(txt)
        if n in DIAGRAMS:
            h = h.replace("</h2>","</h2>\n"+DIAGRAMS[n],1)
        body.append(f'<section class="ch" id="ch{n}">{h}</section>')
        toc.append(f'<li><a href="#ch{n}"><span class="tn">{n}</span> {html.escape(title)}</a></li>')

    css = """
@page { size: A4; margin: 20mm 18mm; }
:root{--ink:#2a2317;--dim:#5b5343;--gold:#8a6a2f;--line:#ddd4c0;--bg:#fffdf8;}
*{box-sizing:border-box}
body{font:11.2pt/1.62 Georgia,'Times New Roman',serif;color:var(--ink);background:var(--bg);margin:0}
h1,h2,h3,h4{font-family:'Helvetica Neue',Arial,sans-serif;line-height:1.24}
h1{font-size:23pt;margin:0 0 6pt;letter-spacing:-.2pt}
h2{font-size:13pt;margin:20pt 0 7pt;color:var(--gold);text-transform:uppercase;letter-spacing:.09em;font-weight:700}
h3{font-size:11.6pt;margin:14pt 0 5pt}
p{margin:0 0 8pt;orphans:2;widows:2}
strong{font-weight:700}
code{font:9.6pt ui-monospace,Menlo,Consolas,monospace;background:#f3eee2;padding:.5pt 2.5pt;border-radius:2px}
ul,ol{margin:0 0 9pt 16pt;padding:0}li{margin:0 0 4pt}
blockquote{margin:10pt 0;padding:7pt 12pt;border-left:2.5pt solid var(--gold);background:#faf6ec}
blockquote p:last-child{margin-bottom:0}
table{width:100%;border-collapse:collapse;margin:10pt 0;font-size:9.6pt;page-break-inside:avoid}
th{text-align:left;font-family:Arial,sans-serif;font-size:8.4pt;text-transform:uppercase;letter-spacing:.06em;color:var(--gold);border-bottom:1.2pt solid var(--gold);padding:4pt 6pt 3pt}
td{border-bottom:.6pt solid var(--line);padding:4pt 6pt;vertical-align:top}
pre.script{font:9.5pt/1.5 ui-monospace,Menlo,Consolas,monospace;background:#f7f3e8;border:.6pt solid var(--line);
 border-left:2.5pt solid var(--gold);padding:9pt 11pt;margin:10pt 0;white-space:pre-wrap;page-break-inside:avoid;border-radius:2px}
.partdiv{page-break-before:always;padding-top:52mm;text-align:center}
.partdiv .pn{font-family:Arial,sans-serif;font-size:9.6pt;letter-spacing:.28em;text-transform:uppercase;color:var(--gold)}
.partdiv .pt{font-size:31pt;margin:7pt 0 9pt}
.partdiv .pd{color:var(--dim);font-style:italic;font-size:11.4pt}
.ch{page-break-before:always}
.ch>h1{border-bottom:1.6pt solid var(--gold);padding-bottom:7pt;margin-bottom:12pt}
.card{border:1.2pt solid var(--gold);border-radius:5px;background:#fffefb;padding:0 0 11pt;margin:14pt 0;page-break-inside:avoid;
 box-shadow:0 1pt 3pt rgba(138,106,47,.09)}
.card-h{background:var(--gold);color:#fff;padding:7pt 12pt;border-radius:3.5px 3.5px 0 0;display:flex;justify-content:space-between;align-items:baseline;gap:10pt}
.card-t{font-family:Arial,sans-serif;font-weight:700;font-size:11.4pt;letter-spacing:.05em;text-transform:uppercase}
.card-tag{font-family:Arial,sans-serif;font-size:8.2pt;opacity:.92;white-space:nowrap}
.card-lead{margin:10pt 12pt 2pt;font-style:italic;color:var(--dim);font-size:10.4pt}
.card-rows{display:grid;grid-template-columns:74pt 1fr;gap:3pt 10pt;margin:9pt 12pt 0;font-size:9.7pt}
.card-rows dt{font-family:Arial,sans-serif;font-size:7.9pt;font-weight:700;letter-spacing:.05em;color:var(--gold);text-transform:uppercase;padding-top:1.5pt}
.card-rows dd{margin:0}
figure.dia{margin:12pt 0;page-break-inside:avoid;text-align:center}
figure.dia svg{width:100%;height:auto}
figcaption{font-size:8.8pt;color:var(--dim);font-style:italic;margin-top:3pt}
.title-pg{text-align:center;padding-top:62mm}
.title-pg .kick{font-family:Arial,sans-serif;letter-spacing:.3em;text-transform:uppercase;font-size:9.4pt;color:var(--gold)}
.title-pg h1{font-size:41pt;margin:12pt 0 4pt;letter-spacing:-.5pt}
.title-pg .sub{font-size:14pt;color:var(--dim);font-style:italic;margin-bottom:26pt}
.title-pg .by{font-family:Arial,sans-serif;font-size:11pt;letter-spacing:.05em}
.title-pg .cred{font-size:9.6pt;color:var(--dim);margin-top:5pt}
.draft{margin-top:30pt;font-size:9pt;color:var(--dim);border-top:.6pt solid var(--line);padding-top:9pt;display:inline-block}
.toc{page-break-before:always}
.toc ul{list-style:none;margin:0;padding:0;font-size:10.2pt}
.toc li{margin:0 0 3.5pt}
.toc a{text-decoration:none;color:var(--ink)}
.toc .tn{display:inline-block;width:22pt;color:var(--gold);font-family:Arial,sans-serif;font-size:8.8pt}
.toc-part{margin:11pt 0 5pt!important;font-family:Arial,sans-serif;font-size:8.6pt;letter-spacing:.13em;text-transform:uppercase;color:var(--gold);font-weight:700}
"""
    doc = f"""<!doctype html><html lang="en"><head><meta charset="utf-8">
<title>The Cruz Protocol — A Field Manual for Commercial Negotiation</title><style>{css}</style></head><body>
<section class="title-pg"><div class="kick">A Field Manual</div>
<h1>The Cruz Protocol</h1>
<p class="sub">Commercial Negotiation, Sequenced</p>
<p class="by">Dan Cruz</p>
<p class="cred">Seven years of practice · five hosting · 1,000+ live sessions · Chicago</p>
<p class="draft">Working draft — all 33 chapters. Bracketed <code>[NEEDS:]</code> markers are<br>case slots awaiting real field material; nothing in them is invented.</p></section>
<section class="toc"><h1>Contents</h1><ul>{''.join(toc)}</ul></section>
{''.join(body)}
</body></html>"""
    os.makedirs(BUILD, exist_ok=True)
    out = os.path.join(BUILD,"cruz-protocol.html")
    open(out,"w",encoding="utf-8").write(doc)
    print("html:", out, f"({len(doc)//1024} KB)")
    return out

if __name__ == "__main__":
    build()
