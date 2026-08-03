# Rocketman

A real-time strategy game. **Red Alert**'s base building, power economy and
warhead/armour counters, fought with **War Robots**' piloted mechs — regenerating
shields, named hardpoints, and one active ability per chassis that the player
fires by hand.

Open `web/rocketman.html` on any static server and play it. There is no build
step, no bundler and no runtime dependency.

```bash
npm run serve                 # http://127.0.0.1:4321
open http://127.0.0.1:4321/rocketman/web/rocketman.html

npm run test:rocketman        # 199 simulation tests, ~30s
npm run test:rocketman:e2e    # 11 browser tests, ~1m
```

---

## This directory is a side project, staged here on purpose

`rocketman/` has nothing to do with negotiatorcruz.com. It lives here because
that is the repository this session was scoped to, and it is written to move out
without changes:

| Guard | Where |
|---|---|
| Excluded from the Vercel build, so it cannot publish on the site | `.vercelignore` |
| Own CI job — a game bug never reddens the site's build | `.github/workflows/test.yml` |
| Own Playwright config and `testDir` | `rocketman/playwright.config.cjs` |
| Own `package.json` with `"type": "module"`, so the repo root stays CommonJS | `rocketman/package.json` |
| `noindex, nofollow` on the page itself | `web/rocketman.html` |

To move it to its own repository: copy this directory, keep
`test/helpers/static-server.js` or substitute any static server, and delete the
four site-side entries above. Nothing in `engine/` or `web/` imports anything
outside `rocketman/`.

---

## The design in one page

Two games are being mixed, and the seam is deliberate.

**From Red Alert** — the *macro* layer. You place structures on a grid, you mine
a finite resource, and **power is a hard economic gate**: draw more than you
generate and every factory slows down *and* every turret goes silent. A raid
that kills two Reactors has disabled the defences it is about to walk past.
Warheads have a multiplier against armour classes, so army composition is a real
decision rather than a total-cost comparison.

**From War Robots** — the *micro* layer. Combat units are piloted mechs, not
squads. Each carries a shield that soaks damage before hull, regenerates on its
own, and stays down for a punishing while once broken — so disengaging is a real
way to heal and a raid that escapes is worth more than one that trades. Each has
named hardpoints that fire independently, and one ability on a long cooldown
that the player triggers manually.

The consequence is that units are expensive and individually legible. A
Rocketman engagement is closer to twenty mechs that each matter than to two
hundred interchangeable riflemen, and that is the whole point of the mix.

### The counter triangle

| Warhead | Light | Medium | Heavy | Structure |
|---|---|---|---|---|
| Kinetic | **1.00** | 0.70 | 0.40 | 0.30 |
| Explosive | 0.55 | 0.90 | 0.85 | **1.00** |
| Energy | 0.75 | 0.85 | **1.00** | 0.55 |
| EMP | 0.10 | 0.10 | 0.10 | 0.15 |

Kinetic shreds light chassis and embarrasses itself against heavy plate.
Explosive is the siege answer. Energy is the heavy-mech answer. EMP is the worst
warhead in the game at dealing damage and buys that back by **disabling** —
weapons and movement both — which is why the Gale kills nothing and still ruins
a push. A test asserts no warhead dominates another, so none of this is dead
content.

### Factions

**Ascendancy** — fast chassis, jump jets, rockets, terrain treated as a
suggestion. Opens with the **Kestrel**: the signature Rocketman chassis, whose
jump jets carry it over walls and cliffs straight into a rocket salvo.

**Bulwark** — slower, heavier, dug in. The **Longbow** deploys to outrange every
turret in the game; undeployed it is scrap. The **Anvil** walks forward and does
not stop, and the only problem is arriving at all.

Rosters are exclusive; the Collector is the shared exception.

---

## Architecture

```
engine/            pure simulation — no DOM, no canvas, no timers, no I/O
  content.js       units, weapons, structures, factions, the damage table
  rng.js           seeded PRNG; the engine never calls Math.random
  grid.js          map generation, terrain, A* with string-pulling
  entities.js      creation, damage resolution, death, spatial index
  movement.js      path following, local avoidance, jump-jet leaps
  combat.js        targeting, salvos, projectiles, splash
  abilities.js     the six active abilities, plus shield regeneration
  economy.js       power, construction, production queues, harvesting
  vision.js        fog of war
  ai.js            the skirmish opponent
  sim.js           createWorld / tick / applyCommand — the whole public API

web/               presentation only; reads world state, writes commands
  rocketman.html   page shell and stylesheet
  render.js        canvas renderer, fog, minimap
  input.js         selection, orders, hotkeys, placement
  main.js          fixed-timestep loop and HUD
```

### The one rule everything else follows

`engine/` is deterministic. Same seed plus the same command stream produces the
same world, on any machine, forever.

That is enforced, not aspirational:

- Every random decision goes through a seeded `createRng`. A test wraps
  `Math.random` and asserts the engine never touches it during a full AI match.
- Commands are applied at the top of a tick, never the instant a player clicks.
- The simulation advances only in whole 50ms ticks (20/s); the renderer
  interpolates between them, so a dropped frame cannot change an outcome.
- A test runs two identical matches for 2400 ticks and compares a fingerprint of
  every entity's position, hull and shield.

This is what buys replays, saved matches, desync detection, lockstep
multiplayer, and a Swift port that can be diffed tick-for-tick against this one.
It is also why the whole simulation is testable under `node --test` with no
browser at all.

### The player and the AI use the same door

`updateAI()` returns the same command objects the mouse produces, and reads the
world only through its own fog of war. It cannot cheat by accident. Difficulty
changes **tempo and aggression** — think interval, army value before it pushes —
and never information or income. A test asserts the difficulty profiles contain
no key matching `/scrap|income|vision|sight|reveal|cheat/`.

---

## Controls

| | |
|---|---|
| Select / drag-select | Left mouse (double-click selects all of a type on screen) |
| Move, attack, harvest, set rally | Right mouse |
| Queue an order | Shift |
| Attack-move | `A` |
| Stop / Hold position | `S` / `H` |
| Fire ability | `F` |
| Jump to idle Collector | `E` |
| Jump to Command Rig | `B` |
| Cycle army | `Tab` |
| Control groups | `Ctrl`+`0`–`9` to set, `0`–`9` to recall |
| Build menu (Command Rig selected) | `1`–`7`, Shift to keep placing |
| Pause / speed | `Space` / `+` / `−` |

---

## Testing

199 simulation tests and 11 browser tests. The ones worth knowing about:

- **Determinism** — two runs of the same seed and commands stay identical for a
  whole match; the engine never calls `Math.random`.
- **Map fairness** — every generated map is proved 180°-rotationally symmetric
  in both terrain *and* scrap, across five seeds. A wreck field is rolled once
  and stamped twice rather than generated twice, because two independent rolls
  produce two subtly different patches and nobody can say why the map feels
  wrong.
- **Content integrity** — every hardpoint, ability, `builtAt` and faction roster
  entry resolves; no warhead dominates another; exactly one chassis is the
  signature unit and it has jump jets.
- **Fair play** — the AI never spends scrap it does not have, never builds the
  other faction's units, never skips the tech tree, and never commands a unit it
  does not own.
- **Robustness** — malformed commands are ignored rather than fatal (a command
  stream arriving over a network is untrusted input); units never end up
  standing inside terrain across a 3000-tick match.

---

## Where this goes next

Stage one is a playable skirmish with a working opponent, which is what exists.
The ordering below is deliberate — each item is cheap *because* of the
determinism guarantee above, and expensive without it.

1. **Replays.** Record `(seed, commands)` and play it back. Almost free now;
   it is the same data the sim already consumes.
2. **Save/resume.** `world` plus `rng.state()` serialises to JSON as-is.
3. **Art.** Every chassis is currently drawn from its stats — a polygon whose
   silhouette comes from its role. That was a choice: the game had to be
   legible before it was pretty. Sprites drop into `render.js` alone.
4. **Sound.** `world.events` already emits `fire`, `hit`, `explosion`, `death`,
   `built`, `ability` with positions. Nothing else needs to change.
5. **More maps.** `createMap` takes a seed and a size; multi-start and
   four-player symmetry are the natural next step.
6. **Lockstep multiplayer.** The command queue is the network protocol.
7. **The Apple port.** `engine/` is nine files of plain data and integer-ish
   math with no platform dependencies, and `content.js` serialises to JSON
   unchanged. A Swift/SpriteKit port replaces `web/` and ports `engine/`
   function-for-function, with this suite as the reference oracle — run both
   against the same seed and command stream and diff the fingerprints.

### Known rough edges

- Pathfinding is A* plus separation steering. It is good enough for twenty
  mechs and will show its seams at a hundred; flow fields are the fix.
- Vision is circular rather than line-of-sight traced. Cheap, and "my mech can
  see over that rock" has never lost anyone a game.
- There is one map generator and one map size.
- Balance has been tuned against the AI, not against a human. Expect the
  numbers in `content.js` to move.
