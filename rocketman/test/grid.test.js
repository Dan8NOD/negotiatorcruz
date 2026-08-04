/**
 * Map generation and pathfinding.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  createMap,
  findPath,
  smoothPath,
  canPlace,
  occupy,
  isWalkable,
  nearestWalkable,
  hasLineOfWalk,
  terrainAt,
} from '../engine/grid.js';
import { TERRAIN } from '../engine/content.js';

/** A blank arena with no terrain features, for pathfinding assertions. */
function blankMap(width = 20, height = 20) {
  const map = {
    width,
    height,
    terrain: new Uint8Array(width * height),
    resource: new Uint16Array(width * height),
    occupied: new Uint32Array(width * height),
    starts: [],
    fields: [],
  };
  for (let x = 0; x < width; x++) {
    map.terrain[x] = TERRAIN.CLIFF;
    map.terrain[(height - 1) * width + x] = TERRAIN.CLIFF;
  }
  for (let y = 0; y < height; y++) {
    map.terrain[y * width] = TERRAIN.CLIFF;
    map.terrain[y * width + width - 1] = TERRAIN.CLIFF;
  }
  return map;
}

function wall(map, x, y0, y1) {
  for (let y = y0; y <= y1; y++) map.terrain[y * map.width + x] = TERRAIN.CLIFF;
}

describe('map generation', () => {
  const seeds = [1, 7, 42, 99, 1234];

  for (const seed of seeds) {
    test(`seed ${seed} is 180° rotationally symmetric`, () => {
      const map = createMap(seed);
      for (let y = 0; y < map.height; y++) {
        for (let x = 0; x < map.width; x++) {
          const a = y * map.width + x;
          const b = (map.height - 1 - y) * map.width + (map.width - 1 - x);
          assert.equal(map.terrain[a], map.terrain[b], `terrain differs at ${x},${y}`);
          assert.equal(map.resource[a], map.resource[b], `scrap differs at ${x},${y}`);
        }
      }
    });
  }

  test('is reproducible from its seed', () => {
    const a = createMap(4242);
    const b = createMap(4242);
    assert.deepEqual([...a.terrain], [...b.terrain]);
    assert.deepEqual([...a.resource], [...b.resource]);
  });

  test('different seeds produce different maps', () => {
    const a = createMap(1);
    const b = createMap(2);
    assert.notDeepEqual([...a.terrain], [...b.terrain]);
  });

  test('start positions are buildable and clear of scrap', () => {
    const map = createMap(7);
    assert.equal(map.starts.length, 2);
    for (const s of map.starts) {
      assert.ok(canPlace(map, [3, 3], s.x - 1, s.y - 1), 'the Command Rig must fit at spawn');
    }
  });

  test('every start has scrap within reach', () => {
    const map = createMap(7);
    for (const s of map.starts) {
      const near = map.fields.some((f) => Math.hypot(f.x - s.x, f.y - s.y) < 12);
      assert.ok(near, 'a start with no nearby field is an unplayable start');
    }
  });

  test('the border is sealed', () => {
    const map = createMap(11);
    for (let x = 0; x < map.width; x++) {
      assert.equal(terrainAt(map, x, 0), TERRAIN.CLIFF);
      assert.equal(terrainAt(map, x, map.height - 1), TERRAIN.CLIFF);
    }
  });

  test('scrap never sits on impassable terrain', () => {
    for (const seed of seeds) {
      const map = createMap(seed);
      for (let i = 0; i < map.resource.length; i++) {
        if (map.resource[i] === 0) continue;
        const x = i % map.width;
        const y = (i / map.width) | 0;
        assert.ok(isWalkable(map, x, y), `unreachable scrap at ${x},${y} on seed ${seed}`);
      }
    }
  });
});

describe('pathfinding', () => {
  test('walks a straight line across open ground', () => {
    const map = blankMap();
    const path = findPath(map, 2, 10, 15, 10);
    assert.ok(path, 'expected a route');
    const last = path[path.length - 1];
    assert.deepEqual({ x: last.x, y: last.y }, { x: 15, y: 10 });
  });

  test('routes around a wall rather than through it', () => {
    const map = blankMap();
    wall(map, 8, 1, 14); // leaves a gap at y = 15..18

    const path = findPath(map, 3, 8, 15, 8);
    assert.ok(path, 'expected a route around the wall');
    for (const step of path) {
      assert.notEqual(
        terrainAt(map, step.x, step.y),
        TERRAIN.CLIFF,
        `path crosses the wall at ${step.x},${step.y}`
      );
    }
    const last = path[path.length - 1];
    assert.deepEqual({ x: last.x, y: last.y }, { x: 15, y: 8 });
  });

  test('returns an empty path when already at the goal', () => {
    const map = blankMap();
    assert.deepEqual(findPath(map, 5, 5, 5, 5), []);
  });

  test('gets as close as it can to a sealed-off goal instead of refusing', () => {
    const map = blankMap();
    wall(map, 8, 1, 18); // a complete partition

    const path = findPath(map, 3, 8, 15, 8);
    // A refused order reads to the player as the game ignoring the click, so
    // the contract is "walk toward it", not "return null".
    assert.ok(path && path.length > 0, 'expected a best-effort path');
    const last = path[path.length - 1];
    assert.ok(last.x < 8, 'best-effort path must stay on the reachable side');
  });

  test('will not squeeze diagonally between two blocked corners', () => {
    const map = blankMap();
    map.terrain[10 * map.width + 11] = TERRAIN.CLIFF;
    map.terrain[11 * map.width + 10] = TERRAIN.CLIFF;

    const path = findPath(map, 10, 10, 11, 11);
    assert.ok(path);
    // The only legal route is the long way round, so it cannot be one step.
    assert.ok(path.length > 1, 'cut the corner through a solid diagonal');
  });

  test('treats structures as solid', () => {
    const map = blankMap();
    occupy(map, [3, 3], 9, 8, 42);
    const path = findPath(map, 3, 9, 15, 9);
    assert.ok(path);
    for (const step of path) {
      assert.equal(map.occupied[step.y * map.width + step.x], 0, 'path runs through a building');
    }
  });

  test('goalRadius lets a unit path toward something it cannot stand on', () => {
    const map = blankMap();
    occupy(map, [3, 3], 9, 8, 42);

    // The centre of the structure is unreachable, which is exactly the case a
    // harvester heading to a refinery hits every trip.
    assert.equal(findPath(map, 3, 9, 10, 9, { goalRadius: 0 }).length > 0, true);
    const path = findPath(map, 3, 9, 10, 9, { goalRadius: 2.5 });
    assert.ok(path.length > 0);
    const last = path[path.length - 1];
    assert.ok(Math.hypot(last.x - 10, last.y - 9) <= 2.5);
    assert.equal(map.occupied[last.y * map.width + last.x], 0, 'stopped inside the building');
  });
});

describe('path smoothing', () => {
  test('collapses a straight run to a single waypoint', () => {
    const map = blankMap();
    const path = findPath(map, 2, 10, 15, 10);
    const smoothed = smoothPath(map, 2, 10, path);
    assert.ok(smoothed.length < path.length, 'expected the staircase to collapse');
    assert.deepEqual(smoothed[smoothed.length - 1], path[path.length - 1]);
  });

  test('keeps every smoothed leg walkable', () => {
    const map = blankMap();
    wall(map, 8, 1, 14);
    const path = findPath(map, 3, 8, 15, 8);
    const smoothed = smoothPath(map, 3, 8, path);

    let x = 3;
    let y = 8;
    for (const step of smoothed) {
      assert.ok(hasLineOfWalk(map, x, y, step.x, step.y), 'smoothing cut through terrain');
      x = step.x;
      y = step.y;
    }
  });

  test('handles trivial paths without throwing', () => {
    const map = blankMap();
    assert.deepEqual(smoothPath(map, 1, 1, []), []);
    assert.deepEqual(smoothPath(map, 1, 1, null), []);
  });
});

describe('placement', () => {
  test('rejects footprints that overlap terrain, scrap or other buildings', () => {
    const map = blankMap();
    assert.ok(canPlace(map, [2, 2], 5, 5));

    map.terrain[5 * map.width + 6] = TERRAIN.CLIFF;
    assert.ok(!canPlace(map, [2, 2], 5, 5), 'placed across a cliff');

    map.terrain[5 * map.width + 6] = TERRAIN.GROUND;
    map.resource[5 * map.width + 6] = 100;
    assert.ok(!canPlace(map, [2, 2], 5, 5), 'placed on top of a wreck field');

    map.resource[5 * map.width + 6] = 0;
    occupy(map, [1, 1], 6, 5, 9);
    assert.ok(!canPlace(map, [2, 2], 5, 5), 'placed on top of another structure');
  });

  test('rejects footprints that run off the map', () => {
    const map = blankMap();
    assert.ok(!canPlace(map, [3, 3], map.width - 2, 5));
  });
});

describe('nearestWalkable', () => {
  test('returns the cell itself when it is already clear', () => {
    const map = blankMap();
    assert.deepEqual(nearestWalkable(map, 5, 5), { x: 5, y: 5 });
  });

  test('spirals out of a solid cell', () => {
    const map = blankMap();
    occupy(map, [3, 3], 5, 5, 1);
    const spot = nearestWalkable(map, 6, 6);
    assert.ok(spot);
    assert.ok(isWalkable(map, spot.x, spot.y));
  });

  test('gives up rather than searching forever', () => {
    const map = blankMap(9, 9);
    for (let i = 0; i < map.terrain.length; i++) map.terrain[i] = TERRAIN.CLIFF;
    assert.equal(nearestWalkable(map, 4, 4, 4), null);
  });
});
