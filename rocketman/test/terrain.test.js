/**
 * The generated environment: size, districts, roads and connectivity.
 *
 * These are the properties that make a big map playable rather than merely
 * large. Most of them were learned by breaking them: a ridgeline that
 * partitions the map, a road that paves the ground your base needs, a
 * pathfinder whose node ceiling was tuned for a map a quarter the size.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  createMap,
  findPath,
  canPlace,
  isWalkable,
  terrainAt,
  DEFAULT_MAP_SIZE,
  ensureConnected,
  pathStats,
} from '../engine/grid.js';
import { TERRAIN, TERRAIN_INFO, MIN_TERRAIN_COST, PROPS } from '../engine/content.js';
import { MISSIONS } from '../engine/campaign.js';
import { createWorld } from '../engine/sim.js';

const SEEDS = [1, 7, 42, 1234, 90210];

/**
 * Can a ground unit walk from `a` to `b`? Terrain only.
 *
 * Deliberately not `findPath`: A* walks as close as it can get rather than
 * refusing an order, so a partitioned map still returns a path — just one
 * that stops at the wall. Reachability needs a flood fill to answer honestly.
 */
function reaches(map, a, b) {
  const seen = new Uint8Array(map.width * map.height);
  const queue = [a.y * map.width + a.x];
  seen[queue[0]] = 1;
  const goal = b.y * map.width + b.x;
  for (let head = 0; head < queue.length; head++) {
    if (queue[head] === goal) return true;
    const x = queue[head] % map.width;
    const y = (queue[head] / map.width) | 0;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= map.width || ny >= map.height) continue;
        const ni = ny * map.width + nx;
        if (seen[ni] || !TERRAIN_INFO[map.terrain[ni]].passable) continue;
        seen[ni] = 1;
        queue.push(ni);
      }
    }
  }
  return false;
}

describe('map size', () => {
  test('the default map is at least twice the edge it shipped with', () => {
    // The original was 72. Doubling the edge quadruples the ground, which is
    // the point: room for a flank to mean something.
    assert.ok(DEFAULT_MAP_SIZE >= 144, `default map edge is ${DEFAULT_MAP_SIZE}`);
    assert.equal(createMap(1).width, DEFAULT_MAP_SIZE);
  });

  test('every campaign mission got bigger too', () => {
    // A campaign that still plays on the old maps has not been enlarged, it
    // has had a skirmish option enlarged.
    for (const m of MISSIONS) {
      assert.ok(m.mapSize >= 112, `${m.id} still runs on a ${m.mapSize}-cell map`);
    }
  });
});

describe('the road network', () => {
  test('every map has roads, and they are the fastest ground on it', () => {
    for (const seed of SEEDS) {
      const map = createMap(seed);
      let roads = 0;
      for (let i = 0; i < map.terrain.length; i++) {
        if (map.terrain[i] === TERRAIN.ROAD) roads++;
      }
      assert.ok(roads > 200, `seed ${seed} laid only ${roads} road cells`);
    }
    const road = TERRAIN_INFO[TERRAIN.ROAD];
    assert.ok(road.passable);
    assert.ok(road.cost < TERRAIN_INFO[TERRAIN.GROUND].cost, 'road is not faster than open ground');
  });

  test('the A* heuristic stays admissible against the cheapest terrain', () => {
    // Octile distance assumes one unit of cost per step. The moment any
    // terrain costs less than that, an unscaled heuristic over-estimates the
    // remaining cost, A* stops returning shortest paths, and units quietly
    // route around the road network they were built to use.
    const cheapest = Math.min(...TERRAIN_INFO.filter((t) => t.passable).map((t) => t.cost));
    assert.equal(MIN_TERRAIN_COST, cheapest);
  });

  test('a route down a road beats the same distance over open ground', () => {
    // Built rather than generated, so the assertion is about the cost model
    // and not about where a seed happened to put its tarmac.
    const width = 40;
    const height = 12;
    const map = {
      width,
      height,
      terrain: new Uint8Array(width * height),
      resource: new Uint16Array(width * height),
      occupied: new Uint32Array(width * height),
      starts: [],
      fields: [],
    };
    // A road along row 6, open ground everywhere else.
    for (let x = 0; x < width; x++) map.terrain[6 * width + x] = TERRAIN.ROAD;

    const path = findPath(map, 2, 4, 36, 4);
    assert.ok(path && path.length > 0);
    // The cheap lane is worth a two-cell detour each way, so the route should
    // spend most of its length on it rather than walking the straight line.
    const onRoad = path.filter((p) => map.terrain[p.y * width + p.x] === TERRAIN.ROAD).length;
    assert.ok(onRoad > path.length * 0.5, `only ${onRoad}/${path.length} steps used the road`);
  });

  test('no road is laid where the opening base has to go', () => {
    // Roads are unbuildable. Discovering that the only flat ground beside
    // your Command Rig is a dual carriageway is not a difficulty setting.
    for (const seed of SEEDS) {
      const map = createMap(seed);
      for (const s of map.starts) {
        for (let y = s.y - 4; y <= s.y + 4; y++) {
          for (let x = s.x - 4; x <= s.x + 4; x++) {
            assert.notEqual(terrainAt(map, x, y), TERRAIN.ROAD, `road at ${x},${y} on seed ${seed}`);
          }
        }
      }
    }
  });
});

describe('districts', () => {
  test('a map is furnished with more than houses and trees', () => {
    // The point of the second wave of props is that a district can be built
    // out of something. One seed carrying a warehouse is luck; the whole set
    // appearing across a handful of seeds is generation.
    const kinds = new Set();
    for (const seed of SEEDS) {
      for (const p of createMap(seed).props) kinds.add(p.defId);
    }
    for (const want of ['apartment', 'warehouse', 'silo', 'depot', 'watertower', 'mast', 'pine']) {
      assert.ok(kinds.has(want), `no ${want} on any tested seed`);
    }
    assert.ok(kinds.size >= 10, `only ${kinds.size} kinds of scenery across every seed`);
  });

  test('a doubled map is furnished in proportion to its ground', () => {
    // Scenery that does not scale leaves a big map emptier than the small one
    // it replaced — the opposite of the reason to enlarge it.
    const small = createMap(7, { width: 72, height: 72 }).props.length;
    const big = createMap(7).props.length;
    assert.ok(big > small * 2, `${small} props at 72 but only ${big} at ${DEFAULT_MAP_SIZE}`);
  });

  test('every prop still has an exact mirror', () => {
    for (const seed of SEEDS) {
      const map = createMap(seed);
      const key = (defId, cx, cy) => `${defId}:${cx},${cy}`;
      const placed = new Set(map.props.map((p) => key(p.defId, p.cx, p.cy)));
      for (const p of map.props) {
        const [w, h] = PROPS[p.defId].size;
        assert.ok(
          placed.has(key(p.defId, map.width - w - p.cx, map.height - h - p.cy)),
          `seed ${seed}: ${p.defId} at ${p.cx},${p.cy} has no mirror`
        );
      }
    }
  });
});

describe('a generated map is always playable', () => {
  test('a map walled in half is repaired rather than shipped', () => {
    // The backstop, tested as one. No generated seed actually partitions —
    // six hundred were swept and every one was connected without this — so
    // asserting over seeds would pass whether or not the repair exists, which
    // is not a test. This walls a map in half on purpose instead.
    const map = createMap(7);
    const wall = Math.floor(map.width / 2);
    for (let y = 0; y < map.height; y++) {
      for (let x = wall; x < wall + 3; x++) map.terrain[y * map.width + x] = TERRAIN.CLIFF;
    }
    const [a, b] = map.starts;
    assert.equal(reaches(map, a, b), false, 'the wall did not actually partition the map');

    ensureConnected(map);
    assert.ok(reaches(map, a, b), 'a partitioned map was left unplayable');
  });

  test('the two starts can always reach each other', () => {
    for (const seed of [...SEEDS, 5, 11, 77, 512, 9001, 31337]) {
      const map = createMap(seed);
      const [a, b] = map.starts;
      const path = findPath(map, a.x, a.y, b.x, b.y);
      assert.ok(path && path.length > 0, `seed ${seed} has no route between the starts`);
      const last = path[path.length - 1];
      assert.ok(
        Math.abs(last.x - b.x) <= 1 && Math.abs(last.y - b.y) <= 1,
        `seed ${seed} only got to ${last.x},${last.y} of ${b.x},${b.y}`
      );
    }
  });

  test('a corner-to-corner order is not silently truncated', () => {
    // The node ceiling used to be a fixed 9000, which was most of a 72-cell
    // map and under half of this one. Past it A* gives up and returns its
    // best effort, which to a player looks like a unit refusing to cross the
    // map.
    const map = createMap(7);
    const path = findPath(map, 3, 3, map.width - 4, map.height - 4);
    assert.ok(path, 'no route across the map at all');
    const last = path[path.length - 1];
    assert.ok(
      Math.abs(last.x - (map.width - 4)) <= 1 && Math.abs(last.y - (map.height - 4)) <= 1,
      `path stopped at ${last.x},${last.y}`
    );
  });

  test('the opening Command Rig always fits where the game puts you', () => {
    // The home wreck field is centred five cells from the start with a radius
    // of four, so whether its ragged edge reached the rig footprint was down
    // to the seed. It had simply never landed there on a seed anyone ran.
    for (const seed of [...SEEDS, 3, 88, 404, 2024, 65535]) {
      const map = createMap(seed);
      for (const s of map.starts) {
        assert.ok(
          canPlace(map, [3, 3], s.x - 1, s.y - 1),
          `seed ${seed}: the Command Rig does not fit at ${s.x},${s.y}`
        );
      }
    }
  });

  test('an order onto a blocked cell still produces a route', () => {
    // With four hundred props on the map most stray clicks land on something
    // solid, and A* can only discover "unreachable" by exhausting the search.
    // Snapping the goal is what keeps that from being a whole-map expansion
    // for a ten-cell order.
    //
    // Through a world rather than a bare map: `map.props` is placement data,
    // and a prop only claims its cells once the sim has minted it an entity.
    const world = createWorld({
      seed: 7,
      players: [{ faction: 'ascendancy' }, { faction: 'bulwark' }],
    });
    const { map } = world;
    // From a machine's own cell, not from `map.starts` — the start cell has
    // the Command Rig standing on it, and pathing out of the middle of a
    // building is a different question from the one this test is asking.
    const mech = [...world.entities.values()].find((e) => e.kind === 'unit' && e.player === 0);
    assert.ok(mech, 'the opening force has no units');
    const from = { x: Math.floor(mech.x), y: Math.floor(mech.y) };

    let checked = 0;
    for (const p of map.props) {
      if (isWalkable(map, p.cx, p.cy)) continue;
      const path = findPath(map, from.x, from.y, p.cx, p.cy);
      assert.ok(path && path.length > 0, `no route toward the ${p.defId} at ${p.cx},${p.cy}`);
      const last = path[path.length - 1];
      assert.ok(isWalkable(map, last.x, last.y), 'a path ended somewhere nothing can stand');
      if (++checked >= 25) break;
    }
    assert.ok(checked > 0, 'no blocked prop cells were exercised');
  });

  test('an order onto a blocked cell nearby does not search the whole map', () => {
    // The result alone cannot show this. Without snapping, A* reaches a
    // blocked goal only by exhausting every reachable cell and then returning
    // its best effort — a path that looks perfectly reasonable, bought with a
    // whole-map expansion for an order a few cells long. Measuring the search
    // is the only way to keep that from creeping back.
    const world = createWorld({
      seed: 7,
      players: [{ faction: 'ascendancy' }, { faction: 'bulwark' }],
    });
    const { map } = world;
    const mech = [...world.entities.values()].find((e) => e.kind === 'unit' && e.player === 0);
    const from = { x: Math.floor(mech.x), y: Math.floor(mech.y) };

    // The nearest blocked prop cell to the machine — the ordinary "clicked on
    // a tree twenty cells away" order.
    let nearest = null;
    let nearestD = Infinity;
    for (const p of map.props) {
      if (isWalkable(map, p.cx, p.cy)) continue;
      const d = Math.abs(p.cx - from.x) + Math.abs(p.cy - from.y);
      if (d < nearestD) {
        nearestD = d;
        nearest = p;
      }
    }
    assert.ok(nearest, 'no blocked scenery on the map at all');

    findPath(map, from.x, from.y, nearest.cx, nearest.cy);
    const { expanded } = pathStats();
    const cells = map.width * map.height;
    assert.ok(
      expanded < cells * 0.2,
      `expanded ${expanded} of ${cells} cells for an order ${nearestD} cells away`
    );
  });
});
