# Handoff prompt

Paste everything below the line into a new session.

---

Continue the Negotiators on Demand book project. Read `OVERNIGHT-QUEUE.md`
first, then this whole message before starting.

## Repo and branch

Repo `Dan8NOD/negotiatorcruz`. Work on branch
`claude/book-rewrite-corporate-manual-97c3fb`. Several PRs from this project
are already merged to `main`, so if the open PR for that branch has been
merged, restart the branch from `main` and open a new draft PR rather than
stacking on merged history.

## What exists

**Three books, all in the repo.**

1. **`book/`, The Cruz Protocol.** A 33-chapter corporate field manual,
   ~60,000 words, complete. Rewritten from Dan's Kindle book *NOD Academy*,
   which was consumer self-help built on five dreams. The rewrite stripped the
   dream sourcing, replaced seven consumer chapters, aligned the book to the
   website's four-stage Protocol, and rebuilt every chapter to a fixed
   seven-part spine. Front matter, back matter and all 33 field cards are
   done. Renders to a 226-page PDF.

2. **`guide/`, Six Before Yes.** A 60-page Negotiators on Demand guide built
   to a blueprint Dan supplied (`BookBlueprint.docx`, modeled on *Negotiator*
   by Combalbert & Mery with the Black Swan parallel-grid device). Seven
   chapters covering the deal arc *around* the conversation. The Protocol is
   Step 5 of 6, so the two books cross-sell instead of competing. Front and
   back matter done. Includes a working assessment at
   `guide/assessment/state-check.html`.

3. **`drillbook/`, The Drill Book.** Just scaffolded. Decisions doc and the
   facilitator method are written. The 40 drills themselves are not.

4. **`everyday/`, Same Words, Bigger Rooms.** The fourth book, scaffolded
   Sun Aug 17 on Dan's live directive: interpersonal relationships, personal
   finance, everyday situations, scaling to multi-million dollar deals, near
   100 pages. Decisions doc and chapter map exist. The twelve chapters do
   not. A Routine fires this session every two hours to work the queue.

## The rules, in priority order

1. **Never fill a `[NEEDS:]` slot.** There are ~34 of them across the two
   finished books. They are real client cases and named expert voices, and
   only Dan can supply them. An empty flagged box is honest. An invented case
   is the one thing that would let a corporate reader catch the books out, and
   Part V of the manual is exactly where they would look. This rule has held
   through the whole project. Do not break it.

2. **No dashes.** Zero em dashes or en dashes anywhere in either manuscript.
   Run `python3 book/tools/voicepass.py <files>` on anything you write. It
   also handles British spellings and formal hedges.

3. **Chicago plain-speech.** Short declaratives. No semicolons. Avoid the
   formal register: the words `voicepass.py` strips are listed in its `VOICE`
   table, so read that rather than trusting a list here (this file was itself
   run through the pass, which rewrote an earlier attempt at listing them).
   If a sentence runs past about 40 words, split it.

4. **Scripts come from Dan's shipped copy, not from you.** 544 reviewed
   negotiation lines live in Supabase project `iubxycckgrplbpdbncfk`, table
   `negotiation_labels` (columns: `section`, `type_name`, `tier`, `template`,
   `trigger_text`). Tool write-ups are in `negotiation_knowledge`. Every
   "THE WORDS" box is assembled from these. Invented scripts read plausible
   and drill soft. A read-only export of both tables is checked in at
   `book/data/`, refreshed Aug 26, for when the connector is absent. The
   table stays canonical. Do not edit the export.

5. **Commit and push every unit of work.** The container gets reclaimed.

## Build commands

    python3 book/tools/build.py # narration + GAP-INDEX.md
    python3 book/tools/makebook.py # Cruz Protocol -> build/
    python3 guide/tools/makeguide.py # Six Before Yes -> build/
    python3 book/tools/voicepass.py <files> # dash + voice pass

Note: `voicepass.py` rewrites prose outside fenced blocks. If you are writing
*about* the banned words rather than using them, put them in a code fence or
the pass will helpfully replace them.

PDFs render with the preinstalled chromium:

    /opt/pw-browsers/chromium-1194/chrome-linux/chrome --headless --no-sandbox \
      --disable-gpu --no-pdf-header-footer \
      --print-to-pdf=build/NAME.pdf file:///home/user/negotiatorcruz/build/NAME.html

`build/` is gitignored on purpose. The PDFs are derived, not sources.

## What is left, in order

M1 through M4, G1 and G2 are done. Everything remaining lives in the
ordered list in `OVERNIGHT-QUEUE.md` under **The mandate, Sun Aug 17**:
finish the Drill Book (blocks D1 to D10), write the everyday book (blocks
B4-1 to B4-15), then G3, X1, N2. Dan's directive is at least four finished
books inside one to two weeks, so the drill and everyday blocks alternate
and take priority over polish. Take the top unticked item, do that item
only, commit, push, tick, log, stop. N3 stays parked without Dan.

## Open questions for Dan, do not decide these alone

- The `belief` family in `negotiation_labels`, 13 lines, still has no home.
  It is the deepest material in the catalog and reads as coaching rather than
  commercial negotiation. Options: its own advanced chapter, folded into
  manual Ch 29, or held for a later book.
- Trademark search on "Six Before Yes" before it prints.
- Seven expert voices for the guide, longest lead time in the project.
- The Saturday session format as it currently runs. The version in the 1st
  Edition is five years old.

## Style notes worth keeping

- Chapters use a colon: `# Chapter 8: Tactical Silence`. Both build scripts
  parse that form.
- Field cards are 56-column bordered boxes. The card builder in the drill book
  work asserts on overflow so a clipped card fails loudly.
- Every chapter is split into two segments, `chNNa` (The Method) and `chNNb`
  (The Practice). That split is also the audiobook boundary: A narrates, B is
  reference.
- Dan is a Marine veteran in Chicago, seven years practicing, five hosting,
  1,000+ live sessions. Never write "since 2024", which is on the site and
  undersells him by three years.
