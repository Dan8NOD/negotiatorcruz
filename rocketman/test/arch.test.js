/**
 * The Arch.
 *
 * Two things here are easy to break and expensive to notice. The generated
 * geometry can drift from its generator, exactly as the estate's did. And the
 * ground under the span can quietly stop being walkable — the entire reason to
 * build a 240m arch rather than a wall is that an army marches under it, and
 * nothing else in the suite would catch its loss.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { ARCH, ARCH_CURVE, ARCH_HEIGHT, ARCH_SPAN, LEG_SIZE, CELL_METRES } from '../engine/arch.js';
import { buildArch, PARAMS } from '../tools/build-arch.mjs';
import { createMap } from '../engine/grid.js';
import { PROPS, TERRAIN_INFO } from '../engine/content.js';
import { STRUCTURES } from '../engine/estate.js';

describe('arch spec', () => {
  test('the generated module matches what the generator produces', () => {
    assert.deepEqual(ARCH, buildArch(PARAMS));
  });

  test('the JSON export matches the module', () => {
    const json = JSON.parse(readFileSync(new URL('../arch.json', import.meta.url), 'utf8'));
    assert.equal(json.heightCells, ARCH_HEIGHT);
    assert.equal(json.spanCells, ARCH_SPAN);
    assert.equal(json.curveCells.length, ARCH_CURVE.length);
    for (const [i, [x, h]] of ARCH_CURVE.entries()) {
      assert.deepEqual(json.curveCells[i], { x, height: h }, `curve point ${i}`);
      assert.equal(json.curveMetres[i].y, h * CELL_METRES, `metre height ${i}`);
    }
  });
});

describe('arch geometry', () => {
  test('both feet land exactly on the ground', () => {
    // Not "close to zero" — the catenary is written so that h is exactly 0 at
    // both feet. If this becomes approximate the arch is floating or buried,
    // and at this scale a rounding error is metres.
    assert.equal(ARCH_CURVE[0][1], 0);
    assert.equal(ARCH_CURVE.at(-1)[1], 0);
  });

  test('the crown is the full height, at the centre', () => {
    const crown = ARCH_CURVE[Math.floor(ARCH_CURVE.length / 2)];
    assert.equal(crown[0], 0, 'crown is not centred');
    assert.equal(crown[1], ARCH_HEIGHT, 'crown is not at full height');
  });

  test('the curve is its own mirror image', () => {
    // Load-bearing, not cosmetic. The generator mirrors the whole map 180°, so
    // a symmetric arch can be drawn at the twin position without swapping its
    // halves. An asymmetric one would need the renderer to know which copy it
    // was looking at.
    for (let i = 0; i < ARCH_CURVE.length; i++) {
      const [x, h] = ARCH_CURVE[i];
      const [mx, mh] = ARCH_CURVE[ARCH_CURVE.length - 1 - i];
      // Summed rather than negated: the centre sample is 0 and its mirror is
      // -0, and `Object.is(0, -0)` is false, so `assert.equal(x, -mx)` fails on
      // a curve that is perfectly symmetric. Same negative-zero trap the
      // generator hit; here it was the test that was wrong.
      assert.equal(x + mx, 0, `x mismatch at ${i}: ${x} vs ${mx}`);
      assert.equal(h, mh, `height mismatch at ${i}`);
    }
  });

  test('the curve rises monotonically to the crown', () => {
    // A catenary has no inflection on the way up. If one appears, the shape
    // parameter has been pushed somewhere it does not belong and the arch has
    // a dip in it.
    const mid = Math.floor(ARCH_CURVE.length / 2);
    for (let i = 1; i <= mid; i++) {
      assert.ok(
        ARCH_CURVE[i][1] >= ARCH_CURVE[i - 1][1],
        `curve dips at ${i}: ${ARCH_CURVE[i - 1][1]} -> ${ARCH_CURVE[i][1]}`
      );
    }
  });

  test('samples are close enough to draw as straight segments', () => {
    for (let i = 1; i < ARCH_CURVE.length; i++) {
      const dx = ARCH_CURVE[i][0] - ARCH_CURVE[i - 1][0];
      const dh = ARCH_CURVE[i][1] - ARCH_CURVE[i - 1][1];
      const gap = Math.sqrt(dx * dx + dh * dh);
      assert.ok(gap <= 2.2, `segment ${i} spans ${gap.toFixed(2)} cells`);
    }
  });

  test('it is the tallest thing in the game', () => {
    // The whole point. If a later landmark quietly outgrows it, the arch stops
    // being the thing you navigate by and this should be a decision, not a
    // side effect.
    const keep = STRUCTURES.find((s) => s.id === 'keep');
    assert.ok(ARCH_HEIGHT > keep.height, 'the castle keep is taller than the arch');
    for (const def of Object.values(PROPS)) {
      if (def.id === 'archleg') continue; // carries the arch's own height
      assert.ok(def.height < ARCH_HEIGHT, `${def.id} is as tall as the arch`);
    }
  });
});

describe('arch on the map', () => {
  const seeds = [1, 7, 23, 42, 99, 1234];

  for (const seed of seeds) {
    test(`seed ${seed} builds both arches, all four footings`, () => {
      // Both, because the generator mirrors everything — one arch is not an
      // option the map can express. And all four legs or none: a half-placed
      // arch is a pillar with a span drawn to nowhere.
      const map = createMap(seed);
      assert.equal(map.props.filter((p) => p.defId === 'archleg').length, 4, 'footings');
      assert.equal(map.arches.length, 2, 'arches');
    });

    test(`seed ${seed} leaves the ground under the span walkable`, () => {
      // The reason to build an arch rather than a wall. The footings block; the
      // 240m between them is air. If the span ever starts claiming cells this
      // goes red, and nothing else in the suite would notice.
      const map = createMap(seed);
      const [lw, lh] = LEG_SIZE;

      for (const a of map.arches) {
        const y = a.left.y + Math.floor(lh / 2);
        let open = 0;
        let width = 0;
        for (let x = a.left.x + lw; x < a.right.x; x++) {
          const i = y * map.width + x;
          width++;
          // The arch itself must claim nothing between its feet. Other scenery
          // may stand under it — a relay mast in the shadow of the arch is a
          // fine thing for the map to contain, and `addLandmarks` scatters
          // those without consulting anybody.
          const leg = map.props.find(
            (p) => p.defId === 'archleg' && x >= p.cx && x < p.cx + lw && y >= p.cy && y < p.cy + lh
          );
          assert.equal(leg, undefined, `a footing claims ${x},${y}, between the feet`);
          if (TERRAIN_INFO[map.terrain[i]].passable && !map.propCells[i]) open++;
        }
        // Terrain under the span is whatever the map generated — the arch does
        // not flatten it — so this asserts most of it is open rather than all,
        // which would be asserting the terrain generator's behaviour.
        assert.ok(open > width * 0.75, `only ${open}/${width} cells open under the arch`);
      }
    });
  }

  test('the two arches are 180° rotations of each other', () => {
    const map = createMap(42);
    const [a, b] = map.arches;
    const [lw, lh] = LEG_SIZE;
    // b.left should be the twin of a.right, and vice versa — the rotation
    // swaps which foot is west, which is why addArch re-orders them.
    assert.equal(b.left.x, map.width - lw - a.right.x);
    assert.equal(b.left.y, map.height - lh - a.right.y);
    assert.equal(b.right.x, map.width - lw - a.left.x);
    assert.equal(b.right.y, map.height - lh - a.left.y);
  });

  test('the span matches the spec, on the map as well as in it', () => {
    const map = createMap(42);
    for (const a of map.arches) {
      assert.equal(a.right.x - a.left.x, ARCH_SPAN, 'foot-to-foot span');
      assert.equal(a.left.y, a.right.y, 'the arch is not level');
    }
  });

  test('small maps get no arch', () => {
    // The 72-cell map the Swift port's fixtures are generated from is the one
    // that matters: a landmark appearing there rewrites map.json and CI fails
    // with "Engine behaviour changed". That is how this gate was found.
    const small = createMap(42, { width: 72, height: 72 });
    assert.equal(small.arches.length, 0);
    assert.equal(small.props.filter((p) => p.defId === 'archleg').length, 0);
  });

  test('campaign maps get no arch', () => {
    const mission = createMap(42, { landmarks: false });
    assert.equal(mission.arches.length, 0);
    assert.equal(mission.props.filter((p) => p.defId === 'archleg').length, 0);
  });
});
