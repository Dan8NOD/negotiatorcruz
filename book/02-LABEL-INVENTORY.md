# Source Inventory. The shipped copy behind "THE WORDS"

**Status update.** The source is no longer pending. Dan supplied the EPUB
(*NOD Academy, 1st Edition*) and it has been read in full. The diagnosis and the
old→new chapter mapping are in `01-SOURCE-AUDIT.md`. The chapter map is locked.

That makes this inventory more useful, not less. The 1st Edition supplies the
*doctrine* to rewrite. The tables below supply the *scripts*. They are
complementary sources, and neither one alone would produce a usable manual: the
book is 450 words a chapter with almost no verbatim copy, and these tables are
verbatim copy with no surrounding instruction.

What follows is the material that **already exists in structured form**.

Two live sources, both in the NOD-ify Supabase project (`iubxycckgrplbpdbncfk`):

| Source | Table | Volume | What it is |
|---|---|---|---|
| Tool write-ups | `negotiation_knowledge` | 16 tools | Mirrors `js/knowledge.js`. Full prose explanations in Dan's voice. |
| Scripted lines | `negotiation_labels` | **544 lines / 39 families** | Mirrors the `*_LABELS` arrays in `js/labels.js`. Each row carries `template`, `trigger_text`, and hard/soft variants. |

Both are described in their table comments as reference/training content, not
user data. They are the Protocol's canonical text, already reviewed and already
shipped inside the app.

**What this means practically:** the 544 scripted lines are the single hardest
part of a manual to write, and they already exist. Section 3 of every chapter
("THE WORDS") is the section that gets used and photocopied, and for 39 of the
Protocol's tools it can be assembled from shipped, tested copy rather than
invented. That is most of the book's actual value, available now.

---

## 1. The 544 lines, mapped to the four stages

Each family below is a candidate chapter or chapter-section. Counts are live.

### READ, 17 families, 205 lines
| Family | Lines | Type |
|---|---|---|
| `listen` | 25 | Listen For |
| `digging` | 15 | Information Label |
| `labeling` | 12 | Label ← *specimen chapter drafted from this* |
| `latent` | 12 | Latent Label |
| `mirror` | 12 | Mirror |
| `mislabel` | 12 | Mislabel |
| `somatic` | 12 | Somatic Read |
| `paraphrase` | 12 | Paraphrase |
| `silence` | 12 | Dynamic Silence |
| `power` | 12 | Power Label |
| `opener` | 12 | Opener |
| `clean` | 11 | Clean Language |
| `torn` | 11 | They're Torn |
| `ready` | 11 | They're Ready |
| `notyet` | 11 | No Problem Yet |
| `voice` | 10 | FM DJ Voice |
| `encourager` | 10 | Minimal Encourager |

### DISARM, 7 families, 100 lines
| Family | Lines | Type |
|---|---|---|
| `negatives` | 25 | Negative Label |
| `audit` | 15 | Accusation Audit |
| `empathy` | 12 | Empathy Statement |
| `acknowledge` | 12 | Acknowledgement |
| `trust` | 12 | Trust Repair |
| `positive` | 12 | Positive Label |
| `fairness` | 12 | Fairness Framing |

### STEER, 12 families, 150 lines
| Family | Lines | Type |
|---|---|---|
| `vision` | 13 | Vision Label |
| `loss` | 13 | Loss Aversion |
| `belief` | 13 | belief |
| `calibrated` | 12 | Calibrated Question |
| `anchor` | 12 | Anchor Probe |
| `bracket` | 12 | Bracket |
| `chip` | 12 | Bargaining Chip |
| `summary` | 12 | Summary |
| `focus` | 12 | Focusing Label |
| `elevation` | 12 | Elevation Label |
| `urgency` | 12 | Urgency Check |
| `asking` | 10 | Asking Label |

### CLOSE, 3 families, 87 lines
| Family | Lines | Type |
|---|---|---|
| `noq` | **64** | No-Oriented Question |
| `thatright` | 12 | That's Right |
| `onemore` | 11 | One More Thing |

> **Note the shape of that last table.** 64 No-Oriented Questions against 11
> "One More Thing" lines is not an accident of authoring. It reflects where the
> Protocol actually spends its effort. Part IV is titled *restraint as
> technique*, and the line counts back that up. Worth saying out loud in Ch 21.

---

## 2. The 16 tool write-ups, mapped to parts

From `negotiation_knowledge`. Chapter numbers are **provisional** until the PDF
locks the 31-tool catalog.

| Tool | Part | Note |
|---|---|---|
| Strike Zone | 0 / prep | Three numbers before you sit down. Natural Ch 3 companion. This is preparation, not a stage tool. |
| 3 Types of Leverage | 0 | Positive / negative / normative. Belongs near the front. It's a diagnostic frame, not a move. |
| The Columbo Effect | READ | Mindset chapter. Pairs with `voice` + `encourager`. |
| 7-38-55 | READ | Delivery. Governs *every* scripted line in the book, argues for placement early in Part I. |
| Spotting Liars | READ | Pairs with `listen`. |
| Spot Decision Makers | READ | Pronoun reading. Pairs with `digging` + `power`. |
| Similarity Principle | READ→DISARM | Doc itself flags overlap with Liking. Merge rather than duplicate. |
| Attack Decoder | DISARM | **Drafted.** See `chapters/ch14-the-discipline-of-not-defending.md`. |
| Deflect the Punch | DISARM | Pairs with `anchor`. |
| Strategic Umbrage | DISARM | Pairs with `negatives`. |
| I-Statements | DISARM | Pairs with `empathy`. |
| Extreme Anchor | STEER | Pairs with `anchor` + `bracket`. |
| Power of Hopes & Dreams | STEER | Doc flags overlap with `vision`. Merge. |
| Saying No 4 Times | STEER/CLOSE | Four-beat sequence. Pairs with `noq`. |
| Rule of Three | CLOSE | Commitment verification. Pairs with `thatright`. |
| Email Magic | Under Pressure | Async/stalled negotiation. Part V (Ch 26-30) material. |

---

## 3. Coverage assessment

**Draftable now, to full seven-part spine:** the 39 label families and 16 tools
above cover Parts I-IV comfortably. That is roughly chapters 4 through 28.

**Draftable now, no source needed:** Part VI (Ch 31 and 33). These are new
installation material, not a rewrite of anything. The architecture doc says they
"do more for the consulting rate than the other 31 combined," and nothing blocks
them. **Both drafted.**

**Blocked on the PDF:**
- Exact tool→chapter numbering against the published 31-tool catalog.
- Part 0 (Ch 1-3), needs the published framing to rewrite *against*.
- Anything where the existing book makes a claim we'd contradict.

**Blocked on Dan, not on any document:**
- Every `[NEEDS: what is missing]` marker. Real client situations, real numbers, real
  objections, real outcomes. Per the architecture doc these get flagged, never
  invented. That rule holds without exception.
- Part V (Ch 26-30), especially the failure chapter. "When the Protocol fails"
  cannot be written from tool documentation. It needs cases where it actually
  did, and only Dan has those. This chapter is the single strongest credibility
  signal in the book and the one most dependent on real material.

---

## 4. Reseeding note

Both tables are mirrors, not originals. `negotiation_knowledge` mirrors
`js/knowledge.js`; `negotiation_labels` mirrors the `*_LABELS` arrays in
`js/labels.js`. If the manual's wording of a tool improves on the app's, the
edit belongs in the JS source and gets reseeded through the
`knowledge-search` / `label-search` seed functions, not written directly to the
table, where the next reseed would silently overwrite it.
