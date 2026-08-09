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
import { createMap } from '../engine/grid.js';
import { ABILITIES, PROPS, TERRAIN, TERRAIN_INFO } from '../engine/content.js';

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

describe('estate on the map', () => {
  // Every failure this suite has caught was seed-dependent, and every one of
  // them failed *silently*: `propFits` declines rather than throwing, so a
  // buried footprint means the castle is simply absent from that map. A sweep
  // is the only shape of test that finds those.
  const seeds = [1, 7, 8, 23, 26, 42, 58, 99, 1234];

  /** Flood the passable terrain from a start, so we can ask what it reaches. */
  function reachableFrom(map, start) {
    const { width, height, terrain } = map;
    const seen = new Uint8Array(width * height);
    const queue = [start.y * width + start.x];
    seen[queue[0]] = 1;

    for (let head = 0; head < queue.length; head++) {
      const i = queue[head];
      const x = i % width;
      const y = (i - x) / width;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
        const j = ny * width + nx;
        if (seen[j] || !TERRAIN_INFO[terrain[j]].passable) continue;
        seen[j] = 1;
        queue.push(j);
      }
    }
    return seen;
  }

  for (const seed of seeds) {
    test(`seed ${seed} builds the whole castle, twice`, () => {
      // Twice because the generator mirrors everything. One castle would mean
      // one player has a landmark on their flank and the other does not, which
      // is the exact unfairness this file exists to prevent.
      const map = createMap(seed);
      const count = (id) => map.props.filter((p) => p.defId === id).length;
      assert.equal(count('keep'), 2, 'keeps');
      assert.equal(count('castletower'), 8, 'corner towers');
      assert.equal(count('gatehouse'), 2, 'gatehouses');
    });

    test(`seed ${seed} leaves the castle reachable on foot`, () => {
      // The cliff rims mean the road is the only way up. If the road ever fails
      // to cut them — or the switchbacks get paved over — the castle becomes
      // decoration that nothing can walk to, and no other test would notice.
      const map = createMap(seed);
      const keep = map.props.find((p) => p.defId === 'keep');
      const seen = reachableFrom(map, map.starts[0]);

      let touching = false;
      for (let y = keep.cy - 1; y <= keep.cy + PROPS.keep.size[1]; y++) {
        for (let x = keep.cx - 1; x <= keep.cx + PROPS.keep.size[0]; x++) {
          if (x < 0 || y < 0 || x >= map.width || y >= map.height) continue;
          if (seen[y * map.width + x]) touching = true;
        }
      }
      assert.ok(touching, 'nothing walkable adjoins the keep');
    });

    test(`seed ${seed} buries no scrap under the hill`, () => {
      // A field under the hill is scrap nobody can collect. It is also what
      // used to refuse the castle its footprint — the fields are mirrored too,
      // so a roll far from the estate could drop its twin on the plateau.
      const map = createMap(seed);
      const keep = map.props.find((p) => p.defId === 'keep');
      const cx = keep.cx + Math.floor(PROPS.keep.size[0] / 2);
      const cy = keep.cy + Math.floor(PROPS.keep.size[1] / 2);

      for (let y = cy - HILL.outer; y <= cy + HILL.outer; y++) {
        for (let x = cx - HILL.outer; x <= cx + HILL.outer; x++) {
          if (x < 0 || y < 0 || x >= map.width || y >= map.height) continue;
          if (radius([x - cx, y - cy]) > HILL.plateau) continue;
          assert.equal(map.resource[y * map.width + x], 0, `scrap under the castle at ${x},${y}`);
        }
      }
    });
  }

  test('the cliff rims actually ring the hill', () => {
    // The rims are the whole reason the switchbacks matter. If a tuning pass
    // ever thins them to nothing, the hill becomes climbable from any angle and
    // the road quietly stops being a decision.
    const map = createMap(42);
    const keep = map.props.find((p) => p.defId === 'keep');
    const cx = keep.cx + Math.floor(PROPS.keep.size[0] / 2);
    const cy = keep.cy + Math.floor(PROPS.keep.size[1] / 2);

    let cliff = 0;
    for (let y = cy - HILL.outer - 1; y <= cy + HILL.outer + 1; y++) {
      for (let x = cx - HILL.outer - 1; x <= cx + HILL.outer + 1; x++) {
        if (x < 0 || y < 0 || x >= map.width || y >= map.height) continue;
        if (map.terrain[y * map.width + x] === TERRAIN.CLIFF) cliff++;
      }
    }
    assert.ok(cliff > 40, `only ${cliff} cliff cells around the hill`);
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
