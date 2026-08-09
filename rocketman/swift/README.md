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
| Terrain, map generation, A* | `engine/grid.js` | `Grid.swift` | 7 fully generated maps, bit/cell-for-cell (terrain, resource, props, fields) *and* record-for-record (character, river, crossings, chokepoints, rails) |
| Content, entities, combat, economy, AI, campaign | 11 files | — | — |

Twenty-two tests, all green on Linux. Map generation is checked bit/cell-exact
against the JS oracle; A* has no JS-captured fixture yet, so its coverage is
property tests instead — no path through a sealed room, `goalRadius` accepting
a near miss, straight-line string-pulling.

Map generation covers what the engine generates *now*: a map character rolled
once from the seed, ridgelines with passes cut through them and widened into
chokepoints, a river with a ford and two mirrored pairs of bridges, seven kinds
of district, the road network that routes through the crossings and the passes
rather than bulldozing its own, and the connectivity backstop. Road is terrain 4
at cost 0.72, which is also why the A* heuristic is scaled by `minTerrainCost` —
octile distance assumes a step costs at least one, and a cheaper step makes the
estimate inadmissible, at which point A* quietly stops returning shortest paths.

Not ported, and absent from the fixture for the same reason: the chambers
generator for the underground biomes, and `placeLandmark`. Nothing in the Swift
package reaches either, and an unverified port of a pass that consumes rng is
worse than an absent one — it would look finished and desynchronise every draw
after it. `carveTerrain` still takes `hasLandmark` so the one decision it gates,
whether the map gets a river at all, reads the same as the JavaScript's.

The `main` merges that moved the generator out from under this package are worth
recording as the thing it exists to catch. Twice now `Grid.swift` has been
ported against a generator that then moved — once for the map rework, once for
the river — and both times CI regenerated the fixture and turned nine hundred
assertions red rather than letting a port of a game that no longer exists sit
there looking finished.

## What the fixture has to contain, and why it grew

The second of those catches is the more instructive one, because the first
version of the fixture would have missed half of it.

The river pass paints a bridge deck as road and a ford as rough, and it also
*records* where they are — `map.crossings`, `map.chokepoints`, `map.rails`, the
channel itself, and the character that decided how wide it all is. None of those
records is recoverable from the grid. A port could paint every cell correctly,
record nothing, and pass a fixture that only compared terrain: the map would
then route no road to a riverbank, garrison no bridgehead, and draw tarmac over
water, and the conformance suite would have called it identical.

So the fixture now carries the records as first-class data, and the seven seeds
are chosen for what they *reach* rather than for being round numbers — between
them all five map characters and all seven district kinds, plus one map at the
game's real 144×144, where the expansion fields and the relay masts exist at all.
That last one matters more than it looks: at 72×72 `extraFields` is zero, so a
whole loop of the generator is dead code on every other seed in the set.

One pass is exercised but not *reached*: `noteRiverBreaches` runs on all seven
maps, and on eight hundred swept seeds it never found a breach to record, because
the dry-anchor spiral moves every field off the channel first. Its recording
branch is therefore unproven by conformance, and that is written here rather than
papered over with a seed that does not exist.

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

1. ~~**`Grid.swift`** — terrain, map generation, A*.~~ Done: seven fixture
   seeds generate cell-identical maps (terrain, resource, fields, props) that
   also agree record for record on the character, the channel, the crossings,
   the chokepoints and the rails. A* itself still has no JS fixture —
   `hasLineOfWalk` and `smoothPath` ported too, covered by property tests
   rather than conformance. The chambers biome and `placeLandmark` are the two
   generation paths still unported.
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
