# RocketmanKit — the Swift port

The simulation, ported from `rocketman/engine`, on the way to an iOS build.

```bash
swift test --package-path rocketman/swift    # or: npm run test:rocketman:swift
```

## Status

| Layer | JavaScript | Swift | Conformance |
|---|---|---|---|
| Portable arithmetic | `engine/numeric.js` | `Numeric.swift` | 4,000 lengths, 524 roundings, 312 ring offsets |
| Seeded PRNG | `engine/rng.js` | `RNG.swift` | 14,000 draws across 7 seeds, bit-for-bit |
| Terrain, map generation, A* | `engine/grid.js` | `Grid.swift` | 4 fully generated 72×72 maps, bit/cell-for-cell (terrain, resource, props, fields) |
| Content, entities, combat, economy, AI, campaign | 11 files | — | — |

Seventeen tests, all green on Linux. Map generation is checked bit/cell-exact
against the JS oracle; A* has no JS-captured fixture yet, so its coverage is
property tests instead — no path through a sealed room, `goalRadius` accepting
a near miss, straight-line string-pulling.

## Why the JavaScript is the oracle

The JS engine is the one that has been played, balanced, and covered by 335
tests. So the port is correct when it *agrees with that engine*, and not when
it looks reasonable.

Writing expected values by hand in Swift would only ever test my reading of the
JavaScript. Instead `tools/export-fixtures.mjs` runs the real engine and records
what it actually produced; the Swift suite asserts against that. Every `Double`
crosses as its IEEE-754 bit pattern in hex — decimal would be *nearly* safe,
and "nearly" is the exact thing this is here to rule out.

CI regenerates the fixtures and fails on a diff, so changing engine behaviour
becomes a decision about the port rather than silence.

## The part that made this possible

The engine's determinism was resting on `Math.hypot`, which ECMA-262 defines as
**implementation-approximated** — a conforming engine may return anything within
an implementation-defined tolerance. Over two million samples from this game's
coordinate range, `Math.hypot(dx, dy)` and `sqrt(dx*dx + dy*dy)` disagree
**37.9% of the time** by one unit in the last place.

One ulp is harmless until it lands on a boundary, and here distances gate
arrival, target acquisition and splash falloff. A single flipped comparison
sends two machines down different branches, permanently.

That was never only a porting problem. Safari's JavaScriptCore is a different
implementation from V8, so the web build was already exposed — and iOS means
Safari. `engine/numeric.js` is now the only place the simulation computes
distance, `Numeric.swift` mirrors it, and a test scans `engine/` and fails on
any approximated `Math` call outside that file.

Two smaller traps came out of the same audit:

- **`Math.round` is not `rounded()`.** JavaScript breaks ties toward +∞, Swift
  breaks them away from zero, so they disagree on every negative half:
  `Math.round(-2.5)` is `-2`, `(-2.5).rounded()` is `-3`. `jsRound` reproduces
  the tie-break. It also avoids `floor(x + 0.5)`, which is wrong by a whole
  integer for the largest double below a half.
- **The spawn ring called `cos`/`sin`.** Now a baked table of decimal literals —
  decimal-to-double conversion *is* correctly rounded in both languages. The
  values are the ones V8 produced, so spawn positions did not move.

`facing` and `leapHeight` still use real trig. They are written by the engine
and read only by the renderer, never by the simulation and never by the world
fingerprint, so they cannot desync a match. They live below a marked line in
`numeric.js` and a test keeps them there.

## What's next

1. ~~**`Grid.swift`** — terrain, map generation, A*.~~ Done: four fixture
   seeds generate cell-identical maps (terrain, resource, fields, props). A*
   itself still has no JS fixture — `hasLineOfWalk` and `smoothPath` ported
   too, covered by property tests rather than conformance.
2. **Content and entities**, then combat, economy, abilities, AI, campaign.
3. **World fingerprint conformance** — the real prize. Run both engines for
   2,400 ticks on the same seed and command stream and compare entity by
   entity, which is what `hashWorld` in the JS suite already does.
4. **The iOS app**, outside this package: Metal or SpriteKit renderer plus a
   touch control scheme. An RTS designed for drag-select and right-click needs
   genuinely different input, not a mouse emulator — that is design work, not
   porting, and it wants a device in hand.

`RocketmanKit` has no UIKit, SpriteKit or Metal dependency on purpose. That is
what lets the conformance suite run in CI on Linux on every push, rather than
only when someone opens Xcode.
