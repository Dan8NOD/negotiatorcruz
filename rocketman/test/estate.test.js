/**
 * The castle estate's layout spec.
 *
 * `engine/estate.js` is generated, and generated files rot in two directions:
 * somebody edits the output by hand and the next run silently reverts them, or
 * somebody edits the parameters and forgets to run the generator, so the game
 * and the Unity export disagree about where the road is. The first test here
 * catches both by rebuilding the geometry and comparing.
 *
 * The rest pin the design decisions that are easy to break while tuning — the
 * road has to actually meet the door, the towers have to stand on the hill,
 * and the keep's height has to stay tied to the ability it was derived from.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { CASTLE_ESTATE, HILL, STRUCTURES, ROAD_POINTS, CELL_METRES } from '../engine/estate.js';
import { buildEstate, PARAMS } from '../tools/build-estate.mjs';
import { ABILITIES } from '../engine/content.js';

/** Distance from the hill's centre. Plain sqrt, as `numeric.js` requires. */
const radius = ([x, y]) => Math.sqrt(x * x + y * y);

/** The far corner of a footprint centred on `at` — the point furthest out. */
function outerCorner({ at, size }) {
  return radius([Math.abs(at[0]) + size[0] / 2, Math.abs(at[1]) + size[1] / 2]);
}

describe('estate spec', () => {
  test('the generated module matches what the generator produces', () => {
    // The whole point of a generated artifact is that it is reproducible. If
    // this fails, either engine/estate.js was hand-edited or someone changed
    // PARAMS without running `npm run rocketman:estate`.
    assert.deepEqual(CASTLE_ESTATE, buildEstate(PARAMS));
  });

  test('the JSON export matches the module', () => {
    // Two renderers read these, and a Unity scene built against a stale export
    // is a bug nobody notices until the road misses the gate in 3D.
    const json = JSON.parse(readFileSync(new URL('../estate.json', import.meta.url), 'utf8'));
    assert.equal(json.cellMetres, CELL_METRES);
    assert.equal(json.road.pointsCells.length, ROAD_POINTS.length);
    assert.equal(json.structures.length, STRUCTURES.length);

    for (const [i, p] of ROAD_POINTS.entries()) {
      assert.deepEqual(json.road.pointsCells[i], { x: p[0], y: p[1] }, `road point ${i}`);
      assert.equal(json.road.pointsMetres[i].x, p[0] * CELL_METRES, `metres x ${i}`);
      assert.equal(json.road.pointsMetres[i].z, p[1] * CELL_METRES, `metres z ${i}`);
    }
  });
});

describe('estate geometry', () => {
  test('the road ends exactly on the gatehouse, not near it', () => {
    // The spiral is sampled backwards from the gate specifically so this is an
    // equality rather than a tolerance. If it ever becomes approximate, the
    // sampling direction was changed and the road will miss the door.
    const gate = STRUCTURES.find((s) => s.id === 'gatehouse');
    assert.deepEqual(ROAD_POINTS.at(-1), gate.at);
  });

  test('the road descends the whole way — it never loops back outward', () => {
    // A spiral whose radius stops shrinking is a circle, and a circular road
    // around a hill reads as a racetrack rather than an approach.
    for (let i = 1; i < ROAD_POINTS.length; i++) {
      const prev = radius(ROAD_POINTS[i - 1]);
      const here = radius(ROAD_POINTS[i]);
      assert.ok(here < prev + 1e-6, `road point ${i} moved outward: ${prev} -> ${here}`);
    }
  });

  test('road samples are close enough to pave as straight segments', () => {
    // The map generator reuses `paveLine` between consecutive points rather
    // than growing a curve rasteriser. That only reads as a curve while the
    // samples are short relative to a cell — a long segment shows its corners.
    for (let i = 1; i < ROAD_POINTS.length; i++) {
      const [ax, ay] = ROAD_POINTS[i - 1];
      const [bx, by] = ROAD_POINTS[i];
      const gap = radius([bx - ax, by - ay]);
      assert.ok(gap <= 1.6, `segment ${i} spans ${gap.toFixed(2)} cells`);
    }
  });

  test('the road starts beyond the hill, on open ground', () => {
    // The approach has to begin somewhere the district road network can reach.
    // Starting inside the cliff rings would strand it.
    assert.ok(
      radius(ROAD_POINTS[0]) > HILL.outer,
      'the road begins inside the hill instead of approaching it'
    );
  });

  test('everything the castle is made of stands on the plateau', () => {
    // A tower whose footprint hangs over the rim is a tower standing on a
    // cliff face. Corner towers are allowed to touch the perimeter — that is
    // where corner towers belong — but not to overhang it.
    for (const s of STRUCTURES) {
      if (s.id === 'gatehouse') continue; // sits on the perimeter by design
      assert.ok(
        outerCorner(s) <= HILL.plateau + 0.2,
        `${s.id} reaches ${outerCorner(s).toFixed(2)}, past the plateau at ${HILL.plateau}`
      );
    }
  });

  test('the gatehouse sits on the plateau perimeter', () => {
    // Derived, not written down: the gate, the plateau edge and the road's
    // last point are one number. This is the assertion that keeps them one.
    const gate = STRUCTURES.find((s) => s.id === 'gatehouse');
    assert.equal(radius(gate.at), HILL.plateau);
  });

  test('the hill rings are ordered and the cliffs are inside the hill', () => {
    assert.ok(HILL.plateau < HILL.outer, 'the plateau is wider than the hill');
    for (const [i, r] of HILL.rims.entries()) {
      assert.ok(r > HILL.plateau, `rim ${i} at ${r} is inside the plateau`);
      assert.ok(r <= HILL.outer, `rim ${i} at ${r} is outside the hill`);
      if (i > 0) assert.ok(r > HILL.rims[i - 1], `rim ${i} is not outside rim ${i - 1}`);
    }
  });
});

describe('estate scale', () => {
  test('the keep is exactly two Jump Jet leaps tall', () => {
    // The brief was "two hero robot jet jumps", and this is the line that keeps
    // the answer honest: if Jump Jets are ever rebalanced, the castle's stated
    // reason for being 13 cells tall stops being true, and this goes red rather
    // than the claim quietly becoming folklore.
    const keep = STRUCTURES.find((s) => s.id === 'keep');
    assert.equal(keep.height, ABILITIES.jumpjet.distance * 2);
  });

  test('the keep towers over everything else on the hill', () => {
    // The whole design intent is a landmark visible from across the map. If a
    // tuning pass ever makes a corner tower the tallest thing here, that intent
    // is gone and the silhouette stops reading.
    const keep = STRUCTURES.find((s) => s.id === 'keep');
    for (const s of STRUCTURES) {
      if (s.id === 'keep') continue;
      assert.ok(s.height < keep.height, `${s.id} is as tall as the keep`);
    }
  });

  test('a cell is a plausible number of metres', () => {
    // Only the 3D export reads this, so nothing in the game fails if it drifts
    // — which is exactly why it is worth pinning. It was derived from the
    // one-cell, two-storey `house` prop.
    assert.ok(CELL_METRES >= 4 && CELL_METRES <= 16, `${CELL_METRES}m per cell is off-scale`);
  });
});
