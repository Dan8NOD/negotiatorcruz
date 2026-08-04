# Rocketman

A real-time strategy game. **Red Alert**'s base building, power economy and
warhead/armour counters, fought with **War Robots**' piloted mechs — regenerating
shields, named hardpoints, and one active ability per chassis that the player
fires by hand.

Two modes: a **seven-mission story campaign** with named pilots who gain levels
and permanent upgrades bought between missions, and a **skirmish** against the
AI. Open `web/rocketman.html` on any static server and play it. There is no
build step, no bundler and no runtime dependency.

```bash
npm run serve                 # http://127.0.0.1:4321
open http://127.0.0.1:4321/rocketman/web/rocketman.html

npm run test:rocketman        # 356 simulation tests
npm run test:rocketman:e2e    # 34 browser tests
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

### Veterancy

Straight out of Command & Conquer, including the promotion rule: a machine is
promoted once it has destroyed enemy value worth a multiple of its own cost.
Scaling to cost is what lets a 300-scrap scout and a 1300-scrap siege mech
share one rule without either being trivially or impossibly promoted.

| Rank | Earned at | Damage | Rate of fire | Hull | Self-repair |
|---|---|---|---|---|---|
| Green | — | — | — | — | — |
| Veteran | 3× own cost | +10% | +25% | +25% | — |
| Elite | 9× own cost | +25% | +43% | +50% | 6 hp/s |

Promotion heals by the hull it grants, so it lands mid-fight as a reprieve.
Chevrons are drawn on the unit, because "this Kestrel is worth retreating" has
to be readable without selecting it. Turrets earn rank too.

This is also the mechanic that makes an early lead compound, which is why the
campaign's closest mission is checked by a test.

### Sell, repair, and the Orbital Lance

Three more pieces of the C&C economy:

- **Sell** returns half a structure's cost, scaled by how much of it is still
  standing — Red Alert refunds a flat half, but scaling closes the "let it get
  shot to bits, then cash it out" exploit. Your last Command Rig cannot be sold.
- **Repair** patches a structure up, paying scrap in proportion to hull
  restored. It stops at full and stops rather than going into debt.
- **The Orbital Lance** is the superweapon: 3,500 scrap, a 60-power draw, a
  four-minute charge, and a strike that ends a base. It lands where it was
  aimed a second later regardless of what moves — a superweapon you can dodge
  by walking is not one, and the telegraph is the counterplay. It needs power,
  so the counter is the same as everything else here: kill the reactors and the
  doomsday clock stops.

### Scrap regrows

Like Red Alert's ore. A partly worked cell recovers toward what it started
with; a completely stripped one only comes back if a neighbour survived to
seed it. Expanding stays the right move, and running out of map stops being
the way long games end.

---

## Story mode — *Just You and Your Rocket Crew*

The drop was supposed to put four hundred machines on the ground. It put down
eleven. What is left of the Ascendancy on this rock is you, a salvage rig, and
the pilots who walked away from their landing sites.

Seven missions, each introducing exactly one system and then making you use it
under pressure:

| # | Mission | Teaches |
|---|---|---|
| 1 | Hard Landing | Movement, attacking, jump jets — no economy at all |
| 2 | Scrap Rights | Harvesting and the Refinery, under harassment |
| 3 | Brownout | Power — kill their reactors and every turret goes quiet |
| 4 | The Anvil Line | Defence: turrets, power discipline, holding ground |
| 5 | Cold Open | The whole loop against a real base — tech, air, composition |
| 6 | Longbow Country | Siege: range you cannot answer, a base you cannot abandon |
| 7 | Just You and Your Rocket Crew | Everything, with the whole crew |

### The crew

Five named pilots join as the story introduces them. Each flies one chassis,
gains XP from what they personally destroy, levels to 5, and unlocks a
**signature perk at level 3** that applies only to the machine they are sitting
in — Ash's jump jets recharge 35% faster; Sable's EMP holds two seconds longer.

Pilots are the campaign's throughline. Losing one hurts in a way losing a
numbered Kestrel never does, which is the entire reason they have names.

### Salvage and the Hangar

Missions pay salvage for completion, for kills, for beating par time, and for
optional bonus objectives. Between missions it buys permanent upgrades across
four branches — Command (army-wide), Ordnance (one per warhead), Logistics
(the boring branch that wins campaigns), and Chassis (per-machine, and these
change how a unit plays).

Upgrades apply to replayed missions too, so an early mission can be revisited
with a much stronger crew.

### How progression stays deterministic

This is the part that had to be got right. Upgrades are **not** live effects.
A loadout is resolved **once, before the world exists**, into a private copy of
the unit/building/weapon/ability tables for that player. From the simulation's
point of view an upgraded Kestrel is simply a Kestrel with different numbers,
and every guarantee below still holds.

Two consequences are enforced by test:

- Resolving a loadout never mutates the shared content tables — otherwise one
  player's upgrades leak into the enemy's units and into every later match in
  the same page load.
- The result depends only on *which* upgrades are owned, never the order they
  were bought in. Additions run before multiplications and each pass is sorted.

### Missions are data

An objective is a small tagged record — `destroyStructures`, `survive`,
`accumulate`, `build`, `field`, `reach`, `protect`, `destroyCount` — evaluated
against world state. A new mission is written in `engine/campaign.js` and
nowhere else: no simulation changes, no per-mission scripting hooks, and every
objective type is tested once instead of once per mission.

Objectives outrank annihilation. A mission is won when its objectives say so,
and can be lost with an army still standing.

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

  objectives.js    mission objective kinds and evaluation
  campaign.js      the seven missions, as data
  progression.js   upgrades, pilots, and the stat tables they resolve into
  profile.js       what a save file is, and how it changes

web/               presentation only; reads world state, writes commands
  rocketman.html   page shell and stylesheet
  render.js        canvas renderer, fog, minimap
  input.js         selection, orders, hotkeys, placement
  campaign-ui.js   mission select, briefing, debrief, Hangar
  storage.js       the only file that knows localStorage exists
  main.js          screen flow, fixed-timestep loop, HUD
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

There are two of them, and the campaign starts in the first.

**Direct control** — you are in the cockpit. A campaign mission drops you into
your pilot's machine: the camera locks to them and the keyboard drives them.
The mech still auto-fires at whatever wanders into range, so you steer and it
shoots. *Just You and Your Rocket Crew* is a story about a person, and a person
should be someone you drive rather than a token you click at.

| | |
|---|---|
| Drive your pilot | Arrow keys or `WASD` (hold two for a diagonal) |
| Direct control on / off | `C` |
| Fire ability | `F` |

Any right-click order takes the machine back off the sticks — clicking
somewhere is an unambiguous statement that you have let go. Skirmish has no
hero, so it starts under the ordinary scheme.

**Command** — the classic RTS scheme, and what `C` returns you to.

| | |
|---|---|
| Select / drag-select | Left mouse (double-click selects all of a type on screen) |
| Move, attack, harvest, set rally | Right mouse |
| Queue an order | Shift |
| Attack-move | `A` |
| Stop / Hold position | `S` / `H` |
| Fire ability | `F` |
| Pan the camera | Arrow keys, screen edge, or the minimap |
| Jump to idle Collector | `E` |
| Jump to Command Rig | `B` |
| Cycle army | `Tab` |
| Control groups | `Ctrl`+`0`–`9` to set, `0`–`9` to recall |
| Build menu (Command Rig selected) | `1`–`7`, Shift to keep placing |
| Pause / speed | `Space` / `+` / `−` |
| Mute sound | `M` |

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
- **Faction balance** — ten skirmish seeds run to a result; the two factions
  are expected to trade wins rather than one dominating.
- **The campaign is completable** — the slowest test in the suite plays all
  seven missions end to end with the AI driving both sides and asserts each one
  is won. An objective nobody can satisfy looks perfectly healthy in every unit
  test and ends a player's campaign dead; this is the only thing that catches it.
- **Save files are untrusted** — a corrupt, hand-edited or truncated profile
  must yield a playable campaign, not a crashed page. Unknown upgrades, pilots
  and missions are dropped rather than carried, so deleting content never
  bricks a save.

---

## Where this goes next

Stage one is a playable skirmish with a working opponent, which is what exists.
The ordering below is deliberate — each item is cheap *because* of the
determinism guarantee above, and expensive without it.

1. ~~**Replays.**~~ Done — `engine/replay.js`. A recording is the match config
   plus the player's commands keyed by tick; the AI is not recorded because it
   re-derives its decisions from the rebuilt world. "Watch replay" is on the
   debrief and the skirmish result card.
2. ~~**Mid-mission save/resume.**~~ Done, and it is the *same file* as a
   replay: the match autosaves its recording every five seconds and on quit,
   and Resume rebuilds by re-simulating the log — determinism means
   re-simulation *is* loading. There is no separate snapshot format to
   version or corrupt. (The `world`-plus-`rng.state()` snapshot this list
   used to propose would have been exactly that second format.)
3. ~~**Sound.**~~ Done — `web/sound.js`, synthesised from WebAudio primitives
   with zero asset files, spatialised left/right from the camera, fed by the
   same `world.events` stream the renderer reads. `M` mutes; the choice
   persists.
4. **Art.** Every chassis is currently drawn from its stats — a polygon whose
   silhouette comes from its role. That was a choice: the game had to be
   legible before it was pretty. Sprites drop into `render.js` alone.
5. **More maps.** `createMap` takes a seed and a size; multi-start and
   four-player symmetry are the natural next step.
6. **Lockstep multiplayer.** The command queue is the network protocol.
7. **The Apple port.** Underway — `rocketman/swift/` holds RocketmanKit, the
   engine ported to Swift with a bit-for-bit conformance harness against
   fixtures exported from this engine (see `rocketman/swift/README.md`).
   Numeric groundwork is done: the simulation computes distance only through
   `engine/numeric.js`, because `Math.hypot` and friends are
   implementation-approximated and differ between JS engines, let alone
   languages. A Swift/SpriteKit front end replaces `web/`, with this suite as
   the reference oracle — run both against the same seed and command stream
   and diff the fingerprints.

### Known rough edges

- Pathfinding is A* plus separation steering. It is good enough for twenty
  mechs and will show its seams at a hundred; flow fields are the fix.
- Vision is circular rather than line-of-sight traced. Cheap, and "my mech can
  see over that rock" has never lost anyone a game.
- There is one map generator and one map size.
- Balance has been tuned against the AI, not against a human. Expect the
  numbers in `content.js` and `progression.js` to move.
- The campaign's difficulty curve is set by the AI profile per mission. It has
  not been played by a human end to end, so missions 5-7 may be too easy or too
  hard in ways only a real player will find. Mission 5 is deliberately the
  closest fight and veterancy makes early trades compound, so it is the one
  most likely to need retuning.
- Resuming a long match re-simulates it from tick zero, which is exact but not
  instant — a half-hour match takes a few seconds to rebuild. A periodic
  snapshot checkpoint would bound it, at the cost of a second save format.
