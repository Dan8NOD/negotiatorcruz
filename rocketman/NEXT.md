# Next — paste this into Claude Code in your terminal

Three jobs are queued, and all three want a terminal rather than a web session:
two need you to actually play the game, and one needs a human watching the Play
Store implications. Paste the prompt, then pick a job.

---

## Prompt

> I'm working on **Rocke**, the real-time strategy game in the `rocketman/`
> directory of this repository. Read `rocketman/README.md`, `rocketman/HANDOFF.md`
> and `rocketman/ESTATE.md` first — between them they describe the game, the
> architecture, the invariants that must not be broken, and the castle estate
> that was just added.
>
> There is a project skill at `.claude/skills/rocketman-structure/` covering how
> to add or re-art a structure. Use it before opening `render.js` or
> `content.js` — it exists so you don't have to re-derive the conventions.
>
> Read `rocketman/NEXT.md` and tell me which of the three jobs in it you'd start
> with, and why. Don't start until I pick.
>
> Run `npm run test:rocketman` before you claim anything works. It takes about
> seven minutes, so use `node --test rocketman/test/<file>.test.js` while
> iterating and save the full suite for the end.

---

## Job 1 — Rename the project to Rocke

The game is called **Rocke**. The directory and every reference still say
`rocketman`. This is mechanical but wide, and one piece of it is genuinely
dangerous.

**Do not change the Android `applicationId`.** It is
`com.negotiatorcruz.rocketman` in `rocketman/android/app/build.gradle:85`. To
Google Play that string *is* the app's identity — changing it doesn't rename the
app, it creates a different one, orphaning the listing and every install. The
Java package under `app/src/main/java/com/negotiatorcruz/rocketman/` is tied to
it. Leave both alone unless you have decided, deliberately, to ship a new
listing.

Everything else is fair game:

| What | Where |
|---|---|
| The directory itself | `rocketman/` → `rocke/` |
| Seven npm scripts | `package.json` |
| CI job paths | `.github/workflows/test.yml` |
| The site's own config test | `test/config.test.js` |
| Vercel exclusion | `.vercelignore` |
| Playwright config + `testDir` | `rocketman/playwright.config.cjs` |
| Prose and headings | `README.md`, `HANDOFF.md`, `ESTATE.md`, `TESTING.md` |
| The project skill | `.claude/skills/rocketman-structure/` — its name and its paths |

Two things to verify afterwards, because they are the load-bearing separations
the repo is built on and a rename is exactly how they break:

- `npm test` (the site's suite) must still contain **no** game tests. There is a
  test enforcing this.
- The game must still be excluded from the Vercel build.

Do it as one commit, on its own branch. Mixing a rename with anything else makes
the diff unreviewable.

---

## Job 2 — Play the castle and tune it

This is the one that genuinely cannot be done from a web session: nobody has
played this yet.

```bash
npm run serve
# then open http://127.0.0.1:4321/rocketman/web/rocketman.html and start a skirmish
```

The estate is **skirmish only** — campaign missions are tuned against fixed
seeds and a hill ringed by cliffs re-tunes all seven, which is how `cold_open`
went from winnable to lost the first time it was tried. It sits on a free corner
and is mirrored to the opposite one.

What to judge, in rough order of how likely it is to be wrong:

1. **Is the hill worth taking?** The cliffs mean the switchback road is the only
   way up. That should make the castle a strongpoint worth fighting over. If it
   is just an obstacle everyone walks around, the estate is scenery and the
   parameters need to move.
2. **Does the climb feel good, or just slow?** Roads cost 0.72 against rough
   ground's 1.7, so the switchback should be meaningfully faster than nothing —
   but it is also a long way round.
3. **Does the keep read as tall?** It is 13 cells, about 3.8x the nine-storey
   Tower Block, which is deliberately without precedent in this game.
4. **Does the Hangar now read as the biggest thing in your base?** It went 3×3 →
   4×4 and gained real art this round. Check it is still *placeable* in a
   built-up base without feeling like a puzzle.

Everything about the estate's shape is parameters in one place:
`rocketman/tools/build-estate.mjs`. Edit `PARAMS`, run `npm run rocketman:estate`,
reload. Do not edit `engine/estate.js` or `estate.json` — both are generated, and
a test compares them against the generator.

---

## Job 3 — Import Hillcrest into Unity

`rocketman/estate.json` is the portable artifact: every length in cells *and* in
metres, already converted to Unity's x/z ground plane with y up. Read the
"Importing into Unity" section of `ESTATE.md` — it covers the axis swap, the
road spline, what to source from an asset library, and what actually costs frames
on M-series iPads and A18 (overdraw and draw calls, not polygons).

Nothing in this repository ships art, and nothing in it can render 3D. The spec
is placement and scale only, which is what makes it compose with whatever
library you already own.

---

## Where things stand

- `main` ← PR #24, branch `claude/rocky-game-dev-setup-f9u419`
- `npm run test:rocketman` — 597 passing
- The estate places completely and its plateau is reachable on 300 consecutive
  seeds; both are asserted in `rocketman/test/estate.test.js`
