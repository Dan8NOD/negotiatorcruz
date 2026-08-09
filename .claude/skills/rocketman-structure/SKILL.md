---
name: rocketman-structure
description: Add, edit, or re-art a structure (building) in the Rocketman RTS game under rocketman/ — Hangar, Foundry, Reactor, Turret, superweapons, defences, production buildings, anything that occupies cells and gets built by the Command Rig. Use this whenever the request touches Rocketman buildings at all: adding a new one, drawing or improving the artwork for an existing one, changing cost/HP/power/footprint/tech gating, wiring a build-bar button or hotkey, or asking why a structure looks generic or doesn't appear in the menu. The whole point is speed — the wiring is almost entirely data-driven and the art has a fixed contract, so consult this before opening render.js (2700 lines) or content.js (1300 lines) and reverse-engineering the conventions again.
---

# Adding a structure to Rocketman

Most of a structure is **one object in one file**. Almost everything a new
building needs — the build-bar button, placement preview, construction
animation, footprint collision, power accounting, damage smoke, brownout
flicker, repair outline, sell refund, minimap blip, death explosion, AI
awareness of tech gating — is derived from that object at runtime. Nothing
needs registering in a second place.

That is why this should be fast. The three things below are the *entire*
hand-written surface. Everything else is already generic.

| Step | File | Required? |
|---|---|---|
| 1. The definition | `rocketman/engine/content.js` → `BUILDINGS` | Yes |
| 2. Build bar + hotkey | same file → `BUILD_ORDER`, `BUILD_HOTKEYS` | Only if the player builds it |
| 3. The art | `rocketman/web/render.js` → `drawBuildingDetail` | Only for bespoke art |

If you skip step 3 the structure still draws — it falls to the `default:`
case and gets a generic inset panel with blinking service lights. That is a
legitimate ship-it state for a minor building, and a poor one for anything
the player looks at often.

## Step 1 — the definition

Add a key to `BUILDINGS` in `rocketman/engine/content.js`. The full field
set, with the ones the tests actually enforce marked:

```js
hangar: {
  id: 'hangar',            // required, must equal the key
  name: 'Hangar',
  cost: 1600,
  buildTime: secs(28),     // use secs(), never raw ticks
  hp: 1150,                // required, > 0
  armor: ARMOR.STRUCTURE,
  size: [3, 3],            // required, [w, h] in cells, both > 0
  power: -30,              // required even when 0. Negative draws, positive makes
  sight: 5,
  builds: 'units',         // opens a production queue + rally point
  rally: true,
  requires: ['techlab'],   // every id must exist in BUILDINGS
  hint: 'Produces tier-two chassis, including air.',
},
```

Optional fields that switch on whole behaviours, all handled generically:

- `dropOff: true` — harvesters can deliver scrap here
- `freeUnit: 'collector'` — ships with one unit on completion
- `unlocksTier: 2` — gates tier-2 content
- `hardpoints: ['turretgun']` — it shoots; every id must exist in `WEAPONS`
- `needsPower: true` — goes dark and stops working in a brownout
- `superweapon: {...}` — charge bar on the structure and a targeting mode
- `deathExplosion` — leaves a crater when killed

**Balance is set here and nowhere else.** `content.js` is described in the
handoff as "the balance surface" — resist the urge to special-case a
building's numbers in `economy.js` or `combat.js`.

The invariants in `rocketman/test/content.test.js` (the `structures` describe
block) run automatically over every entry in `BUILDINGS`, so a malformed
definition fails the suite without you writing a test. What they check:
`id` matches the key, `hp > 0`, `size` is a 2-length array of positives,
`power` is a declared number, and every `requires`/`hardpoints` id resolves.

## Step 2 — build bar and hotkey

Both are plain data, and both `web/main.js` and `web/input.js` build their
UI by iterating them. Adding the two entries is the whole of the UI work:

```js
export const BUILD_ORDER = [..., 'hangar', ...];   // left-to-right button order
export const BUILD_HOTKEYS = { ..., hangar: 'n' }; // letters, never digits
```

Hotkeys are **letters on purpose**. Digits belong to control groups, and a
digit that placed a Reactor on minute one would silently stop doing so once
the player bound a group to it — one key, two meanings, decided by something
they did ten minutes earlier. Pick the first unclaimed letter of the name
the way Age of Empires does: ha-**N**-gar, t-**U**-rret, sensor **M**ast.

Two things that are *not* required, because they are derived:

- **Tech gating** — `techAllows()` in `engine/economy.js` reads `requires`
  and `unlocksTier` directly. Buttons grey out on their own.
- **The AI** — `engine/ai.js` calls `techAllows` too. You only touch
  `BUILD_PRIORITY` or the `counted(...)` ladder around line 261 if you want
  the AI to actively *want* the new building. Leaving it alone means the AI
  simply never builds it, which is a fine default for a niche structure.

Add it to a mission's `buildings` array in `engine/campaign.js` only if a
scripted base should start with one.

## Step 3 — the art

This is the part that eats the time, and it is smaller than it looks: one
`case` in one `switch`, typically 20–50 lines of canvas. Read
`references/art.md` before writing any of it. It covers the coordinate
contract, the palette, the animation clock, the glow pass, and the specific
gotchas that cost the most time (detail drawn onto the extruded face instead
of the roof, `addParticle` taking cell coordinates while everything around
it is pixels, and `Math.random()` being legal here but not in `engine/`).

The short version: add `case 'yourid':` to `drawBuildingDetail` in
`rocketman/web/render.js` (~line 1344), draw within the roof plate using the
`cx`/`cy` the function already computed, use the existing greys, spend the
faction `color` on exactly one accent, and wrap anything hot in `glow()`.

## Verify

```bash
npm run test:rocketman        # ~7 min; the content invariants run over your entry
npm run serve                 # then open /rocketman/web/rocketman.html
```

The simulation suite is slow enough that it is worth running the content
tests alone while iterating:

```bash
node --test rocketman/test/content.test.js
```

Art has no test coverage and cannot get any useful automated coverage — it
is a canvas. Look at it. Build one in a skirmish, watch it under
construction, at low HP, and during a brownout, since those states draw over
your detail rather than replacing it.

## What not to touch

- `rocketman/swift/` — the port is Grid/Numeric/RNG only. No building data
  lives there, so a new structure needs no Swift work.
- `web/sound.js` — structure sounds are per-`kind`, not per-building. A new
  building inherits the collapse voice automatically.
- The `hangar` in `web/main.js` and `web/campaign-ui.js` is the **pilot
  upgrade screen**, an unrelated thing that happens to share the word. Do
  not wire building code into it.
- Root `npm test` must stay free of game tests. That separation is
  load-bearing and enforced by a test.
