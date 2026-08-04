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

function mapFixture() {
  // Map generation is the heaviest single consumer of the RNG in the whole
  // engine, so agreeing on a generated map is a much stronger statement than
  // agreeing on a raw stream: it means every draw happened in the same order.
  const maps = [];
  for (const seed of [1, 7, 1234, 90210]) {
    const map = createMap(seed, { width: 72, height: 72 });
    maps.push({
      seed,
      width: map.width,
      height: map.height,
      terrain: Array.from(map.terrain),
      resource: Array.from(map.resource),
      resourceMax: Array.from(map.resourceMax),
      starts: map.starts.map((s) => ({ x: s.x, y: s.y })),
      fields: (map.fields || []).map((f) => ({ x: f.x, y: f.y })),
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
