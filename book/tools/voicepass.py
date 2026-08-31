#!/usr/bin/env python3
"""Dash removal + Chicago voice pass.

Two jobs that turn out to be the same job. An em dash almost always joins two
clauses; splitting them into two short declaratives is both the punctuation fix
and the register fix.

Rules are ordered. Fenced blocks hold Dan's shipped copy, so they get
punctuation fixes only, never word substitutions.

    python3 book/tools/voicepass.py [--dry] <paths...>
"""
import re, sys, os

# ---- dash rules, most specific first -------------------------------------

# joined by a connective -> comma
CONNECTIVE = (r"and|but|or|nor|so|yet|not|including|excluding|which|who|whose|"
              r"because|since|though|although|while|whereas|plus|minus|often|"
              r"usually|always|never|frequently|typically|ideally|especially|"
              r"particularly|specifically|generally|mostly|sometimes|rarely|"
              r"then|before|after|until|unless|if|when|where|with|without|for")

DASH_RULES = [
    # " — and " -> ", and "
    (re.compile(r"\s+—\s+(" + CONNECTIVE + r")\b"), r", \1"),
    # "word — word — word" paired parenthetical -> commas
    (re.compile(r"(\w)\s+—\s+([^—\n]{1,60}?)\s+—\s+(\w)"), r"\1, \2, \3"),
    # " — " before a pronoun/determiner starting a full clause -> new sentence
    (re.compile(r"([a-z0-9\)\]\"'])\s+—\s+(it|they|you|we|he|she|that|this|"
                r"these|those|there|here|nobody|everyone|someone|anyone|"
                r"most|many|both|each|all|none|every|one)\b(?=\s+\w)"),
     lambda m: f"{m.group(1)}. {m.group(2).capitalize()}"),
    # " — the/a/an/your/his/her/their + clause" -> new sentence
    (re.compile(r"([a-z0-9\)\]\"'])\s+—\s+(the|a|an|your|my|our|its|their|his|her)\b"),
     lambda m: f"{m.group(1)}. {m.group(2).capitalize()}"),
    # " — " before a capitalised word -> new sentence
    (re.compile(r"([a-z0-9\)\]\"'])\s+—\s+([A-Z])"), r"\1. \2"),
    # after terminal punctuation -> just drop the dash
    (re.compile(r"([.!?:;])\s+—\s+"), r"\1 "),
    # leading dash on a line (list continuation) -> nothing
    (re.compile(r"(?m)^(\s*)—\s+"), r"\1"),
    # anything left with lowercase either side -> comma
    (re.compile(r"(\w)\s+—\s+(\w)"), r"\1, \2"),
    # no-space em dash between words
    (re.compile(r"(\w)—(\w)"), r"\1, \2"),
    # stragglers
    (re.compile(r"\s*—\s*"), r", "),
]

# en dash: numeric ranges keep a hyphen, everything else follows the em rules
EN_RULES = [
    (re.compile(r"(\d)\s*–\s*(\d)"), r"\1-\2"),
    (re.compile(r"([A-Za-z])\s*–\s*(\d)"), r"\1 \2"),
    (re.compile(r"\s+–\s+"), r", "),
    (re.compile(r"–"), r"-"),
]

# ---- Chicago voice: plain words, no hedging ------------------------------

VOICE = [
    (r"\bIt is worth noting that\b", ""),
    (r"\bit is worth noting that\b", ""),
    (r"\bIt should be noted that\b", ""),
    (r"\bconsiderably more\b", "a lot more"),
    (r"\bconsiderably less\b", "a lot less"),
    (r"\bconsiderably better\b", "a lot better"),
    (r"\bconsiderably\b", "much"),
    (r"\bremarkably\b", ""),
    (r"\bgenuinely useful\b", "useful"),
    (r"\bgenuinely good\b", "good"),
    (r"\bprecisely\b", "exactly"),
    (r"\bfrequently\b", "often"),
    (r"\bapproximately\b", "about"),
    (r"\butilize\b", "use"),
    (r"\bIn order to\b", "To"),
    (r"\bin order to\b", "to"),
    (r"\bsubsequently\b", "then"),
    (r"\bnevertheless\b", "even so"),
    (r"\bnonetheless\b", "even so"),
    (r"\bmoreover\b", "and"),
    (r"\bfurthermore\b", "and"),
    (r"\bthus\b", "so"),
    (r"\bhence\b", "so"),
    (r"\bwhilst\b", "while"),
    (r"\bamongst\b", "among"),
    (r"\bbehaviour\b", "behavior"),
    (r"\bBehaviour\b", "Behavior"),
    (r"\bbehavioural\b", "behavioral"),
    (r"\brecognise\b", "recognize"),
    (r"\brecognised\b", "recognized"),
    (r"\borganisation\b", "organization"),
    (r"\bhonour\b", "honor"),
    (r"\bHonour\b", "Honor"),
    (r"\bhonoured\b", "honored"),
    (r"\bhonouring\b", "honoring"),
    (r"\bapologising\b", "apologizing"),
    (r"\bmanoeuvre\b", "maneuver"),
    (r"\bmanoeuvring\b", "maneuvering"),
    (r"\bmanoeuvres\b", "maneuvers"),
    (r"\bdefence\b", "defense"),
    (r"\bpractise\b", "practice"),
    (r"\bcalibre\b", "caliber"),
    (r"\bgrey\b", "gray"),
    (r"\bsignalled\b", "signaled"),
    (r"\bsignalling\b", "signaling"),
    (r"\btravelled\b", "traveled"),
    (r"\bcancelled\b", "canceled"),
    (r"\blabelled\b", "labeled"),
    (r"\bmodelled\b", "modeled"),
]
VOICE = [(re.compile(p), r) for p, r in VOICE]


def fix_dashes(t):
    for rx, rep in DASH_RULES:
        t = rx.sub(rep, t)
    for rx, rep in EN_RULES:
        t = rx.sub(rep, t)
    return t


def tidy(t):
    """Collapse runs of spaces mid-line only. Leading indent is structural."""
    t = re.sub(r"(?m)^([ \t]*)(.*)$",
               lambda m: m.group(1) + re.sub(r" {2,}", " ", m.group(2)), t)
    t = re.sub(r"\s+([,.;:!?])", r"\1", t)
    t = re.sub(r",\s*,", ",", t)
    # Collapse a doubled period, but never a chunk of an ellipsis. The
    # lookahead alone only guards the first pair, so "..." lost a dot on
    # the second pass. The lookbehind guards the rest.
    t = re.sub(r"(?<!\.)\.\s*\.(?!\.)", ".", t)
    t = re.sub(r"(?m)[ \t]+$", "", t)
    return t


BOX_L, BOX_R = "\u2502", "\u2502"


def realign_card(block):
    """Re-pad an ASCII field card so the right border lands square again.

    Text edits inside a card shift its right edge. Rather than leave the
    graphic broken, rebuild every rule and bordered row to one width.
    """
    lines = block.split("\n")
    body = [l for l in lines if l.strip().startswith(BOX_L)]
    if not body:
        return block
    # widest content, then a common inner width for every row
    inner = max(len(l.rstrip()[1:].rstrip(BOX_R).rstrip()) for l in body)
    inner = max(inner, 56)
    out = []
    for l in lines:
        s = l.rstrip()
        if not s:
            out.append(l); continue
        stripped = s.strip()
        if stripped.startswith("\u250c"):                       # top
            out.append("\u250c" + "\u2500" * inner + "\u2510")
        elif stripped.startswith("\u251c"):                     # divider
            out.append("\u251c" + "\u2500" * inner + "\u2524")
        elif stripped.startswith("\u2514"):                     # bottom
            out.append("\u2514" + "\u2500" * inner + "\u2518")
        elif stripped.startswith(BOX_L):
            content = stripped[1:]
            if content.endswith(BOX_R):
                content = content[:-1]
            content = content.rstrip()
            if len(content) > inner:
                content = content[:inner]
            out.append(BOX_L + content.ljust(inner) + BOX_R)
        else:
            out.append(l)
    return "\n".join(out)


def process(text):
    """Split on fenced blocks. Prose gets everything; fences get punctuation only."""
    # headings first, so "Chapter 8 - Title" does not become "Chapter 8. Title"
    text = re.sub(r"(?m)^(#+\s*Chapter\s*\d+)\s*[\u2014\u2013-]\s*", r"\1: ", text)
    text = re.sub(r"(?m)^(#+\s*FIELD CARD\s*\d+)\s*[\u2014\u2013-]\s*", r"\1: ", text)

    parts = re.split(r"(```.*?```)", text, flags=re.S)
    out = []
    for i, p in enumerate(parts):
        if i % 2:                       # fenced: Dan's shipped copy
            p = fix_dashes(p)
            if BOX_L in p:              # a field card: keep the graphic square
                p = realign_card(p)
            out.append(p)
        else:
            p = fix_dashes(p)
            for rx, rep in VOICE:
                p = rx.sub(rep, p)
            out.append(tidy(p))
    return "".join(out)


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    dry = "--dry" in sys.argv
    changed = 0
    touched = []
    for path in args:
        src = open(path, encoding="utf-8").read()
        new = process(src)
        if new != src:
            changed += 1
            touched.append(path)
            if not dry:
                open(path, "w", encoding="utf-8").write(new)
    print(("would change " if dry else "changed ") + f"{changed}/{len(args)} files")
    if dry and touched:
        for t in touched:
            print("   ", t)
    # In --dry the exit code is the point: it lets the pass gate a build
    # rather than only report. Applying changes is still a success.
    return 1 if (dry and changed) else 0


if __name__ == "__main__":
    sys.exit(main())
