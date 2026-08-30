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
 for i,(n,d,c) in enumerate([("READ","diagnose","4-9"),("DISARM","defuse","10-14"),("STEER","redirect","15-20"),("CLOSE","resolve","21-25")])
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
<text x="310" y="18" text-anchor="middle" font-size="10.5" fill="#5b5343" font-style="italic">Steps must decelerate. That shrinking gap is the signal there is a floor.</text>
</svg><figcaption>The Ackerman ladder. End on a non-round number.</figcaption></figure>'''}

# Four more manual figures, drawn in the system the two existing diagrams
# and the guide's seven share: #fdfbf6 faces, #8a6a2f gold strokes at 1.4,
# #c9bfa8 light rules at 1.2, rx 7 corners. Each renders structure the
# chapter already states in prose. None of them introduces doctrine.

# Chapter 5. The state triage, word for word from the reference table in
# the back matter, which X1 and X2 both audited.
DIAGRAMS[5] = ('<figure class="dia"><svg viewBox="0 0 720 214" role="img" '
 'aria-label="The three states side by side: what each sounds like, what to do, and what never to do">'
 + "".join(
   f'<g><rect x="{12+238*i}" y="14" width="220" height="186" rx="7" fill="#fdfbf6" stroke="#8a6a2f" stroke-width="1.4"/>'
   f'<text x="{122+238*i}" y="38" text-anchor="middle" font-size="15" font-weight="700" fill="#2a2317" letter-spacing=".06em">{s}</text>'
   f'<line x1="{28+238*i}" y1="50" x2="{216+238*i}" y2="50" stroke="#c9bfa8" stroke-width="1.2"/>'
   f'<text x="{28+238*i}" y="70" font-size="8.5" font-weight="700" fill="#8a6a2f" letter-spacing=".08em">SOUNDS LIKE</text>'
   + "".join(f'<text x="{28+238*i}" y="{86+13*k}" font-size="9.5" fill="#5b5343">{ln}</text>' for k, ln in enumerate(tell))
   + f'<text x="{28+238*i}" y="136" font-size="8.5" font-weight="700" fill="#8a6a2f" letter-spacing=".08em">DO</text>'
   + "".join(f'<text x="{28+238*i}" y="{152+13*k}" font-size="9.5" fill="#2a2317">{ln}</text>' for k, ln in enumerate(do))
   + f'<text x="{132+238*i}" y="136" font-size="8.5" font-weight="700" fill="#8a6a2f" letter-spacing=".08em">NEVER</text>'
   + "".join(f'<text x="{132+238*i}" y="{152+13*k}" font-size="9.5" fill="#5b5343">{ln}</text>' for k, ln in enumerate(never))
   + '</g>'
   for i, (s, tell, do, never) in enumerate([
     ("TORN",
      ["repeats both sides", "unprompted, asks for", "information they", "don't use"],
      ["name the tension,", "remove the shame"],
      ["add options", "or pressure"]),
     ("READY",
      ["asks about start", "dates, corrects", "your caution"],
      ["stop selling,", "start scheduling"],
      ["re-argue the", "settled case"]),
     ("NOT YET",
      ["warm, agreeable,", "reschedules easily"],
      ["find the future", "where the problem", "exists"],
      ["manufacture", "urgency"]),
   ]))
 + '</svg><figcaption>States are weather, not climate. Read the state before you pick the move.</figcaption></figure>')

# Chapter 9. Authority narrowing across the three pronouns, with the
# mid-sentence switch the chapter calls the highest-value signal in it.
DIAGRAMS[9] = ('<figure class="dia"><svg viewBox="0 0 720 226" role="img" '
 'aria-label="Authority narrowing from I to we to they, with a named person as the exception and the mid-sentence switch marked">'
 '<defs><marker id="d9" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto">'
 '<path d="M0,0 L7,3 L0,6" fill="none" stroke="#8a6a2f" stroke-width="1.4"/></marker></defs>'
 '<text x="24" y="24" font-size="8.5" font-weight="700" fill="#8a6a2f" letter-spacing=".08em">AUTHORITY</text>'
 '<text x="696" y="24" text-anchor="end" font-size="8.5" font-weight="700" fill="#8a6a2f" letter-spacing=".08em">NONE</text>'
 '<path d="M 24 34 L 696 34" stroke="#c9bfa8" stroke-width="1.2"/>'
 + "".join(
   f'<g><rect x="{24+230*i}" y="46" width="212" height="{h}" rx="7" fill="#fdfbf6" stroke="#8a6a2f" stroke-width="1.4"/>'
   f'<text x="{130+230*i}" y="72" text-anchor="middle" font-size="17" font-weight="700" fill="#2a2317">{p}</text>'
   f'<text x="{130+230*i}" y="92" text-anchor="middle" font-size="9.5" font-style="italic" fill="#5b5343">{q}</text>'
   + "".join(f'<text x="{130+230*i}" y="{114+13*k}" text-anchor="middle" font-size="9.5" fill="#5b5343">{ln}</text>' for k, ln in enumerate(m))
   + '</g>'
   + (f'<line x1="{239+230*i}" y1="86" x2="{251+230*i}" y2="86" stroke="#8a6a2f" stroke-width="1.4" marker-end="url(#d9)"/>' if i < 2 else '')
   for i, (p, q, m, h) in enumerate([
     ("&#8220;I&#8221;", "&#8220;I&#8217;d want the security review.&#8221;",
      ["Real authority, or at", "least real ownership."], 100),
     ("&#8220;We&#8221;", "&#8220;We&#8217;d need to think about it.&#8221;",
      ["A committee exists.", "Find out who is in it."], 100),
     ("&#8220;They&#8221;", "&#8220;They&#8217;ll never approve that.&#8221;",
      ["Authority is elsewhere.", "True, or a shield. Both matter."], 100),
   ]))
 + '<rect x="24" y="158" width="442" height="46" rx="7" fill="#fdfbf6" stroke="#8a6a2f" stroke-width="1.4" stroke-dasharray="4 3"/>'
 '<text x="38" y="176" font-size="8.5" font-weight="700" fill="#8a6a2f" letter-spacing=".08em">THE SWITCH</text>'
 '<text x="38" y="194" font-size="10" font-style="italic" fill="#2a2317">'
 '&#8220;I think we could, well, they&#8217;d have to sign off.&#8221;</text>'
 '<rect x="484" y="158" width="212" height="46" rx="7" fill="#fdfbf6" stroke="#8a6a2f" stroke-width="1.4"/>'
 '<text x="498" y="176" font-size="8.5" font-weight="700" fill="#8a6a2f" letter-spacing=".08em">A NAME</text>'
 '<text x="498" y="194" font-size="10" fill="#2a2317">A gift. Write it down.</text>'
 '</svg><figcaption>People start sentences from the position they wish they occupied '
 'and finish them from the one they actually do.</figcaption></figure>')

# Chapter 30. The three conditions, each with the test that separates it
# from the other two and the move it calls for.
DIAGRAMS[30] = ('<figure class="dia"><svg viewBox="0 0 720 250" role="img" '
 'aria-label="Three conditions under which the Protocol stops applying, each with its tell, its test, and the move">'
 '<defs><marker id="d30" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto">'
 '<path d="M0,0 L7,3 L0,6" fill="none" stroke="#8a6a2f" stroke-width="1.4"/></marker></defs>'
 + "".join(
   f'<g><rect x="{12+238*i}" y="14" width="220" height="222" rx="7" fill="#fdfbf6" stroke="#8a6a2f" stroke-width="1.4"/>'
   f'<text x="{122+238*i}" y="38" text-anchor="middle" font-size="13.5" font-weight="700" fill="#2a2317" letter-spacing=".05em">{name}</text>'
   f'<text x="{122+238*i}" y="54" text-anchor="middle" font-size="9" font-style="italic" fill="#5b5343">{sub}</text>'
   f'<line x1="{28+238*i}" y1="64" x2="{216+238*i}" y2="64" stroke="#c9bfa8" stroke-width="1.2"/>'
   f'<text x="{28+238*i}" y="82" font-size="8.5" font-weight="700" fill="#8a6a2f" letter-spacing=".08em">TELL</text>'
   + "".join(f'<text x="{28+238*i}" y="{98+13*k}" font-size="9.5" fill="#5b5343">{ln}</text>' for k, ln in enumerate(tell))
   + f'<text x="{28+238*i}" y="{150}" font-size="8.5" font-weight="700" fill="#8a6a2f" letter-spacing=".08em">TEST</text>'
   + "".join(f'<text x="{28+238*i}" y="{166+13*k}" font-size="9.5" fill="#5b5343">{ln}</text>' for k, ln in enumerate(test))
   + f'<line x1="{28+238*i}" y1="{198}" x2="{216+238*i}" y2="{198}" stroke="#c9bfa8" stroke-width="1.2"/>'
   + f'<text x="{28+238*i}" y="216" font-size="8.5" font-weight="700" fill="#8a6a2f" letter-spacing=".08em">DO</text>'
   + "".join(f'<text x="{28+238*i}" y="{228+13*k}" font-size="9.5" font-weight="600" fill="#2a2317">{ln}</text>' for k, ln in enumerate(do))
   + '</g>'
   for i, (name, sub, tell, test, do) in enumerate([
     ("BAD FAITH", "no intention of agreeing",
      ["Enthusiasm with no", "process detail. Nothing", "you concede produces", "reciprocal movement."],
      ["Ask for a small, cheap", "commitment."],
      ["Name it once. Stop investing."]),
     ("NO AUTHORITY", "they cannot agree",
      ["Pronouns drift to", "&#8220;they.&#8221; Every agreement", "is provisional."],
      ["Ask for a decision", "with a date."],
      ["Change the room."]),
     ("DEADLOCK", "both right, incompatible",
      ["The constraint is specific,", "consistent, and from", "outside the room."],
      ["Probe it. Bracket it.", "If it holds under both,", "it is real."],
      ["Say so."]),
   ]))
 + '</svg><figcaption>Not every negotiation is winnable. Diagnosing which of the three '
 'you are in is what stops you spending a quarter on the first two.</figcaption></figure>')

# Chapter 31. The adoption curve, the week three dip, and the two paths out
# of it. The chapter states both in prose: the dip arrives on schedule, and
# stopping at week two looks like success at day fourteen and is gone by day
# thirty.
DIAGRAMS[31] = ('<figure class="dia"><svg viewBox="0 0 720 300" role="img" '
 'aria-label="Adoption over four weeks: a dip in week three, then automatic use if the rollout continues, or decay to baseline if it stops at week two">'
 '<line x1="70" y1="232" x2="672" y2="232" stroke="#c9bfa8" stroke-width="1.2"/>'
 '<line x1="70" y1="34" x2="70" y2="232" stroke="#c9bfa8" stroke-width="1.2"/>'
 '<text x="34" y="44" font-size="8.5" font-weight="700" fill="#8a6a2f" letter-spacing=".08em">USE</text>'
 '<line x1="70" y1="214" x2="672" y2="214" stroke="#c9bfa8" stroke-width="1" stroke-dasharray="3 4"/>'
 '<text x="676" y="217" font-size="8.5" fill="#5b5343">baseline</text>'
 + "".join(
   f'<g><text x="{145+150*i}" y="250" text-anchor="middle" font-size="10.5" font-weight="700" fill="#2a2317">WEEK {i+1}</text>'
   f'<text x="{145+150*i}" y="266" text-anchor="middle" font-size="9.5" fill="#8a6a2f">{st}</text>'
   f'<text x="{145+150*i}" y="281" text-anchor="middle" font-size="9" fill="#5b5343">{mt}</text></g>'
   + (f'<line x1="{220+150*i}" y1="236" x2="{220+150*i}" y2="286" stroke="#c9bfa8" stroke-width="1"/>' if i < 3 else '')
   for i, (st, mt) in enumerate([
     ("READ", "talk-time ratio"),
     ("DISARM", "objections surfaced"),
     ("STEER", "questions before numbers"),
     ("CLOSE", "concessions after silence"),
   ]))
 # The rollout that runs all four weeks: awkward rise, the week 3 dip, then automatic.
 + '<path d="M 70 205 C 120 175, 178 140, 245 128 C 300 119, 342 124, 380 138 '
   'C 405 148, 426 158, 445 160 C 470 162, 496 150, 520 132 C 570 98, 622 72, 668 58" '
   'fill="none" stroke="#8a6a2f" stroke-width="2"/>'
 # The rollout stopped after week 2, decaying to where it started.
 + '<path d="M 380 138 C 410 162, 442 188, 492 202 C 546 212, 610 214, 668 214" '
   'fill="none" stroke="#8a6a2f" stroke-width="1.4" stroke-dasharray="5 4"/>'
 + '<circle cx="445" cy="160" r="4" fill="#fdfbf6" stroke="#8a6a2f" stroke-width="1.6"/>'
 + '<path d="M 441 157 L 437 104" fill="none" stroke="#8a6a2f" stroke-width="1.2"/>'
 + '<text x="429" y="90" text-anchor="end" font-size="9.5" font-weight="700" fill="#2a2317">THE WEEK 3 DIP</text>'
 + '<text x="429" y="103" text-anchor="end" font-size="9" fill="#5b5343">Arrives on schedule. It is not feedback.</text>'
 + '<text x="668" y="44" text-anchor="end" font-size="9.5" font-weight="700" fill="#2a2317">Unprompted use</text>'
 + '<text x="662" y="206" text-anchor="end" font-size="9" font-style="italic" fill="#5b5343">Stopped at week 2. Gone by day 30.</text>'
 + '</svg><figcaption>A behavior not recorded and scored within a week of being taught '
 'will not survive the month.</figcaption></figure>')

def front_matter(path, skip_cover=True):
    """Turn a front-matter spec file into printable copy.

    These files are written as specifications: "## Page N: Label" headings,
    the actual copy inside blockquotes, and unquoted prose that is the note
    explaining the choice, several of which say "not for print" outright.
    Neither renderer read them, so no edition has ever carried its own front
    matter. The rule is the one the files already follow: quoted lines are
    the copy, everything else is editorial.

    skip_cover drops the first page, because both renderers draw a title page
    of their own and printing the spec's cover would double it.
    """
    if not os.path.isfile(path):
        return []
    t = open(path, encoding="utf-8").read()
    t = re.sub(r"^#\s+.+?\n", "", t, count=1)
    # Most sections are labelled "Page N: Something", but not all. The last
    # one in the manual's file is a plain heading and carries the reader path
    # a corporate evaluator uses, so split on any h2 rather than the numbered
    # form and drop the cover by what it is called.
    chunks = re.split(r"(?m)^##\s+(.+?)\s*$", t)[1:]
    pages = []
    for i, (label, block) in enumerate(zip(chunks[0::2], chunks[1::2])):
        # Only ever the first chunk. Testing "no pages kept yet" instead ate
        # the guide's copyright page too, because it is called "Title and
        # copyright" and matched the same words one page later.
        if skip_cover and i == 0 and re.search(r"\b(cover|title)\b", label, re.I):
            continue
        # "Page 3: Who this manual is for" is the page's heading with a
        # position marker in front of it. Keep the heading, drop the marker.
        pages.append((re.sub(r"^Page\s*\d+\s*[:.]\s*", "", label).strip(), block))
    out = []
    for heading, block in pages:
        keep = []
        for line in block.splitlines():
            if line.startswith(">"):
                keep.append(re.sub(r"^>\s?", "", line))
            elif "[NEEDS:" in line:
                keep.append(line)
            elif not line.strip() and keep and keep[-1].strip():
                keep.append("")
        copy = "\n".join(keep).strip()
        if copy:
            h = f"<h1>{html.escape(heading)}</h1>" if heading else ""
            out.append('<section class="ch frontm">' + h + md(copy) + "</section>")
    return out


BACK_MATTER = [
    ("back-matter-cards.md",     "appA", "Appendix A · The Field Cards"),
    ("back-matter-reference.md", "appB", "Appendix B · Reference"),
    ("back-matter-glossary.md",  "appC", "Appendix C · Glossary"),
]


def back_matter():
    """The three appendices, appended after Chapter 33.

    They were written as separate files and neither renderer ever read them,
    so every rendered edition of this manual ended at the last chapter. The
    field card appendix is the training-day leave-behind the site promises,
    which made it the most expensive of the three to be missing."""
    out, toc = [], []
    for fn, anchor, label in BACK_MATTER:
        path = os.path.join(ROOT, fn)
        if not os.path.isfile(path):
            continue
        t = open(path, encoding="utf-8").read()
        title = re.search(r"^#\s+(.+?)\s*$", t, re.M)
        title = title.group(1) if title else label
        t = re.sub(r"^#\s+.+?\n", "", t, count=1)
        out.append(f'<section class="ch appendix" id="{anchor}"><h1>{html.escape(title)}</h1>'
                   + md(t) + "</section>")
        toc.append(f'<li><a href="#{anchor}"><span class="tn">·</span> {html.escape(label)}</a></li>')
    return out, toc


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
        title = re.search(r"^#\s*Chapter\s*\d+\s*[:—-]\s*(.+?)\s*$",txt,re.M).group(1)
        h = md(txt)
        if n in DIAGRAMS:
            h = h.replace("</h2>","</h2>\n"+DIAGRAMS[n],1)
        body.append(f'<section class="ch" id="ch{n}">{h}</section>')
        toc.append(f'<li><a href="#ch{n}"><span class="tn">{n}</span> {html.escape(title)}</a></li>')

    fm_body = front_matter(os.path.join(ROOT, "front-matter.md"))
    bm_body, bm_toc = back_matter()
    toc.extend(bm_toc)
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
<title>The Cruz Protocol: A Field Manual for Commercial Negotiation</title><style>{css}</style></head><body>
<section class="title-pg"><div class="kick">A Field Manual</div>
<h1>The Cruz Protocol</h1>
<p class="sub">Commercial Negotiation, Sequenced</p>
<p class="by">Dan Cruz</p>
<p class="cred">Seven years of practice · five hosting · 1,000+ live sessions · Chicago</p>
<p class="draft">Working draft. All 33 chapters. Bracketed <code>[NEEDS:]</code> markers are<br>case slots awaiting real field material. Nothing in them is invented.</p></section>
{''.join(fm_body)}
<section class="toc"><h1>Contents</h1><ul>{''.join(toc)}</ul></section>
{''.join(body)}
{''.join(bm_body)}
</body></html>"""
    os.makedirs(BUILD, exist_ok=True)
    out = os.path.join(BUILD,"cruz-protocol.html")
    open(out,"w",encoding="utf-8").write(doc)
    print("html:", out, f"({len(doc)//1024} KB)")
    return out

if __name__ == "__main__":
    build()
