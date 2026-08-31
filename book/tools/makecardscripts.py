#!/usr/bin/env python3
"""Derive spoken reminder scripts from the 33 field cards.

The audio twin of the printed deck (makecards.py). Each card becomes a
short script, sixty to ninety seconds read aloud: the tool, when it
fires, the words, what to listen for, the score, the failure and the
recovery. Nothing is written here that is not on the card. The
conversion is mechanical: borders stripped, labels spoken as headings,
arrows and separators spoken as punctuation.

Source: the boxed cards in book/back-matter-cards.md, one per chapter,
in chapter order, so script NN is Chapter NN's card.

    python3 book/tools/makecardscripts.py -> book/audio/cards/
"""
import os, re, sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
sys.path.insert(0, HERE)
import makecards

OUT = os.path.join(ROOT, "book", "audio", "cards")

LABEL = re.compile(r"^([A-Z0-9][A-Z0-9&'/+ ]{1,14}?)\s{2,}(.*)$")


def speak(text):
    text = re.sub(r"\s*→\s*", ", ", text)
    text = re.sub(r"\s*·\s*", ". ", text)
    text = re.sub(r"\s+", " ", text).strip()
    return text


def script(card, n, total):
    inner = []
    for line in card.split("\n"):
        m = re.match(r"^│(.*)│\s*$", line)
        if m:
            inner.append(m.group(1).rstrip())

    # Header row: name on the left, part and stage on the right.
    head = inner[0].strip()
    parts = re.split(r"\s{2,}", head)
    name = parts[0].title()
    tag = speak(parts[-1]) if len(parts) > 1 else ""

    out = [f"Field card {n} of {total}. {name}." + (f" {tag}." if tag else "")]
    out.append("")

    thesis, fields = [], []
    cur = None
    for raw in inner[1:]:
        s = raw.strip()
        if not s:
            continue
        m = LABEL.match(s)
        if m and len(m.group(1).strip()) >= 2:
            cur = [(speak(m.group(2)), "→" in m.group(2))]
            fields.append((m.group(1).strip().title() + ".", cur))
        elif cur is not None:
            cur.append((speak(s), "→" in s))
        else:
            thesis.append(speak(s))

    if thesis:
        out.append(" ".join(thesis))
        out.append("")
    for label, pieces in fields:
        out.append(label)
        # An arrow row is a cue and its move; it gets its own line. Plain
        # rows are wrapped prose and rejoin into one.
        lines, buf = [], []
        for text, arrow in pieces:
            if not text:
                continue
            if arrow:
                if buf:
                    lines.append(" ".join(buf)); buf = []
                lines.append(text)
            else:
                buf.append(text)
        if buf:
            lines.append(" ".join(buf))
        out.extend(lines)
        out.append("")
    return "\n".join(out).rstrip() + "\n"


def main():
    found = makecards.cards()
    os.makedirs(OUT, exist_ok=True)
    for f in os.listdir(OUT):
        if f.endswith(".txt"):
            os.remove(os.path.join(OUT, f))
    for i, card in enumerate(found, 1):
        txt = script(card, i, len(found))
        first = txt.split(". ", 2)[1].lower()
        slug = re.sub(r"[^a-z0-9]+", "-", first).strip("-")
        path = os.path.join(OUT, f"{i:02d}-{slug}.txt")
        open(path, "w", encoding="utf-8").write(txt)
        leftover = set(txt) & set("│┌└├┐┘┤─—–")
        if leftover:
            raise SystemExit(f"card {i}: unspoken characters {leftover}")
    print(f"card scripts: {len(found)} files -> book/audio/cards/")


if __name__ == "__main__":
    main()
