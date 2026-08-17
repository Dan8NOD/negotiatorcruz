# Overnight Work Queue

Hourly blocks, roughly 15 minutes of work each, running Chicago midnight to
7am. Each firing takes **the top item not marked done**, does that item only,
commits, ticks the box, and stops.

## Rules for each block

1. Do **one** item. Do not start a second.
2. Commit and push before finishing. A block that ends uncommitted is lost
   work, because the container can be reclaimed.
3. Never fill a `[NEEDS:]` slot. Those are Dan's real cases and named expert
   voices. Inventing one would be worse than leaving the box empty, and it is
   the single rule that protects both books.
4. Rebuild derived output when chapters change:
   `python3 book/tools/build.py && python3 book/tools/makebook.py && python3 guide/tools/makeguide.py`
5. No dashes. Run `python3 book/tools/voicepass.py <files>` on anything new.
6. If every item is done, go to **New books** at the bottom and take the top
   one there. If that list is also done, stop the cron and say so.

---

## Queue

### Manual: The Cruz Protocol

- [x] **M1. Front matter.** Title page positioning line (a field manual, not a
      guide, not a journey), the "who this manual is for" page naming job
      titles explicitly (sales leaders, procurement, claims, legal, real
      estate principals, L&D), and the credentials page. Use the settled line:
      seven years of practice since Covid, five hosting, 1,000+ live sessions.
      Never "since 2024." → `book/front-matter.md`
- [x] **M2. Back matter, part 1: the Field Card appendix.** All 33 cards
      collected in order as a printable section, with a one-paragraph note on
      how to use them (print, laminate, one per desk). The cards already exist
      at the end of each `chNNb` file; this collects them.
      → `book/back-matter-cards.md`
- [x] **M3. Back matter, part 2: reference.** The emotion vocabulary reference
      (from the 1st Edition, expanded with the Torn/Ready/Not Yet triage), a
      blank manager's scorecard sized for a real floor, and one clean page on
      bringing the install in-house that names the ladder without pitching.
      → `book/back-matter-reference.md`
- [x] **M4. Consistency pass on Ch 1-3 and Ch 6.** These were drafted before
      the 544 shipped lines were available, so their script boxes are written
      rather than assembled. Reconcile against `book/02-LABEL-INVENTORY.md`.
      Flag rather than invent where no shipped line covers a slot.

### Guide: Six Before Yes

- [x] **G1. Front matter.** Cover, title and copyright with the IP notice,
      the introduction stating five theses flatly (the blueprint's model), and
      "how to use this guide" carrying the State Check instruction on page
      four. → `guide/front-matter.md`
- [x] **G2. Back matter.** Glossary of every marked term, the About
      Negotiators on Demand page, and the CTA page. One offer only: first
      Saturday session free. The one-page method summary already exists and
      slots in ahead of these. → `guide/back-matter.md`
- [x] **G3 moved.** Now runs inside the mandate list below, unchanged in
      scope, so the box here is closed to keep one live list.

---

## The mandate, Sun Aug 17

Dan's directive, given live in session: keep the queue firing every two
hours and get to at least four finished books inside one to two weeks. The
emphasis is negotiation in interpersonal relationships, personal finance,
and everyday situations, scaling all the way up to multi-million dollar
deals. New books cap near 100 pages.

What that means for the list:

1. **The Drill Book gets finished.** That is book three. Eight drill blocks
   plus indexes, per the format fixed in `drillbook/00-DECISIONS.md`.
2. **Book four is new: the everyday book.** Working title *Same Words,
   Bigger Rooms*, in `everyday/`. Decisions doc scaffolded first, same as
   the guide was. It is the consumer register done right: the 1st Edition's
   audience, the Protocol's actual tools, scripts from the same 544 shipped
   lines, and every real story flagged for Dan rather than invented.
3. **G3 and X1 stay live** and run inside the ordered list below.
4. **N3 stays parked.** Dan has not justified it and the standing rule
   holds. If every block below is done and Dan has not weighed in, stop and
   say so rather than starting it.

A block remains one item, committed and pushed, box ticked, one log line.

## The ordered list

- [x] **B4-0. Scaffold the everyday book.** `everyday/00-DECISIONS.md`:
      audience, register, the scale-arc structure, the chapter map with the
      family sources per chapter, and what stays flagged for Dan.
- [ ] **D1. Drills 01 to 05** to full format in `drillbook/`, per the
      decisions doc order.
- [ ] **B4-1. Everyday specimen chapter.** Chapter 1 written to full length
      to lock the voice, plus `everyday/tools/` build script cloned from the
      guide's.
- [ ] **D2. Drills 06 to 10.**
- [ ] **B4-2. Everyday Ch 2.**
- [ ] **D3. Drills 11 to 15.**
- [ ] **B4-3. Everyday Ch 3.**
- [ ] **D4. Drills 16 to 20.**
- [ ] **B4-4. Everyday Ch 4.**
- [ ] **D5. Drills 21 to 25.**
- [ ] **B4-5. Everyday Ch 5.**
- [ ] **D6. Drills 26 to 30.**
- [ ] **B4-6. Everyday Ch 6.**
- [ ] **D7. Drills 31 to 35.**
- [ ] **B4-7. Everyday Ch 7.**
- [ ] **D8. Drills 36 to 40.**
- [ ] **B4-8. Everyday Ch 8.**
- [ ] **D9. The two drill indexes** (by what is broken, by time and people)
      plus Part V program pages assembled from Ch 31 and the flagged
      Saturday format.
- [ ] **B4-9. Everyday Ch 9.**
- [ ] **B4-10. Everyday Ch 10.**
- [ ] **B4-11. Everyday Ch 11.**
- [ ] **B4-12. Everyday Ch 12,** the belief-family chapter, written only as
      far as the shipped lines allow and held behind Dan's sign-off note.
- [ ] **G3. Figure specs.** Seven guide figures are prose placeholders.
      Draw them as SVG in the same system as the manual's two diagrams, so
      the guide has one visual hand: master six-step diagram, authority map,
      positions/stakes waterline, influence map, balance-of-power grid,
      movement loop, and the closed loop.
- [ ] **B4-13. Everyday front matter.**
- [ ] **B4-14. Everyday back matter,** glossary aligned with X1's findings.
- [ ] **X1. Shared glossary audit,** now across all four manuscripts.
      Read/Disarm/Steer/Close, the three states, the leverage trio. Verify
      the definitions match word for word. A reader who owns two of these
      and finds them disagreeing is the worst outcome available.
- [ ] **B4-15. Everyday full voice pass and page-count check** against the
      100-page cap, then a rendered PDF proof.
- [ ] **D10. Drill Book full voice pass and page-count check,** then a
      rendered PDF proof.
- [ ] **N2. The Field Card Deck.** A physical product rather than a book: 33
      cards, print-ready at a real card size, with cut marks. The site
      already promises these as the training-day leave-behind.
- [ ] **N3. Objections: The Counter-Manual.** Not yet justified. Do not
      start without Dan. Listed only so the queue has a visible end.

---

## Log

Each block appends one line: date, item, what changed.

| When | Item | Result |
|---|---|---|
| Sat 23:5x CT (manual first block) | M1 | `book/front-matter.md`. Five pages: title with the positioning note, copyright carrying the honest attribution split, the who-this-is-for page naming eight job titles, the standard, and the author page on the settled seven-years-five-hosting line. |
| Sun 20:0x CT | M2 | `book/back-matter-cards.md`, all 33 cards collected by part. Found only 30 existed: Ch 14 had none, Ch 31 and 33 used a different format from the other thirty. Wrote card 14 (the Attack Decoder) and reformatted 31 and 33 to the standard 56-column box. All 33 now consistent and verified square. |
| Sun 20:1x CT | M3 | `book/back-matter-reference.md`. Emotion vocabulary grouped by six pressure categories with the four banned defaults called out, the state triage table, the blank twelve-row scorecard marked free to photocopy, and the honest in-house page that names the ladder once and stops. |
| Sun 20:2x CT | G1 | `guide/front-matter.md`. Cover, copyright with the Protocol cross-reference and IP split, the five theses stated flatly, how-to-use carrying the State Check on page four, and the standard. |
| Sun 20:2x CT | G2 | `guide/back-matter.md`. Twenty-term glossary with each term tagged to its step, the About page, and a CTA page that ends by pointing out it would be strange to close a book arguing you cannot learn this from a book by selling another one. |
| Mon (M4 block) | M4 | Ch 1, 2 and 6 script boxes reassembled from shipped lines. Ch 6 now carries all twelve labeling templates with the Chapter 5 blank, Ch 2's transitions quote the audit, calibrated and summary families, Ch 1's locating box uses listen, noq and notyet lines. The timeline slot has no shipped coverage and is flagged, gap count 34 to 35. Ch 3 has no script boxes, verified, nothing to reconcile. Cards 01, 02, 06 updated in chapters and appendix, all boxes verified square. |
| Sun eve (mandate) | B4-0 | `everyday/00-DECISIONS.md`. Fourth book scaffolded to Dan's live directive. Working title Same Words, Bigger Rooms. Twelve-chapter map across four parts, kitchen table to six zeros, every chapter sourced to shipped families, the belief family proposed as Ch 12 behind a sign-off flag, three open flags for Dan. Queue reordered into the mandate list and the two-hour Routine created. |
