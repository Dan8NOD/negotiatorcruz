#!/usr/bin/env python3
"""Derive audiobook narration scripts and the gap index from the chapter segments.

Canonical source is book/chapters/*.md (segmented A/B). Everything in
book/audio/ is generated -- edit the chapters, then re-run this.

    python3 book/tools/build.py
"""
import glob, os, re, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CH   = os.path.join(ROOT, "chapters")
AUD  = os.path.join(ROOT, "audio")


def chapter_num(path):
    return int(re.search(r"ch(\d+)", os.path.basename(path)).group(1))


def segment(path):
    m = re.search(r"ch\d+([ab])-", os.path.basename(path))
    return m.group(1) if m else "a"


# ---------- narration ----------

def spoken_table(block):
    """Turn a markdown table into spoken sentences."""
    rows = [r for r in block.strip().split("\n") if r.strip().startswith("|")]
    if len(rows) < 3:
        return ""
    head = [c.strip() for c in rows[0].strip("|").split("|")]
    out = []
    for r in rows[2:]:
        cells = [c.strip() for c in r.strip("|").split("|")]
        if not any(cells):
            continue
        parts = []
        for h, c in zip(head, cells):
            c = re.sub(r"\*+", "", c).strip()
            if not c:
                continue
            parts.append(f"{h}: {c}" if h else c)
        if parts:
            out.append(". ".join(parts).rstrip(".") + ".")
    return "\n\n".join(out)


def spoken_block(body):
    """Turn a fenced script box into spoken quotes. Drop ASCII art boxes."""
    if "┌" in body or "│" in body:
        return None                       # field card -- visual only
    # rejoin quotes that wrap across source lines
    raw, merged = [l.rstrip() for l in body.split("\n")], []
    for l in raw:
        s = l.strip()
        cont = False
        if merged and s:
            prev = merged[-1].rstrip()
            if prev.count('"') % 2 == 1:
                cont = True                       # quote left open
            elif prev and not prev[-1] in '.!?:"]' and s[:1].islower():
                cont = True                       # wrapped sentence
        if cont:
            merged[-1] = merged[-1].rstrip() + " " + s
        else:
            merged.append(l)
    out, heading = [], None
    for l in merged:
        s = l.strip()
        if not s:
            continue
        if s.startswith("[") and s.endswith("]"):
            out.append(s[1:-1].rstrip(".") + ".")       # stage direction
            continue
        if re.match(r'^[A-Z][A-Z —\-/&\'"]+$', s) and '"' not in s:
            heading = s.title()
            out.append(f"{heading}.")
            continue
        # dialogue lines read naturally without quote framing
        m = re.match(r'^(Them|You)\s*:\s*(.+)$', s)
        if m:
            who = "They say" if m.group(1) == "Them" else "You say"
            said = m.group(2).strip().strip('"').lstrip('.').strip()
            said = re.sub(r'\s*(→|->)\s*', '', said).strip()
            if said:
                out.append(f"{who}: {said if said[-1] in '.?!' else said + '.'}")
            continue
        q = s.strip('"').strip()
        if s.startswith('"') or s.endswith('"') or s.startswith("'"):
            if q and q[-1] == ".":
                q = q[:-1]
            out.append(f'Quote. {q}. End quote.' if q and q[-1] not in '?!'
                       else f'Quote. {q} End quote.')
        else:
            out.append(s)
    return "\n\n".join(out)


def narrate(md):
    md = re.sub(r"(?s)^---\n.*?\n---\n", "", md)                    # frontmatter
    md = re.sub(r"(?s)>\s*###\s*Evidence.*?(?=\n---|\Z)", "", md)   # NEEDS blocks
    md = re.sub(r"(?s)^> \*\*Note on the title\.\*\*.*?(?=\n---)", "", md, flags=re.M)
    md = re.sub(r"\[NEEDS:[^\]]*\]", "", md)
    md = re.sub(r"(?m)^#{1,6}\s*FIELD CARD.*$", "", md)   # card is visual only

    out, i, lines = [], 0, md.split("\n")
    while i < len(lines):
        l = lines[i]
        if l.strip().startswith("```"):
            j = i + 1
            buf = []
            while j < len(lines) and not lines[j].strip().startswith("```"):
                buf.append(lines[j]); j += 1
            sp = spoken_block("\n".join(buf))
            if sp:
                out.append(sp)
            i = j + 1
            continue
        if l.strip().startswith("|"):
            j = i
            buf = []
            while j < len(lines) and lines[j].strip().startswith("|"):
                buf.append(lines[j]); j += 1
            sp = spoken_table("\n".join(buf))
            if sp:
                out.append(sp)
            i = j
            continue
        out.append(l)
        i += 1

    t = "\n".join(out)
    t = re.sub(r"^#{1,6}\s*", "", t, flags=re.M)      # headers -> plain lines
    t = re.sub(r"\*\*(.+?)\*\*", r"\1", t, flags=re.S)
    t = re.sub(r"\*(.+?)\*", r"\1", t, flags=re.S)
    t = re.sub(r"`([^`]*)`", r"\1", t)
    t = re.sub(r"^\s*>\s?", "", t, flags=re.M)
    t = re.sub(r"^\s*[-*]\s+", "", t, flags=re.M)
    t = re.sub(r"^\s*\d+\.\s+", "", t, flags=re.M)
    t = re.sub(r"^---+$", "", t, flags=re.M)
    t = re.sub(r"—", " - ", t)                    # em dash -> spoken pause
    t = re.sub(r"[ \t]+", " ", t)
    t = re.sub(r"\n{3,}", "\n\n", t)
    return t.strip() + "\n"


def main():
    files = sorted(glob.glob(os.path.join(CH, "ch*.md")),
                   key=lambda f: (chapter_num(f), segment(f)))
    if not files:
        sys.exit("no chapters found")

    os.makedirs(AUD, exist_ok=True)
    for f in glob.glob(os.path.join(AUD, "*.txt")):
        os.remove(f)

    gaps, wrote = {}, 0
    for f in files:
        md = open(f, encoding="utf-8").read()
        n = chapter_num(f)
        gaps[n] = gaps.get(n, 0) + len(re.findall(r"\[NEEDS:", md))
        base = os.path.basename(f).replace(".md", ".txt")
        open(os.path.join(AUD, base), "w", encoding="utf-8").write(narrate(md))
        wrote += 1

    # gap index
    titles = {}
    for f in files:
        m = re.search(r"^#\s*Chapter\s*\d+\s*[—-]\s*(.+?)\s*$", open(f, encoding="utf-8").read(), re.M)
        if m:
            titles[chapter_num(f)] = m.group(1)

    # Commercial weight: which chapters a buyer actually reads before paying.
    # Ch 2/30/33 are the evaluator path named in Ch 3. Part V is where the
    # buyer sees themselves. Part VI is what a manager installs from.
    WEIGHT = {2: 5, 30: 5, 33: 5,
              26: 4, 27: 4, 28: 4, 29: 4, 31: 4, 32: 4,
              1: 3, 3: 3}
    def weight(n):
        return WEIGHT.get(n, 2)

    rows = sorted(gaps.items(), key=lambda kv: (-(kv[1] * weight(kv[0])), kv[0]))
    idx = ["# Gap Index — where real material is still needed", "",
           "Generated by `book/tools/build.py`. Re-run after editing chapters.", "",
           "**Read this first.** Raw `[NEEDS:]` counts are nearly flat — almost every",
           "chapter needs exactly one real case. Counting alone will not give you a",
           "meaningful top ten, so the list is ordered by **priority = gaps x commercial",
           "weight**, where weight is how much that chapter does before anyone pays:", "",
           "- **5** — the evaluator path (Ch 2, 30, 33). What a buyer reads to decide.",
           "- **4** — Part V applications and Part VI installation. Where the buyer sees",
           "  themselves, and what a manager installs from.",
           "- **3** — Part 0 framing. The Amazon sample.",
           "- **2** — tool chapters. Real, but a missing case hurts less here.", "",
           "| Rank | Ch | Title | Gaps | Weight | Priority |", "|---|---|---|---|---|---|"]
    for r, (n, c) in enumerate(rows, 1):
        idx.append(f"| {r} | {n} | {titles.get(n,'?')} | {c} | {weight(n)} | {c*weight(n)} |")
    idx += ["", f"**Total open gaps:** {sum(gaps.values())} across {len(gaps)} drafted chapters.",
            "", "Undrafted chapters are not listed — their gaps do not exist yet. Ch 26-30",
            "(Part V) will dominate this table once drafted, which is the argument for",
            "collecting those cases before drafting rather than after."]
    open(os.path.join(ROOT, "GAP-INDEX.md"), "w", encoding="utf-8").write("\n".join(idx) + "\n")

    print(f"narration: {wrote} files -> book/audio/")
    print(f"gap index: {sum(gaps.values())} gaps across {len(gaps)} chapters")


if __name__ == "__main__":
    main()
