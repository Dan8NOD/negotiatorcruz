# Rewrite Progress

Working docs: `00-ARCHITECTURE.md` (standard) · `01-SOURCE-AUDIT.md` (diagnosis
+ old→new mapping, §5 has the settled decisions) · `02-LABEL-INVENTORY.md`
(the 544 shipped scripted lines and 16 tool write-ups already in Supabase,
mapped to stages — this is where Section 3 "THE WORDS" comes from).

**Decisions locked:** Stages = the sequence, Levels = the certification ladder ·
Separate corporate title, consumer 1st Edition stays live.

**Drafting rule for remaining chapters.** Section 3 ("THE WORDS") is assembled
from the 544 shipped lines in `02-LABEL-INVENTORY.md`, not invented. Shipped
copy has been reviewed and used; invented scripts read plausible and drill
soft. Where a chapter's family has no shipped lines, that's flagged rather than
filled. Ch 1–3 and Ch 6 were drafted before the inventory existed and their
script boxes should be reconciled against it in the consistency pass.

## Repo layout

- `chapters/` — **canonical.** Every chapter is split into two segments:
  `chNNa-*.md` (Part 1 · The Method — standard, triggers, the words, what good
  sounds like) and `chNNb-*.md` (Part 2 · The Practice — drill, scoring,
  failure mode, evidence slot, field card). Edit these.
- `audio/` — **generated.** Narration scripts, one `.txt` per segment. Markdown
  stripped, tables spoken as sentences, script boxes read as quotes, dialogue
  rendered as "They say / You say", ASCII field cards omitted as visual-only.
- `GAP-INTAKE.md` — the extraction questions for every open gap. Answer these
  rather than writing cases.
- `GAP-INDEX.md` — **generated.** Where real material is still needed, ranked by
  gaps × commercial weight.
- `tools/build.py` — regenerates `audio/` and `GAP-INDEX.md`. Run after editing
  any chapter: `python3 book/tools/build.py`

| # | Chapter | Part | Status |
|---|---|---|---|
| 1 | The Negotiation Is Already Running | 0 · Standard | ✅ drafted |
| 2 | The Four Stages | 0 · Standard | ✅ drafted |
| 3 | How to Use This Manual | 0 · Standard | ✅ drafted |
| 4 | Diagnose Before You Ask | I · Read | ✅ drafted |
| 5 | The Emotion Vocabulary | I · Read | ✅ drafted |
| 6 | Labeling | I · Read | ✅ drafted |
| 7 | Mirroring | I · Read | ✅ drafted |
| 8 | Tactical Silence | I · Read | ✅ drafted |
| 9 | Reading the Decision Structure | I · Read | ✅ drafted |
| 10 | The Accusation Audit | II · Disarm | ✅ drafted |
| 11 | The Negative Label *(retitled)* | II · Disarm | ✅ drafted |
| 12 | The Power of "No" | II · Disarm | ✅ drafted |
| 13 | Validation | II · Disarm | ✅ drafted |
| 14 | The Discipline of Not Defending | II · Disarm | ✅ drafted |
| 15 | The Calibrated Question | III · Steer | ✅ drafted |
| 16 | The Asking Label *(retitled)* | III · Steer | ✅ drafted |
| 17 | Paraphrase and Summary | III · Steer | ✅ drafted |
| 18 | Trading — Never Give, Always Swap | III · Steer | ✅ drafted |
| 19 | Anchoring *(retitled)* | III · Steer | ✅ drafted |
| 20 | Deadline Dynamics | III · Steer | ✅ drafted |
| 21 | No-Oriented Questions | IV · Close | ✅ drafted |
| 22 | The "That's Right" Summary | IV · Close | ✅ drafted |
| 23 | The Fairness Standard *(retitled)* | IV · Close | ✅ drafted |
| 24 | Reframing | IV · Close | ✅ drafted |
| 25 | One More Thing *(retitled)* | IV · Close | ✅ drafted |
| 26 | The Renewal and the Price Increase | V · Applications | ✅ drafted |
| 27 | Procurement and the Committee You Can't See | V · Applications | ✅ drafted |
| 28 | Claims, Disputes, and Escalation | V · Applications | ✅ drafted |
| 29 | Negotiating Internally — Up, Down, Sideways | V · Applications | ✅ drafted |
| 30 | When the Protocol Fails | V · Applications | ✅ drafted |
| 31 | The 30-Day Rollout | VI · Installation | ✅ drafted |
| 32 | Coaching the Floor | VI · Installation | ✅ drafted |
| 33 | The Manager's Scorecard | VI · Installation | ✅ drafted |

**ALL 33 CHAPTERS DRAFTED.** Remaining work is real case material (see
`GAP-INTAKE.md`), the consistency pass on Ch 1–3 and Ch 6 script boxes, the
`belief` family decision, and front/back matter.

**Front/back matter:** not started. Write last — front matter is the Amazon
"Look Inside" sample and the highest-traffic real estate in the business.

---

## Open `[NEEDS:]` items for Dan

Collected as they accumulate. Nothing in the manual gets fabricated; these are
the places real material has to go in.

| Where | What's needed |
|---|---|
| Title | Final call. Working: *The Cruz Protocol: A Field Manual for Commercial Negotiation* |
| Ch 1 | A real deal where the position was set internally before first contact, and finding that out changed the approach. Corporate, committee behind it. 150–200 words. |
| Ch 2 | A deal that stalled because a stage was skipped — ideally Disarm — and what changed when the sequence ran in order. |
| Ch 6 | A negotiation where a label surfaced an obstacle nobody had stated. Corporate, committee behind it. |
| Ch 6 | Decision on the affect-labeling / fMRI claim carried over from 1st Ed. Ch 7: cite the UCLA research properly, or soften the claim. As written it overreaches. |
| ~~Front matter~~ | ~~Confirm the credentials line.~~ **RESOLVED** — see Credentials below. |
| ~~Throughout~~ | ~~Real corporate cases for Part V.~~ **RESOLVED** — Dan is supplying real cases. See Part V rule below. |
| Ch 14 | Confirm the chapter's scope is the Attack Decoder rather than a broader survey of defending — the audit locked the title, not the contents. |
| Ch 14 | Three real opening attack lines, one per type (defensive / unheard / tactical), from actual sessions. Invented attacks run too polite and the drill goes soft. |
| Ch 31 | One real before/after on talk-time ratio or concessions-after-silence from a client floor. The rollout reads as theory without a number that actually moved. |
| Ch 33 | Real inter-rater data — even two managers × ten tapes — to make the rubric defensible rather than plausible. |
| Ch 11 | **Retitle confirmation.** Locked map said "Naming Your Own Weakness First." The shipped `negatives` family (25 lines) is broader — it names the bad thing in the room whoever it belongs to, not just your own weakness. Retitled to **The Negative Label** to match the material. Revert if you'd rather keep the original scope. |
| Ch 30 | The `acknowledge` family (12 lines) has no home in the current map. Every line names deadlock — *"Sounds like that's a no," "It looks like there's nothing I can say to change your mind."* That is Ch 30 (When the Protocol Fails) material and it should live there. Confirm. |
| Ch 16 | **Retitle confirmation.** Locked map said "How and What, Never Why." That's a grammar rule, not a chapter — it governs every calibrated question and now lives inside Ch 15. The shipped `asking` family (10 lines) had no home and is a genuinely distinct tool: get the answer without asking the question. Retitled to **The Asking Label**. Second instance of the same drift — see Ch 11. |
| Mapping | **Pattern worth noting.** Both retitles (Ch 11, Ch 16) are slots the audit described as "Ch N expanded" — invented before the shipped catalog was available. The remaining un-drafted "expanded" slots should be checked against their families before drafting, not after. |
| Steer leftovers | Four Steer families still have no chapter: `vision` (13), `belief` (13), `focus` (12), `elevation` (12) — 50 lines. `vision` likely merges into Ch 24 (Reframing); the other three need a decision. |
| Ch 19 | **Retitle confirmation.** Locked map said "The Ackerman System" (from 1st Ed Ch 13). Checked the catalog *before* drafting this time — the shipped families are `anchor` (probing their number) and `bracket` (ranges). Ackerman is one move inside anchoring, not the subject. Retitled to **Anchoring**, widened to probe/bracket/set, with the ladder kept as a section. |
| Gaps | `GAP-INTAKE.md` turns all 22 open gaps into questions to answer rather than prose to write. Answer six questions per chapter, in fragments, out of order — that's enough to draft from. |
| Ch 23 | **Retitle.** Map said "'Fair' and Multiple Offers." The shipped `fairness` family is not the F-word as leverage — all 12 lines are *you offering fairness as a standing invitation to be corrected*. MESO has no shipped lines at all. Retitled **The Fairness Standard**. |
| Ch 25 | **Retitle.** Map said "The Six-Second Hold," but that is already taught in Ch 8 and Ch 15; a third pass is repetition. The `onemore` family had no chapter and is the move that finishes a negotiation. Retitled **One More Thing**. |
| **`belief` family** | **Needs a decision — this is the standout unhoused material.** 13 lines, and they are not commercial negotiation: *"It seems like somewhere along the way, you started believing you don't get to ask for what you actually want."* The trigger names core beliefs — uselessness, hopelessness, worthlessness. This is the deepest writing in the whole catalog and it has no home in the locked map. Options: an advanced chapter of its own, fold into Ch 29 (Negotiating Internally), or hold it for a second book. It should not be quietly absorbed. |
| Pricing | The ladder moved 2026-08-03 to $1,500 / $12,500 / $40–55K. `00-ARCHITECTURE.md` §1 is updated; anything downstream quoting the old numbers needs the same pass. |
| Front/back matter, Ch 24 | **Dream-material removal — not yet verified, because nothing it applies to has been drafted.** When these get written, confirm: no "Dream Spine" framing survives in front matter (the underlying doctrine may, per audit §2.2, but not the dream language); "The Unseen Layer" does not appear anywhere in back matter; and if the `vision` family (Power of Hopes & Dreams, 13 lines) merges into Ch 24, it's reworded into corporate outcome/objective language rather than ported over with the consumer-edition "dream" framing intact. This is a plan today, not a diff — check the actual draft against this list, don't assume the removal list did the work. |

---

## Credentials — settled

Practice began during Covid. **Seven years of deliberate practice, five of them
hosting weekly sessions.** Use that formulation, or a subset of it, everywhere —
front matter, back matter, site, and any evidence block that reaches for
authority.

Two things to keep straight, because they are different claims:

- *Seven years* is the practice. It starts at Covid and runs to now.
- *Five years* is the hosting — the Saturday sessions, the 1,000+ live reps,
  the part with witnesses.

Do **not** write "since 2024." That number is on the site now and it
undersells the record by three years. The 1st Edition's "five years and 1,000+
sessions" was closer but conflated practice with hosting. The corrected line
is the one above, and it should replace both.

## Part V — real cases only

Dan is supplying the case material for Chapters 26–30 himself. No invented
scenarios, no composites, no illustrative-but-fictional client stories. Where a
case is missing, the slot stays a `[NEEDS:]` flag until real material arrives —
an empty flag is honest, a plausible invention is not, and Part V is precisely
where a corporate reader would catch the difference.

This extends the standing no-fabrication rule; it does not replace it. The rule
applies to every chapter. Part V is called out because it's the part most
likely to tempt a writer into filling a gap.

## Contact route — settled

**Corrected 2026-08-04.** This section previously recorded that
`negotiationsondemand@gmail.com` was "not a typo, confirmed by Dan." That was
wrong, and it was actively dangerous — it instructed future passes to restore a
dead address.

Dan has now confirmed directly: **he receives mail only at
`negotiatorsondemand@gmail.com`** (negotiat-*or*-sondemand). The
`negotiat-ion-sondemand` spelling reaches an inbox he does not read. The
evidence lines up: 201 mail threads at the correct address and none at the
other, every other identifier on the property uses *negotiator-s*
(Calendly, TikTok, the sister domain, the account this repo is administered
from), and `docs/agent-backlog/verify.sh` has been failing the build on the
wrong spelling all along.

Use `negotiatorsondemand@gmail.com` everywhere. Nothing here is struck.

Separately — and this part was always sound — Dan's preference is to route
people to a **short domain** rather than an email address at all.
`negotiatorsondemand.com` is long and hard to spell out loud, which is the
actual problem worth solving.

**Recommendation:** use `negotiatorcruz.com`. It is fourteen characters shorter
than negotiatorsondemand.com, it is already the corporate brand this manual
belongs to, and it is spellable on a phone call in one pass. `nodnews.com` is
shorter still but it is a news property — sending a corporate buyer there
mid-decision lands them somewhere with different intent and no booking path.
Keep nodnews for what it is.

One caveat for the site specifically: the contact-form failure message needs a
route that isn't the thing that just failed. A domain works; a Calendly link
works better, since it's a separate system and can't be down for the same
reason. `[NEEDS: Dan's call on the exact string]`

## Carried over for removal

Tracked so nothing gets missed in the final pass. **None of this is verified
yet** — front/back matter and Ch 24 are still un-drafted, so this list is a
plan for the writer to check against, not a record of work already done. See
the "Front/back matter, Ch 24" row in the NEEDS table above.

- The Dream Spine front-matter section — doctrine survives (audit §2.2), sourcing goes
- **The Unseen Layer** back-matter section — remove entirely
- "Shamelessly promote NOD services" — instructor note in the Feedback Framework
- *From the Masters* — Blair Warren manipulation framing, Dan Lok "Forbidden
  Tactics" / "covert persuasion". Contradicts the Pledge (audit §2.5)
- Consumer level tests (free coffee, free upgrade) — replace with corporate
  certification tests per Ch 2's Level table
- `negotiationsondemand@gmail.com` wherever it appears — **un-struck 2026-08-04.**
  It *is* the wrong address; Dan reads only `negotiatorsondemand@gmail.com`. The
  earlier "not a typo, confirmed by Dan" entry here was mistaken. Fixed in
  `guide/assessment/state-check.html`; see "Contact route" above.
