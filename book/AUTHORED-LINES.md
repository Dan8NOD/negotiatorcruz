# Authored lines: where the manual's boxes are not shipped copy

Found Fri Aug 28 by `book/tools/verifylines.py --drift`, which was written
to enforce rule 4 (every scripted line comes from the 544 shipped lines)
and ended up measuring how far the finished manual actually keeps it.

**Read the number carefully before reacting to it.** A naive sweep says
135 boxed lines are not in the catalog. Most of those are benign and
explained below. The number that matters, and the only one that needs a
decision from Dan, is **41 counterpart-facing lines in Part V.**

---

## What the sweep found, sorted honestly

### 1. Extraction artifacts. Not a problem.

Lines like *"Okay, say more about that."* in Chapter 4 are shipped, in
full, as `"Okay, say more about that." Then close your mouth.` The sweep
split the quote from its instruction and failed the half. The drift mode
now checks each line whole before splitting, and reports nothing here.

### 2. Slot lines and worked mirror dialogue. Correct by design.

Chapter 6's twelve labeling templates carry the `{em}` blank, so they
cannot match a catalog line that still has the slot in it. Chapter 7's
mirrors echo invented counterpart speech, which by definition is not in
any catalog. Both are the books working as intended.

### 3. One recovery line per chapter, roughly 32 of them.

Every chapter's failure-mode section ends with a sentence you say to
recover, and almost all of them are authored. They are not counterpart
scripts pulled from a family, they are repair sentences for the operator.
Three were rewritten to end on shipped lines during the M4 pass, which is
the pattern worth extending if Dan wants them all sourced. **Low
priority. Defensible as they stand.**

### 4. Facilitator speech in Part VI. A different genre.

Chapters 31, 32 and 33 carry manager speeches, coaching phrases and
scorecard language, roughly 24 lines. None of it is negotiation copy and
none of it was ever going to come from a negotiation catalog. **Not an
issue.** Worth Dan's eye only because he actually says these things on
real floors and his versions would be better.

---

## 5. The real finding: 41 authored lines in Part V

Chapters 26 to 29 put counterpart-facing negotiation questions in script
boxes, unmarked, exactly where a reader has been trained by the first
twenty-five chapters to expect shipped copy. The catalog has no renewal,
procurement, claims or internal-negotiation family, so these were
written rather than assembled.

They are not bad lines. That is exactly the risk the project's own rule
names: invented scripts read plausible and drill soft. Part V is also
where a corporate evaluator looks hardest, per Chapter 3's own reader
path.

| Chapter | Authored, counterpart-facing |
|---|---|
| 26. The Renewal and the Price Increase | 10 |
| 27. Procurement and the Committee You Can't See | 10 |
| 28. Claims, Disputes, and Escalation | 6 |
| 29. Negotiating Internally | 15 |

The list itself is in **`book/PART-V-LINES.md`**, one line per row with a
column to mark K, R or S. That is the file to read. Regenerate it with:

    python3 book/tools/verifylines.py --sheet book/chapters/ch2[6-9]a*.md

Two corrections to an earlier version of this page. The command printed
here was `--drift`, which reports near-misses and prints none of these,
so it produced an empty list. Strict mode is the one that finds them.
And the tool was counting four numbered instruction labels in Chapter 28
as authored lines, because a label arrives at the check as the remainder
after its own quote is stripped and the header filter never saw it. With
that fixed the tool now returns 6 for Chapter 28, agreeing exactly with
the count made here by reading. Chapter 29 comes out at 15 rather than
14, and all fifteen read as counterpart-facing.

### Three options, and a recommendation

1. **Bless them.** Dan reads the forty, keeps what he already says in
   real renewals and claims calls, and they stop being provisional.
   Cheapest, and probably right for most of them.
2. **Replace them with real language.** Dan has run these calls for
   seven years. His actual renewal questions almost certainly beat the
   drafted ones, and they would arrive already tested.
3. **Seed them into the catalog.** If any survive as keepers, the
   reseeding note in `02-LABEL-INVENTORY.md` applies: the edit belongs
   in `js/labels.js` and flows through the seed function, not into the
   table directly, or the next reseed silently overwrites it. This is
   the option that makes the promise fully true rather than nearly
   true, and it also feeds the app.

**Recommended:** option 1 for the bulk, option 2 for the renewal and
claims chapters where Dan's practice is deepest, and option 3 for any
line that earns it, since four families for Part V would strengthen the
app as much as the book.

Until Dan rules, the lines stay exactly as they are. They are honest
prose written to teach the right move. They are simply not yet his
words, and this file exists so nobody later mistakes them for shipped
copy.
