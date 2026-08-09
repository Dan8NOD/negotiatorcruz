/**
 * Export the JavaScript engine's behaviour as fixtures the Swift port must
 * reproduce exactly.
 *
 * The JS engine is the reference oracle: it is the implementation that has
 * been played, balanced and covered by 335 tests, so the port is correct when
 * it agrees with this one and not before. Rather than re-deriving expected
 * values by hand in Swift — which would only ever test my understanding of the
 * JavaScript, not the JavaScript — the port asserts against what this actually
 * produced.
 *
 * Every Double crosses as its IEEE-754 bit pattern in hex. Decimal would be
 * *nearly* safe, since both languages round decimal literals correctly, but
 * "nearly" is the entire problem this file exists to rule out: a fixture
 * format that can lose a bit cannot be used to prove nothing lost a bit.
 *
 *   node rocketman/tools/export-fixtures.mjs
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { len, ringOffset, RING_COS } from '../engine/numeric.js';
import { createRng } from '../engine/rng.js';
import { createMap } from '../engine/grid.js';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, '..', 'swift', 'Tests', 'RocketmanKitTests', 'Fixtures');

const view = new DataView(new ArrayBuffer(8));
/** A Double as 16 hex digits — the only lossless way to hand one to Swift. */
const bits = (d) => {
  view.setFloat64(0, d);
  return view.getBigUint64(0).toString(16).padStart(16, '0');
};

/* ------------------------------------------------------------- numeric -- */

function numericFixture() {
  // Sampled through the engine's own generator so the inputs are reproducible
  // and cover the coordinate range the game actually occupies, rather than
  // whatever round numbers I would have thought to type.
  const rng = createRng(0xc0ffee);
  const lengths = [];
  for (let i = 0; i < 4000; i++) {
    const dx = rng.range(-72, 72);
    const dy = rng.range(-72, 72);
    lengths.push({ dx: bits(dx), dy: bits(dy), out: bits(len(dx, dy)) });
  }

  // Math.round is where the two languages genuinely disagree by default, so
  // the edge cases are named rather than sampled: exact ties in both
  // directions, the largest double below a half (where floor(x + 0.5) rounds
  // up across the boundary and is wrong by a whole integer), and signed zero.
  const roundCases = [
    0, -0, 0.5, -0.5, 1.5, -1.5, 2.5, -2.5, 3.5, -3.5,
    0.49999999999999994, -0.49999999999999994,
    1.4999999999999998, -1.4999999999999998,
    2.4999999999999996, -2.4999999999999996,
    0.1, -0.1, 0.9, -0.9, 1.0000000000000002, -1.0000000000000002,
    4503599627370495.5, -4503599627370495.5,
    1e15 + 0.5, -(1e15 + 0.5),
  ];
  for (let i = 0; i < 500; i++) roundCases.push(rng.range(-5000, 5000));
  const rounds = roundCases.map((x) => ({ in: bits(x), out: bits(Math.round(x)) }));

  const rings = [];
  for (let n = 1; n <= RING_COS.length + 8; n++) {
    for (const radius of [3.2, 4.4, 5.6]) {
      const o = ringOffset(n, radius);
      rings.push({ n, radius: bits(radius), x: bits(o.x), y: bits(o.y) });
    }
  }

  return { lengths, rounds, rings };
}

/* ----------------------------------------------------------------- rng -- */

function rngFixture() {
  const streams = [];
  for (const seed of [0, 1, 1234, 0x9e3779b9, 0xffffffff, 42, 0xc0ffee]) {
    const rng = createRng(seed);
    const values = [];
    const states = [];
    for (let i = 0; i < 2000; i++) {
      values.push(bits(rng.next()));
      states.push(rng.state());
    }
    // The derived helpers get their own coverage: `int` and `pick` both floor a
    // product, which is where an off-by-one would hide.
    const ints = [];
    const chances = [];
    for (let i = 0; i < 200; i++) ints.push(rng.int(7 + (i % 23)));
    for (let i = 0; i < 200; i++) chances.push(rng.chance(0.35));
    streams.push({ seed, values, states, ints, chances });
  }
  return { streams };
}

/* ---------------------------------------------------------------- maps -- */

/**
 * The seeds, chosen for what they *reach* rather than for being round numbers.
 *
 * Since the generator rolls a map character once and lets every later pass read
 * it, one seed no longer samples the generator — it samples one fifth of it. So
 * between them these cover all five characters and all seven district kinds:
 *
 *   1      sprawl    downtown, suburb
 *   7      delta     — (a seed whose anchors all landed badly; worth keeping,
 *                      because "the district plan came back nearly empty" is a
 *                      path too)
 *   8      broken    quarry, industrial, suburb
 *   11     pastoral  farm, suburb
 *   1234   broken    railyard
 *   90210  delta     the busiest 72×72 in the set
 *   404    works     at the game's real 144×144, so the expansion-field loop,
 *                    the four relay masts and a forty-rectangle rail yard are
 *                    exercised at all — every one of those is dead code at 72.
 *
 * `noteRiverBreaches` is the one new pass no seed here reaches the interesting
 * half of: eight hundred swept maps produced no causeway, because the dry-anchor
 * spiral moves every field off the channel first. The pass still runs on all of
 * them — that is how it establishes there is nothing to record.
 *
 * Seven is what gets committed, not what the port was checked against. Widening
 * this list to 141 maps — seeds 1..120 at 72×72, twelve at 144×144, and six
 * non-square (96×64 and 64×96, which is the only way to exercise a channel whose
 * two axes differ) — regenerates a 6 MB fixture that the Swift suite passes
 * cell-for-cell and record-for-record. That is worth repeating after any change
 * to the generator, and not worth carrying in the repository: the seven below
 * reach every character and every district kind, and a divergence that survives
 * all seven is unlikely to be a divergence at all.
 */
const MAP_SEEDS = [
  { seed: 1, width: 72, height: 72 },
  { seed: 7, width: 72, height: 72 },
  { seed: 8, width: 72, height: 72 },
  { seed: 11, width: 72, height: 72 },
  { seed: 1234, width: 72, height: 72 },
  { seed: 90210, width: 72, height: 72 },
  { seed: 404, width: 144, height: 144 },
];

function mapFixture() {
  // Map generation is the heaviest single consumer of the RNG in the whole
  // engine, so agreeing on a generated map is a much stronger statement than
  // agreeing on a raw stream: it means every draw happened in the same order.
  const maps = [];
  for (const { seed, width, height } of MAP_SEEDS) {
    const map = createMap(seed, { width, height });
    maps.push({
      seed,
      width: map.width,
      height: map.height,
      terrain: Array.from(map.terrain),
      resource: Array.from(map.resource),
      resourceMax: Array.from(map.resourceMax),
      starts: map.starts.map((s) => ({ x: s.x, y: s.y })),
      fields: (map.fields || []).map((f) => ({ x: f.x, y: f.y })),
      // Scenery is generated from the same seeded stream as the terrain, so
      // it belongs in the conformance surface: a Swift port that furnished a
      // map differently would otherwise pass every check and still be playing
      // a different game.
      props: (map.props || []).map((p) => ({ defId: p.defId, cx: p.cx, cy: p.cy })),

      // The generator's *records*, as opposed to what it painted.
      //
      // These have to be in the fixture in their own right, because none of
      // them is derivable from the grid. A port could agree on every terrain
      // cell — the deck of a bridge is road, the ford is rough — and still
      // record no crossings at all, at which point the road network never
      // routes to a bank, the scenery placer garrisons nothing, and a renderer
      // draws tarmac over water. Terrain alone cannot tell you which run of
      // road was meant to be a bridge.
      //
      // The character is the seed's single most consequential draw: it biases
      // district count and mix, ridge and blob counts, tree and hedge density,
      // ponds and the channel's width. Two ports that disagree here are not
      // generating the same world even if this one seed happens to land on the
      // same cells.
      character: map.character,
      river: map.river
        ? {
            horizontal: map.river.horizontal,
            span: map.river.span,
            cross: map.river.cross,
            margin: map.river.margin,
            centres: Array.from(map.river.centres),
            widths: Array.from(map.river.widths),
          }
        : null,
      crossings: (map.crossings || []).map((c) => ({
        kind: c.kind,
        x: c.x,
        y: c.y,
        horizontal: c.horizontal,
        x0: c.x0,
        x1: c.x1,
        y0: c.y0,
        y1: c.y1,
      })),
      chokepoints: (map.chokepoints || []).map((c) => ({
        kind: c.kind,
        x: c.x,
        y: c.y,
        primary: c.primary,
        cache: c.cache,
      })),
      rails: (map.rails || []).map((r) => ({ x0: r.x0, y0: r.y0, x1: r.x1, y1: r.y1 })),
    });
  }
  return { maps };
}

/* ---------------------------------------------------------------- main -- */

mkdirSync(outDir, { recursive: true });

const write = (name, data) => {
  const path = join(outDir, name);
  writeFileSync(path, JSON.stringify(data));
  console.log(`${name}  ${(JSON.stringify(data).length / 1024).toFixed(0)} KB`);
};

write('numeric.json', numericFixture());
write('rng.json', rngFixture());
write('map.json', mapFixture());
