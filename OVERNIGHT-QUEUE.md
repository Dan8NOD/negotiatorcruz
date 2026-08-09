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
- [ ] **M2. Back matter, part 1: the Field Card appendix.** All 33 cards
      collected in order as a printable section, with a one-paragraph note on
      how to use them (print, laminate, one per desk). The cards already exist
      at the end of each `chNNb` file; this collects them.
      → `book/back-matter-cards.md`
- [ ] **M3. Back matter, part 2: reference.** The emotion vocabulary reference
      (from the 1st Edition, expanded with the Torn/Ready/Not Yet triage), a
      blank manager's scorecard sized for a real floor, and one clean page on
      bringing the install in-house that names the ladder without pitching.
      → `book/back-matter-reference.md`
- [ ] **M4. Consistency pass on Ch 1-3 and Ch 6.** These were drafted before
      the 544 shipped lines were available, so their script boxes are written
      rather than assembled. Reconcile against `book/02-LABEL-INVENTORY.md`.
      Flag rather than invent where no shipped line covers a slot.

### Guide: Six Before Yes

- [ ] **G1. Front matter.** Cover, title and copyright with the IP notice,
      the introduction stating five theses flatly (the blueprint's model), and
      "how to use this guide" carrying the State Check instruction on page
      four. → `guide/front-matter.md`
- [ ] **G2. Back matter.** Glossary of every marked term, the About
      Negotiators on Demand page, and the CTA page. One offer only: first
      Saturday session free. The one-page method summary already exists and
      slots in ahead of these. → `guide/back-matter.md`
- [ ] **G3. Figure specs.** Seven figures are currently prose placeholders.
      Draw them as SVG in the same system as the manual's two diagrams, so the
      guide has one visual hand: master six-step diagram, authority map,
      positions/stakes waterline, influence map, balance-of-power grid,
      movement loop, and the closed loop.

### Cross-book

- [ ] **X1. Shared glossary audit.** Both books use Read/Disarm/Steer/Close,
      the three states, and the leverage trio. Verify the definitions match
      word for word across the two manuscripts. A reader who owns both and
      finds them disagreeing is the worst outcome available.

---

## New books

Only start these when the queue above is clear.

- [ ] **N1. The Drill Book.** The strongest candidate, because it is the only
      artifact that matches the doctrine. Both books argue that reading does
      not teach this. A drill book is the Saturday-session curriculum in
      print: all 33 manual drills plus the 7 guide drills, expanded with
      setup, timing, scoring, and a facilitator note. Sells as the training-day
      workbook and as the thing a manager runs without Dan in the room.
      Scaffold `drillbook/` the way `guide/` was scaffolded: decisions doc
      first, then structure, then one drill written to full length as the
      specimen.
- [ ] **N2. The Field Card Deck.** A physical product rather than a book: 33
      cards, print-ready at a real card size, with cut marks. The site already
      promises these as the training-day leave-behind, so this is fulfilling
      an existing promise rather than inventing a product.
- [ ] **N3. Objections: The Counter-Manual.** Not yet justified. Do not start
      without Dan. Listed only so the queue has a visible end.

---

## Log

Each block appends one line: date, item, what changed.

| When | Item | Result |
|---|---|---|
| Sat 23:5x CT (manual first block) | M1 | `book/front-matter.md`. Five pages: title with the positioning note, copyright carrying the honest attribution split, the who-this-is-for page naming eight job titles, the standard, and the author page on the settled seven-years-five-hosting line. |
