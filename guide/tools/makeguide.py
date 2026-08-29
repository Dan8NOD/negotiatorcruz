#!/usr/bin/env python3
"""Compile Six Before Yes into a print-ready HTML guide.

Reuses the manual's renderer and stylesheet so both books share one hand.
    python3 guide/tools/makeguide.py  ->  build/six-before-yes.html
"""
import os, re, sys, html, math

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.join(ROOT, "book", "tools"))
import makebook as mb

GUIDE = os.path.join(ROOT, "guide")
BUILD = os.path.join(ROOT, "build")

CSS = open(os.path.join(ROOT, "book", "tools", "makebook.py"), encoding="utf-8").read()
CSS = CSS.split('css = """', 1)[1].split('"""', 1)[0]

# ---------------------------------------------------------------------------
# The seven guide figures, drawn in the same system as the manual's two
# diagrams (DIAGRAMS in makebook.py): #fdfbf6 faces, #8a6a2f gold strokes,
# #2a2317 ink, #5b5343 dim, #c9bfa8 hairlines. Keyed by chapter number.
# Each replaces that chapter's *[Figure ...]* placeholder at build time.

def _arc(cx, cy, r, a1, a2):
    x1 = cx + r * math.cos(math.radians(a1)); y1 = cy + r * math.sin(math.radians(a1))
    x2 = cx + r * math.cos(math.radians(a2)); y2 = cy + r * math.sin(math.radians(a2))
    return f"M {x1:.1f} {y1:.1f} A {r} {r} 0 0 1 {x2:.1f} {y2:.1f}"

_STEPS = [("Know Your Exit",   "What happens",     "if I walk?",         ""),
          ("Find the Stakes",  "What is really",   "at stake?",          ""),
          ("Map the Room",     "Who decides, who", "blocks, what state?", ""),
          ("Pick Your Path",   "What path, what",  "trades, what stop?", ""),
          ("Run the Protocol", "How do I create",  "movement?",          "R → D → S → C"),
          ("Lock and Log",     "What holds, what", "did I learn?",       "")]

DIAGRAMS = {}

DIAGRAMS[1] = ('<figure class="dia"><svg viewBox="0 0 720 184" role="img" aria-label="Six steps in order: three before contact, two during, one after, with the log feeding the next mandate">'
 '<defs><marker id="fg1" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6" fill="none" stroke="#8a6a2f" stroke-width="1.4"/></marker></defs>'
 '<text x="182" y="14" text-anchor="middle" font-size="8.5" font-weight="700" fill="#8a6a2f" letter-spacing=".1em">BEFORE</text>'
 '<text x="480" y="14" text-anchor="middle" font-size="8.5" font-weight="700" fill="#8a6a2f" letter-spacing=".1em">DURING</text>'
 '<text x="658" y="14" text-anchor="middle" font-size="8.5" font-weight="700" fill="#8a6a2f" letter-spacing=".1em">AFTER</text>'
 '<path d="M 12 27 L 12 21 L 352 21 L 352 27" fill="none" stroke="#c9bfa8" stroke-width="1.2"/>'
 '<path d="M 369 27 L 369 21 L 590 21 L 590 27" fill="none" stroke="#c9bfa8" stroke-width="1.2"/>'
 '<path d="M 607 27 L 607 21 L 709 21 L 709 27" fill="none" stroke="#c9bfa8" stroke-width="1.2"/>'
 + "".join(
  f'<g><rect x="{12+119*i}" y="34" width="102" height="76" rx="7" fill="#fdfbf6" stroke="#8a6a2f" stroke-width="1.4"/>'
  f'<text x="{63+119*i}" y="50" text-anchor="middle" font-size="8" font-weight="700" fill="#8a6a2f">STEP {i+1}</text>'
  f'<text x="{63+119*i}" y="64" text-anchor="middle" font-size="9.5" font-weight="700" fill="#2a2317">{n}</text>'
  f'<text x="{63+119*i}" y="80" text-anchor="middle" font-size="7.8" fill="#5b5343">{q1}</text>'
  f'<text x="{63+119*i}" y="91" text-anchor="middle" font-size="7.8" fill="#5b5343">{q2}</text>'
  + (f'<text x="{63+119*i}" y="104" text-anchor="middle" font-size="8" font-weight="700" fill="#8a6a2f">{ins}</text>' if ins else '')
  + '</g>'
  + (f'<line x1="{116+119*i}" y1="72" x2="{129+119*i}" y2="72" stroke="#8a6a2f" stroke-width="1.4" marker-end="url(#fg1)"/>' if i < 5 else '')
  for i, (n, q1, q2, ins) in enumerate(_STEPS))
 + '<path d="M 658 110 L 658 134 L 63 134 L 63 116" fill="none" stroke="#8a6a2f" stroke-width="1.4" marker-end="url(#fg1)"/>'
 '<text x="360" y="149" text-anchor="middle" font-size="9" font-style="italic" fill="#5b5343">the log feeds the next mandate</text>'
 '<text x="360" y="172" text-anchor="middle" font-size="10" font-style="italic" fill="#5b5343">If you meet the other side at Step 1, you are not early. You are three steps late.</text>'
 '</svg><figcaption>The six steps. Three happen before contact, and the last feeds the first.</figcaption></figure>')

DIAGRAMS[2] = ('<figure class="dia"><svg viewBox="0 0 620 196" role="img" aria-label="Authority map: decisions the negotiator holds on the left, decisions that go back on the right, the line between them agreed before contact">'
 '<text x="310" y="26" text-anchor="middle" font-size="9.5" font-style="italic" fill="#8a6a2f">agreed before contact</text>'
 '<line x1="310" y1="34" x2="310" y2="148" stroke="#8a6a2f" stroke-width="1.4"/>'
 '<rect x="24" y="36" width="252" height="112" rx="7" fill="#fdfbf6" stroke="#8a6a2f" stroke-width="1.4"/>'
 '<rect x="344" y="36" width="252" height="112" rx="7" fill="#fdfbf6" stroke="#8a6a2f" stroke-width="1.4"/>'
 '<text x="150" y="60" text-anchor="middle" font-size="10.5" font-weight="700" fill="#2a2317">MINE IN THE ROOM</text>'
 '<text x="470" y="60" text-anchor="middle" font-size="10.5" font-weight="700" fill="#2a2317">BROUGHT BACK</text>'
 '<text x="150" y="84" text-anchor="middle" font-size="9.2" fill="#5b5343">Trades inside the agreed set</text>'
 '<text x="150" y="102" text-anchor="middle" font-size="9.2" fill="#5b5343">Pace, sequence and timing</text>'
 '<text x="150" y="120" text-anchor="middle" font-size="9.2" fill="#5b5343">The walk, at the agreed floor</text>'
 '<text x="470" y="84" text-anchor="middle" font-size="9.2" fill="#5b5343">Anything below the floor</text>'
 '<text x="470" y="102" text-anchor="middle" font-size="9.2" fill="#5b5343">New scope or new parties</text>'
 '<text x="470" y="120" text-anchor="middle" font-size="9.2" fill="#5b5343">Moving the objective itself</text>'
 '<text x="310" y="174" text-anchor="middle" font-size="10" font-style="italic" fill="#5b5343">Decided now, calmly. Not mid-deal, by whoever feels strongest that day.</text>'
 '</svg><figcaption>The escalation line: which calls are yours, agreed before first contact.</figcaption></figure>')

DIAGRAMS[3] = ('<figure class="dia"><svg viewBox="0 0 620 206" role="img" aria-label="The same negotiation drawn twice: positions above the waterline, stakes below it">'
 '<line x1="20" y1="103" x2="600" y2="103" stroke="#c9bfa8" stroke-width="1.4"/>'
 '<text x="24" y="95" font-size="9" font-weight="700" fill="#8a6a2f" letter-spacing=".08em">WHAT GETS SAID</text>'
 '<text x="24" y="117" font-size="9" font-weight="700" fill="#8a6a2f" letter-spacing=".08em">WHAT’S AT STAKE</text>'
 '<text x="215" y="30" text-anchor="middle" font-size="8.5" fill="#5b5343" letter-spacing=".08em">THE BUYER</text>'
 '<text x="465" y="30" text-anchor="middle" font-size="8.5" fill="#5b5343" letter-spacing=".08em">THE SELLER</text>'
 '<rect x="130" y="40" width="170" height="42" rx="7" fill="#fdfbf6" stroke="#8a6a2f" stroke-width="1.4"/>'
 '<rect x="380" y="40" width="170" height="42" rx="7" fill="#fdfbf6" stroke="#8a6a2f" stroke-width="1.4"/>'
 '<text x="215" y="66" text-anchor="middle" font-size="11" font-weight="700" fill="#2a2317">“Under $60K”</text>'
 '<text x="465" y="66" text-anchor="middle" font-size="11" font-weight="700" fill="#2a2317">“List price”</text>'
 '<line x1="215" y1="82" x2="215" y2="124" stroke="#8a6a2f" stroke-width="1.2" stroke-dasharray="3 3"/>'
 '<line x1="465" y1="82" x2="465" y2="124" stroke="#8a6a2f" stroke-width="1.2" stroke-dasharray="3 3"/>'
 '<rect x="130" y="124" width="170" height="42" rx="7" fill="#fdfbf6" stroke="#8a6a2f" stroke-width="1.4"/>'
 '<rect x="380" y="124" width="170" height="42" rx="7" fill="#fdfbf6" stroke="#8a6a2f" stroke-width="1.4"/>'
 '<text x="215" y="150" text-anchor="middle" font-size="9.5" fill="#5b5343">Not being burned again</text>'
 '<text x="465" y="150" text-anchor="middle" font-size="9.5" fill="#5b5343">The quarter can’t slip</text>'
 '<text x="310" y="192" text-anchor="middle" font-size="10" font-style="italic" fill="#5b5343">Every number is protecting something. Ask what, before you decide what it is worth.</text>'
 '</svg><figcaption>Numbers are positions wearing armor.</figcaption></figure>')

DIAGRAMS[4] = ('<figure class="dia"><svg viewBox="0 0 620 244" role="img" aria-label="Influence map: decider, influencer feeding it, blocker with a veto, messenger connected to you">'
 '<defs><marker id="fg4" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6" fill="none" stroke="#8a6a2f" stroke-width="1.4"/></marker></defs>'
 '<line x1="98" y1="172" x2="166" y2="172" stroke="#8a6a2f" stroke-width="1.4"/>'
 '<line x1="231" y1="158" x2="399" y2="79" stroke="#c9bfa8" stroke-width="1.2"/>'
 '<line x1="248" y1="64" x2="390" y2="64" stroke="#8a6a2f" stroke-width="1.4" marker-end="url(#fg4)"/>'
 '<text x="320" y="56" text-anchor="middle" font-size="8.5" font-style="italic" fill="#5b5343">asked first</text>'
 '<line x1="459" y1="146" x2="443" y2="100" stroke="#8a6a2f" stroke-width="1.4" stroke-dasharray="4 3"/>'
 '<text x="472" y="124" font-size="8.5" font-style="italic" fill="#8a6a2f">can veto</text>'
 '<rect x="22" y="150" width="76" height="44" rx="7" fill="#fdfbf6" stroke="#8a6a2f" stroke-width="1.4"/>'
 '<text x="60" y="177" text-anchor="middle" font-size="11" font-weight="700" fill="#2a2317">YOU</text>'
 '<circle cx="212" cy="64" r="34" fill="#fdfbf6" stroke="#8a6a2f" stroke-width="1.4"/>'
 '<text x="212" y="62" text-anchor="middle" font-size="9" font-weight="700" fill="#2a2317">INFLUENCER</text>'
 '<text x="212" y="76" text-anchor="middle" font-size="7.5" fill="#5b5343">asked first</text>'
 '<circle cx="432" cy="64" r="36" fill="#fdfbf6" stroke="#8a6a2f" stroke-width="2.4"/>'
 '<text x="432" y="62" text-anchor="middle" font-size="9.5" font-weight="700" fill="#2a2317">DECIDER</text>'
 '<text x="432" y="76" text-anchor="middle" font-size="7.5" fill="#5b5343">can say yes</text>'
 '<circle cx="470" cy="178" r="34" fill="#fdfbf6" stroke="#8a6a2f" stroke-width="1.4"/>'
 '<text x="470" y="176" text-anchor="middle" font-size="9" font-weight="700" fill="#2a2317">BLOCKER</text>'
 '<text x="470" y="190" text-anchor="middle" font-size="7.5" fill="#5b5343">burned before</text>'
 '<circle cx="200" cy="172" r="34" fill="#fdfbf6" stroke="#8a6a2f" stroke-width="1.4"/>'
 '<text x="200" y="170" text-anchor="middle" font-size="9" font-weight="700" fill="#2a2317">MESSENGER</text>'
 '<text x="200" y="184" text-anchor="middle" font-size="7.5" fill="#5b5343">in front of you</text>'
 '<text x="310" y="232" text-anchor="middle" font-size="10" font-style="italic" fill="#5b5343">Count the people with an opinion, then count the ones you can name. The gap is the risk.</text>'
 '</svg><figcaption>The org chart says who reports to whom. The map says who moves whom.</figcaption></figure>')

DIAGRAMS[5] = ('<figure class="dia"><svg viewBox="0 0 600 316" role="img" aria-label="Balance of power grid: your leverage against theirs, with the strategy each quadrant calls for">'
 '<line x1="112" y1="40" x2="112" y2="272" stroke="#c9bfa8" stroke-width="1.2"/>'
 '<line x1="112" y1="272" x2="556" y2="272" stroke="#c9bfa8" stroke-width="1.2"/>'
 '<text transform="rotate(-90 88 156)" x="88" y="156" text-anchor="middle" font-size="9" font-weight="700" fill="#8a6a2f" letter-spacing=".1em">YOUR LEVERAGE</text>'
 '<text x="104" y="52" text-anchor="end" font-size="8.5" fill="#5b5343">high</text>'
 '<text x="104" y="266" text-anchor="end" font-size="8.5" fill="#5b5343">low</text>'
 '<text x="334" y="308" text-anchor="middle" font-size="9" font-weight="700" fill="#8a6a2f" letter-spacing=".1em">THEIR LEVERAGE</text>'
 '<text x="225" y="290" text-anchor="middle" font-size="8.5" fill="#5b5343">low</text>'
 '<text x="443" y="290" text-anchor="middle" font-size="8.5" fill="#5b5343">high</text>'
 '<rect x="120" y="40" width="210" height="110" rx="7" fill="#fdfbf6" stroke="#8a6a2f" stroke-width="1.4"/>'
 '<text x="225" y="92" text-anchor="middle" font-size="11" font-weight="700" fill="#2a2317">SET THE PACE</text>'
 '<text x="225" y="110" text-anchor="middle" font-size="8.5" fill="#5b5343">anchor first, set the sequence</text>'
 '<rect x="338" y="40" width="210" height="110" rx="7" fill="#fdfbf6" stroke="#8a6a2f" stroke-width="1.4"/>'
 '<text x="443" y="92" text-anchor="middle" font-size="11" font-weight="700" fill="#2a2317">TRADE CAREFULLY</text>'
 '<text x="443" y="110" text-anchor="middle" font-size="8.5" fill="#5b5343">swap, never give</text>'
 '<rect x="120" y="158" width="210" height="110" rx="7" fill="#fdfbf6" stroke="#8a6a2f" stroke-width="1.4"/>'
 '<text x="225" y="210" text-anchor="middle" font-size="11" font-weight="700" fill="#2a2317">PREPARE AND PROBE</text>'
 '<text x="225" y="228" text-anchor="middle" font-size="8.5" fill="#5b5343">homework beats force</text>'
 '<rect x="338" y="158" width="210" height="110" rx="7" fill="#fdfbf6" stroke="#8a6a2f" stroke-width="1.4"/>'
 '<text x="443" y="210" text-anchor="middle" font-size="11" font-weight="700" fill="#2a2317">CHANGE THE GAME</text>'
 '<text x="443" y="228" text-anchor="middle" font-size="8.5" fill="#5b5343">before you play it</text>'
 '</svg><figcaption>Audit all three leverages, both directions, then place yourself honestly.</figcaption></figure>')

DIAGRAMS[6] = ('<figure class="dia"><svg viewBox="0 0 620 288" role="img" aria-label="The movement loop: Read, Disarm, Steer, Close as a cycle, with the way back to Read always open">'
 '<defs><marker id="fg6" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6" fill="none" stroke="#8a6a2f" stroke-width="1.4"/></marker></defs>'
 '<path d="M 388 45 Q 527 45 527 108" fill="none" stroke="#8a6a2f" stroke-width="1.4" marker-end="url(#fg6)"/>'
 '<path d="M 527 170 Q 527 233 389 233" fill="none" stroke="#8a6a2f" stroke-width="1.4" marker-end="url(#fg6)"/>'
 '<path d="M 231 233 Q 93 233 93 170" fill="none" stroke="#8a6a2f" stroke-width="1.4" marker-end="url(#fg6)"/>'
 '<path d="M 93 108 Q 93 45 231 45" fill="none" stroke="#8a6a2f" stroke-width="1.4" marker-end="url(#fg6)"/>'
 '<path d="M 455 110 Q 390 78 344 75" fill="none" stroke="#8a6a2f" stroke-width="1.2" stroke-dasharray="4 3" marker-end="url(#fg6)"/>'
 '<path d="M 310 204 L 310 78" fill="none" stroke="#8a6a2f" stroke-width="1.2" stroke-dasharray="4 3" marker-end="url(#fg6)"/>'
 '<text x="318" y="148" font-size="9" font-style="italic" fill="#8a6a2f">when in doubt</text>'
 '<rect x="235" y="18" width="150" height="54" rx="7" fill="#fdfbf6" stroke="#8a6a2f" stroke-width="1.4"/>'
 '<text x="310" y="40" text-anchor="middle" font-size="12" font-weight="700" fill="#2a2317">READ</text>'
 '<text x="310" y="58" text-anchor="middle" font-size="8.5" fill="#5b5343">diagnose before you ask</text>'
 '<rect x="452" y="112" width="150" height="54" rx="7" fill="#fdfbf6" stroke="#8a6a2f" stroke-width="1.4"/>'
 '<text x="527" y="134" text-anchor="middle" font-size="12" font-weight="700" fill="#2a2317">DISARM</text>'
 '<text x="527" y="152" text-anchor="middle" font-size="8.5" fill="#5b5343">say the worst thing first</text>'
 '<rect x="235" y="206" width="150" height="54" rx="7" fill="#fdfbf6" stroke="#8a6a2f" stroke-width="1.4"/>'
 '<text x="310" y="228" text-anchor="middle" font-size="12" font-weight="700" fill="#2a2317">STEER</text>'
 '<text x="310" y="246" text-anchor="middle" font-size="8.5" fill="#5b5343">hand them the problem</text>'
 '<rect x="18" y="112" width="150" height="54" rx="7" fill="#fdfbf6" stroke="#8a6a2f" stroke-width="1.4"/>'
 '<text x="93" y="134" text-anchor="middle" font-size="12" font-weight="700" fill="#2a2317">CLOSE</text>'
 '<text x="93" y="152" text-anchor="middle" font-size="8.5" fill="#5b5343">get out of the way</text>'
 '<text x="310" y="280" text-anchor="middle" font-size="10" font-style="italic" fill="#5b5343">Full drills for every tool: the companion manual.</text>'
 '</svg><figcaption>A cycle, not a ladder. Nearly every failure in the room is a stage run too early.</figcaption></figure>')

_RING = [("Know Your Exit",   310, 18,  "middle"),
         ("Find the Stakes",  428, 105, "start"),
         ("Map the Room",     428, 207, "start"),
         ("Pick Your Path",   310, 294, "middle"),
         ("Run the Protocol", 192, 207, "end"),
         ("Lock and Log",     192, 105, "end")]

DIAGRAMS[7] = ('<figure class="dia"><svg viewBox="0 0 620 302" role="img" aria-label="The six steps drawn as a closed circle, Step 6 arcing back to Step 1">'
 '<defs><marker id="fg7" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6" fill="none" stroke="#8a6a2f" stroke-width="1.4"/></marker></defs>'
 + "".join(
  f'<path d="{_arc(310, 152, 100, -90 + 60*k + 18, -90 + 60*k + 42)}" fill="none" stroke="#8a6a2f" '
  f'stroke-width="{2.4 if k == 5 else 1.4}" marker-end="url(#fg7)"/>'
  for k in range(6))
 + "".join(
  f'<g><circle cx="{310 + 100*math.cos(math.radians(-90 + 60*k)):.1f}" cy="{152 + 100*math.sin(math.radians(-90 + 60*k)):.1f}" r="25" fill="#fdfbf6" stroke="#8a6a2f" stroke-width="1.4"/>'
  f'<text x="{310 + 100*math.cos(math.radians(-90 + 60*k)):.1f}" y="{157 + 100*math.sin(math.radians(-90 + 60*k)):.1f}" text-anchor="middle" font-size="13" font-weight="700" fill="#2a2317">{k+1}</text>'
  f'<text x="{x}" y="{y}" text-anchor="{a}" font-size="8.5" fill="#5b5343">{n}</text></g>'
  for k, (n, x, y, a) in enumerate(_RING))
 + '<text x="243" y="49" text-anchor="end" font-size="9" font-style="italic" fill="#8a6a2f">the log feeds the next mandate</text>'
 '</svg><figcaption>Chapter 1 drew a line. Run weekly, it is a circle. Step 6 is Step 1 of the next deal.</figcaption></figure>')

# Every guide chapter opens with blueprint scaffolding: an art-direction note
# for the opener image, then the chapter number and title repeated as a
# designed spread. Both renderers already emit a title of their own from the
# "# Chapter N:" line, so the repeat printed the title twice with a stage
# direction wedged between the two. Consumed here, once, for print and EPUB.
CH_SCAFFOLD = [
    re.compile(r"(?m)^\*\[Chapter opener image[^\]]*\]\*\n+"),
    re.compile(r"(?m)^\*\*Chapter \d+\*\*\n+"),
    re.compile(r"(?m)^##\s+(?!§).+?\n+", ),
]


def strip_scaffolding(md):
    """Drop the opener scaffolding from a guide chapter, first block only."""
    head, sep, tail = md.partition("\n### ")
    for i, pat in enumerate(CH_SCAFFOLD):
        head = pat.sub("", head, count=1)
    return head + sep + tail


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
    # The master-figure spec is implemented as DIAGRAMS[1]; the spec itself
    # stays in the source file but does not print.
    summary = summary.split("### Master figure (spec)")[0].rstrip().rstrip("-").rstrip()
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
        # Swap the chapter's prose figure placeholder for the drawn figure.
        # The placeholder text stays in the markdown source as the figure's
        # spec; a chapter whose placeholder has gone missing fails the build.
        t = strip_scaffolding(t)
        t, nsub = re.subn(r"(?s)\*\[(?:Master f|F)igure\b.*?\]\*", "%%FIG%%", t, count=1)
        if nsub != 1:
            raise SystemExit(f"{fn}: figure placeholder not found")
        h = mb.md(t).replace("<p>%%FIG%%</p>", DIAGRAMS[i], 1)
        if "%%FIG%%" in h:
            raise SystemExit(f"{fn}: figure marker survived the render")
        body.append(f'<section class="ch" id="g{i}">' + h + "</section>")
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
