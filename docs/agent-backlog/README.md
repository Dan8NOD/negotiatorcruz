# Agent backlog — operating rules

This directory holds a pre-scoped work package for `negotiatorcruz.com`.

The audit was done once, by a high-reasoning model, against the working tree at
commit `3287a4b`. Every task in `TASKS.md` already carries its file path, its
anchor text, and its replacement text. **The expensive thinking is finished.**
The implementing agent's job is transcription and verification, not discovery.

Run the work with **Sonnet 5** (`claude-sonnet-5`). The rules below exist to keep
that run cheap. They are not stylistic preferences — each one removes a specific
class of token spend.

---

## Rules for the implementing agent

1. **Do not explore.** Do not run `find`, do not grep for context, do not open
   files to "get oriented". Every file you need is named in the task. Reading
   anything else is wasted spend.

2. **Do not spawn subagents.** No `Agent` / `Task` tool, no `Explore`, no `Plan`.
   A subagent starts cold and re-derives context this document already contains.
   That is the single most expensive mistake available to you here.

3. **One read per file, then batch every edit for that file.** Tasks are grouped
   by file in `TASKS.md` for exactly this reason. Read `index.html` once, apply
   all six of its edits, move on. Do not re-read a file to confirm an edit
   landed — `Edit` errors if it does not match.

4. **Verify with the script, not with your eyes.** `./docs/agent-backlog/verify.sh`
   checks every task in one Bash call. Use it instead of re-reading files.

5. **Do not enter plan mode and do not run `/code-review` or `/security-review`.**
   The work is already reviewed. Implement it.

6. **Skip T1 unless the owner has answered it.** It is blocked on a human
   decision, flagged in the task. Do not guess.

7. **Commit in the three batches given below**, not per task. Push once at the end.

Target for the whole run: **one session, under ~60k tokens of context.** If you
find yourself searching the repo, stop — you have left the intended path.

---

## Batches

| Batch | Tasks | Files touched | Commit message |
|---|---|---|---|
| 1 — Defects | T2, T3, T4, T5 | `nod-coin.png` (delete), `index.html`, `assets/site.js` | `fix: honour reduced-motion in cross-promo ad, clamp parallax, drop 5MB unused asset` |
| 2 — Structured data & head | T6, T7, T8, T9 | all six `*.html` | `seo: FAQPage + per-page structured data, og:image:alt, theme-color, apple-touch-icon, calendly preconnect` |
| 3 — Infra & polish | T10, T11, T12 | `vercel.json`, `404.html` (new), `index.html` | `chore: asset cache headers, 404 page, industries grid consistency` |

Run `verify.sh` after each batch. It is idempotent and takes under a second.

---

## What is deliberately NOT in this backlog

Two items came out of the audit that are real but are **not** Sonnet-shaped work.
They are recorded here so they are not lost, and so nobody tries to fold them in:

- **Content-Security-Policy.** `vercel.json` ships no CSP. Adding one is
  worthwhile, but this site has inline `<style>` and inline `<script>` blocks in
  `index.html` and `contact.html`. A correct CSP means either hashing those or
  extracting them, and a wrong CSP silently breaks the lead form. Needs a
  dedicated pass with a real preview deploy, not a find-and-replace.

- **Account-level repo sprawl.** The GitHub account carries what look like several
  parallel copies of the same project — `nodnews` / `nodnews.com` / `nodnew`,
  `fatcatam` / `fatcatpm` / `fatcatcruz` / `fatcatpm-portal`, and
  `pretending2care` / `pretendingtocare`. Consolidating those is an owner
  decision about which one is canonical, and it spans repositories this session
  is not scoped to. Out of scope here; worth a separate conversation.
