# Rocketman — handoff to a new session

Paste the "Prompt" section below into a fresh chat. Everything after it is the
briefing that prompt refers to.

---

## Prompt

> I'm continuing work on **Rocketman**, a real-time strategy game in the
> `rocketman/` directory of the `Dan8NOD/negotiatorcruz` repository. Read
> `rocketman/HANDOFF.md` and `rocketman/README.md` first — between them they
> describe the game, the architecture, the invariants that must not be broken,
> and the conventions this project has been built under.
>
> Two goals, in this order:
>
> 1. **Improve the mechanics and the controls.** The game is playable and well
>    tested, but it has never been played by a human on a phone for more than a
>    few minutes. Unit handling, selection, the ability system and the touch
>    control scheme are where the next round of work belongs. Propose changes,
>    then build them.
> 2. **Ship it on the Google Play Store.** This is a change of platform: the
>    project previously targeted iOS, which is why there's a Swift port in
>    `rocketman/swift/`. That port is not on the Play path. Read the
>    "Google Play" section of the handoff before touching anything — the first
>    real blocker is that the game isn't hosted anywhere, and both wrapping
>    routes need an answer to that.
>
> Work on branch `claude/rocketman-rts-game-6dq0gj`. Don't let the game's tests
> leak into the site's `npm test` — that separation is load-bearing and is
> enforced by a test.

---

## What this is

A real-time strategy game — **Red Alert**'s base building, power economy and
warhead/armour counters, fought with **War Robots**' piloted mechs (regenerating
shields, named hardpoints, one manual ability per chassis). Seven-mission story
campaign with named pilots who level up and buy permanent upgrades between
missions, plus skirmish vs. the AI.

It is a side project staged inside a consultancy website's repository. That is
deliberate and guarded — see the table in `README.md`. It moves to its own repo
by copying the directory.

## Where things are

```
rocketman/
  engine/      pure simulation — no DOM, no Math.random, no wall clock
    numeric.js   the numeric contract (read this before any distance maths)
    sim.js       the tick loop and the command table
    content.js   every unit, weapon, ability, prop — the balance surface
    grid.js      map generation, terrain, roads, districts, props
    movement.js  pathing + `steer` (direct keyboard/stick control)
    abilities.js chassis abilities and the hero `skyfall` leap
    replay.js    replays and mid-match saves (same mechanism)
    combat.js  ai.js  economy.js  vision.js  objectives.js
    campaign.js  progression.js  profile.js
  web/         renderer, input, HUD — the only place the DOM exists
    render.js    canvas renderer, glow pass, decals, parallax elevation
    input.js     mouse, keyboard, driving, and the whole touch layer
    main.js      wiring, HUD, roster, camera
    rocketman.html   layout, CSS, safe-area handling
  test/        the simulation suite, 400+ node:test tests
  e2e/         the browser suite, ~50 Playwright tests (8 on a phone viewport)
  swift/       SwiftPM conformance port — iOS only, see caveat below
  tools/       export-fixtures.mjs, build-single-file.mjs
  dist/        rocketman.html — the whole game as one ~350 KB file
```

## Running it

```bash
npm run serve                  # http://127.0.0.1:4321
# then open /rocketman/web/rocketman.html

npm run test:rocketman         # the simulation suite
npm run test:rocketman:e2e     # the browser suite
npm run test:rocketman:swift   # 9 Swift conformance tests (needs a Swift toolchain)
npm run rocketman:fixtures     # regenerate the Swift conformance fixtures
npm run rocketman:build        # → rocketman/dist/rocketman.html, playable from file://
```

CI runs all of these in `.github/workflows/test.yml`, in jobs separate from the
site's.

## Invariants — breaking these breaks the game silently

1. **`engine/` is pure.** No DOM, no `Date.now()`, no `Math.random()`. A test
   scans the source for `Math.random` and fails on it. All randomness comes from
   the seeded `createRng` (mulberry32).

2. **The simulation is deterministic at a fixed 20 ticks/sec (50 ms).** The
   renderer interpolates between ticks; it never advances state. Same seed +
   same commands = same match, always. Replays and saves depend on this
   completely — a save is a seed plus a sparse command log, and loading it
   re-simulates.

3. **All distance maths goes through `engine/numeric.js`.** `Math.hypot` is
   marked *implementation-approximated* by ECMA-262 and disagrees with
   `sqrt(dx*dx+dy*dy)` **37.9%** of the time over 2M samples in this game's
   coordinate range — measured, not assumed. `numeric.js` also owns the baked
   `RING_COS`/`RING_SIN` tables (generated from the *accumulated* `angle += 1.1`
   sequence, not `1.1*n` — they diverge from step 6) and `jsRound`. Below a
   marked line in that file are presentation-only helpers that the simulation
   must not call.

4. **Everything that changes the world is a command.** Player input, the AI and
   (eventually) the network all produce identical command records, applied at
   the top of a tick. Adding a mechanic means adding a command case in `sim.js`,
   not calling into the world from the UI.

5. **Props are not combatants.** Destructible scenery is `player: -1`. Use
   `isCombatant(e)` wherever enemies are enumerated — plain `a.player !== b.player`
   makes every tree an enemy and broke three tests when props were introduced.

6. **The site's `npm test` must never run the game suite.** `test/config.test.js`
   asserts it. The site's 248 tests and the game's are separate on purpose so a
   game bug can never redden negotiatorcruz.com's build.

7. **Swift fixtures are checked in CI.** Change engine behaviour and the
   `Conformance fixtures are current` step fails until you regenerate and commit
   them — that's intentional, it forces the port to be a decision rather than
   silence.

8. **No constant may quietly encode the map's size.** This is the lesson of
   doubling it, and it cost four separate bugs: A*'s node ceiling (9000, "most
   of a 72-cell map"), the collector's scrap search radius (30 cells, ditto),
   the renderer's whole-map canvas bake, and a browser test that aimed at a
   fixed screen pixel. Every one of them was correct at 72 and silently wrong
   at 144, and *none* of them threw — they degraded into a unit that would not
   cross the map, an economy that stopped dead, 96 MB of canvas, and a test
   that walked to the edge and inched along it. If a number is a distance, a
   count of cells, or a fraction of the map, derive it from `map.width` /
   `map.height`.

9. **A failure whose only symptom is that the game keeps running needs its own
   test.** The mining stall broke nothing: no exception, no slow frame, no
   failing assertion — the skirmish simply never ended. `terrain.test.js` plays
   two AI matches to a conclusion for exactly this reason, and it is the most
   expensive test in the suite on purpose.

## Conventions

- Branch: `claude/rocketman-rts-game-6dq0gj`. Never push elsewhere without asking.
- If the PR for that branch is already merged, restart from `main` under the same
  branch name and open a **new** PR — never stack on merged history.
- **Draft PRs cannot be merged.** Open PRs ready-for-review, not as drafts, if the
  owner intends to merge from a phone.
- No `gh` CLI in this environment — use the GitHub MCP tools.
- Every GitHub comment ends with the Claude Code attribution footer.
- **Mutation-test new guards.** A green run proves nothing about a test that
  can't fail. Every regression test added here was verified by reverting the fix
  and watching it go red. Keep doing that.
- Prefer measuring to assuming. Most of the real bugs in this project were found
  by instrumenting or screenshotting, and several "flaky test" diagnoses turned
  out to be genuine game bugs.

## Current state

Merged: PRs #12, #16, #17. Open and green (9/9 checks): **#18** — fixes the
thumbstick being hidden whenever not driving, which permanently stranded a phone
player outside direct control after their first order.

Built so far: campaign + skirmish, unit upgrades and veterancy, replays and
saves, sound, destructible terrain (buildings, gas stations that chain-explode,
Paperboy-style neighbourhoods, landmarks), a crew system with hero chassis and a
`skyfall` half-map leap on a 15-second cooldown, a scripted mid-match reinforcement
arrival, direct keyboard/thumbstick control alongside classic RTS orders, a
C&C-style renderer with an additive glow pass and fake elevation, and a
mobile-first fullscreen layout with safe-area insets.

## Known rough edges — good starting points

- **Missions 4 and 6** were balanced before destructible cover existed, and
  now before doubled maps too. No human has played them since. Par times were
  scaled by hand against how much of a mission is spent crossing ground rather
  than building — a judgement call, not a measurement.
- **The AI does not expand.** It mines the field beside its base and then walks
  its collectors to the next nearest one, however far that is, rather than
  putting a Refinery out there. That is survivable now that the search is no
  longer capped, but on a big map it is leaving most of the economy on the
  table, and it is the single clearest thing to build next.
- **Touch controls have a pattern of bugs**: twice now a control scheme assumed a
  keyboard escape hatch that a phone doesn't have (camera lock released only by
  `C`; the stick hidden when not driving). When adding any touch control, ask:
  *if the player never touches a keyboard again, can they still get out of this
  state?*
- **Selection on touch is thin.** Desktop now has the full Age of
  Empires / StarCraft vocabulary — control groups with Ctrl-assign,
  Shift-add, recall and tap-twice-to-jump; double-click for all-of-type;
  Shift-click to add; F2 for the whole army; letters for construction. None
  of it exists on touch, where there is still only a roster row and a box
  select. That gap is now the widest one in the game.
- **Ability targeting** is a reach ring and a tap. No cancel gesture, no preview
  of what will be hit.
- **The AI** doesn't use abilities or leaps at all, doesn't react to power loss,
  and doesn't retreat damaged mechs to regenerate shields — which is the single
  biggest missed opportunity given how the shield system works.
- **No formation movement.** A group order sends everyone to the same cell and
  they shuffle.

## Where to do the work

This project moves between two places, and they are good at different things.

**A local terminal is better for anything you have to *feel*.** Balance, pacing,
whether a control reads right — none of that can be checked from a headless
container. The agent here takes screenshots and has misread one; the person at
the keyboard can just play it. Everything downstream of "publish to a store"
also lives locally: Bubblewrap wants a JDK and the Android SDK, a real device
wants a cable and `adb`, and Xcode is a Mac application.

**This remote environment is better for anything long and unattended.** It does
not need the laptop awake, it will happily run a seven-minute simulation suite
and a six-minute browser suite back to back, and it can work through a batch
overnight and leave a pull request to review from a phone in the morning.

Neither is a migration — same repository, same branch. `git pull` before
starting, push before stopping, and read this file first.

## Google Play — read before starting

The platform target changed. Previously iOS; now Google Play. That reshapes the
porting story:

**The Swift port is not on the Play path.** `rocketman/swift/` exists because the
plan was a native iOS app, and RocketmanKit is a conformance-tested Swift
translation of the engine's numerics and RNG. It's still valuable (it's the proof
the determinism contract is portable, and it's the head start if iOS comes back)
but it does nothing for Android. Don't spend Play effort there.

**The web build is the asset that matters.** `npm run rocketman:build` produces
`rocketman/dist/rocketman.html` — the entire game, ~350 KB, one file, no network
requests, runs from `file://`. Two viable wrapping routes:

| Route | What it is | Trade-off |
|---|---|---|
| **TWA via Bubblewrap** | Chrome renders your hosted PWA fullscreen inside an Android app | Smallest, most native-feeling, Google's own recommendation. **Requires an HTTPS origin** you control, serving `/.well-known/assetlinks.json` for Digital Asset Links verification. Without that the app shows a browser address bar. |
| **Capacitor** | Bundles the web assets *inside* the app, WebView-hosted | No hosting requirement, works fully offline out of the box, and gives access to native plugins (haptics, immersive mode, billing). Heavier, and rendering is WebView rather than full Chrome. |

**The first blocker is hosting.** `rocketman/` is in `.vercelignore` on purpose —
the whole point of that entry is to keep a game off a negotiation consultancy's
domain. A TWA needs an origin. So either:

- give the game its own repo and its own deployment (cleanest, and the README
  already documents that the directory moves without changes), or
- pick Capacitor and skip hosting entirely.

That decision should be made by the owner, early, because everything else
branches off it.

**Everything Play needs beyond the wrapper**, none of which exists yet:

- `manifest.webmanifest` — name, icons (192/512 + maskable), `display: standalone`,
  `orientation: landscape`, theme colours. Required for TWA, good for Capacitor.
- A service worker for offline play (TWA route only — Capacitor bundles assets).
- Android package id (e.g. `com.dan8nod.rocketman`), version code/name scheme.
- A signed **AAB** (not APK) and a Play App Signing upload key — **back that key
  up**, losing it is unrecoverable.
- Current target API level (Play enforces a rolling minimum; check what it is at
  the time of submission).
- Store listing: icon, feature graphic, screenshots at required sizes, short and
  full description.
- **Privacy policy URL** — mandatory. The game stores progress in `localStorage`
  and sends nothing anywhere; the policy should say exactly that.
- Data safety form, content rating questionnaire (IARC), and a target-audience
  declaration. Cartoon mech combat will likely land at Teen/E10+.
- Immersive mode / navigation-bar handling, and Android back-button behaviour —
  on Android, back must do something sensible (pause menu, not exit the match).
  There is no equivalent handling in the code today.

**Also worth doing before any store submission:** test on a real mid-range
Android device. Everything mobile so far has been verified on a Playwright phone
viewport, which proves layout and touch grammar but says nothing about frame rate
on actual hardware. The renderer does a full additive glow pass every frame.
