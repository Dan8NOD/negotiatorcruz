/**
 * The watercourse, the crossings over it, and the passes through the ridges.
 *
 * These are the assertions that make a river a *feature* rather than a blue
 * smear. A river that does not reach both edges is a lake; a river with a hole
 * in it is decoration; a river with no way over it is an unwinnable match. All
 * three failed at some point while this was being built, and two of them
 * failed silently — the map generated, the tests passed, and the only symptom
 * was that the map played like it had no river in it.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  createMap,
  findPath,
  isWalkable,
  bankOf,
  characterMix,
  DISTRICT_KINDS,
  MAP_CHARACTER_IDS,
} from '../engine/grid.js';
import { TERRAIN, TERRAIN_INFO, PROPS } from '../engine/content.js';
import { MISSIONS } from '../engine/campaign.js';

/** Deliberately not `findPath`: A* walks as close as it can get. See terrain.test.js. */
function reaches(map, a, b, blocked) {
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
        if (seen[ni]) continue;
        if (blocked && blocked(nx, ny)) continue;
        if (!TERRAIN_INFO[map.terrain[ni]].passable) continue;
        seen[ni] = 1;
        queue.push(ni);
      }
    }
  }
  return false;
}

const onAnyCrossing = (map) => (x, y) =>
  map.crossings.some((c) => x >= c.x0 - 1 && x <= c.x1 + 1 && y >= c.y0 - 1 && y <= c.y1 + 1);

/**
 * The route between two points with some cells forbidden.
 *
 * A* has no "avoid" argument, so the cells are walled off on a copy of the
 * terrain and the search runs against that. A copy rather than a mutate-and-
 * restore: `findPath` shares module-level scratch keyed on map size, and a map
 * left half-edited by a throwing assertion would poison every later test in
 * the file.
 */
function pathAvoiding(map, from, to, blocked) {
  const clone = { ...map, terrain: Uint8Array.from(map.terrain) };
  for (let y = 0; y < map.height; y++) {
    for (let x = 0; x < map.width; x++) {
      if (blocked(x, y)) clone.terrain[y * map.width + x] = TERRAIN.CLIFF;
    }
  }
  return findPath(clone, from.x, from.y, to.x, to.y);
}

const SEEDS = [1, 7, 42, 55, 1234, 9001, 31337, 90210];
const SWEEP = Array.from({ length: 90 }, (_, i) => i + 1);

describe('the river', () => {
  test('every ordinary map has one, and it runs across the middle', () => {
    for (const seed of SEEDS) {
      const map = createMap(seed);
      assert.ok(map.river, `seed ${seed} generated no watercourse`);
      const { horizontal, span, margin } = map.river;
      const wetAt = (s) => {
        for (let t = 0; t < (horizontal ? map.height : map.width); t++) {
          const x = horizontal ? s : t;
          const y = horizontal ? t : s;
          if (map.terrain[y * map.width + x] === TERRAIN.WATER) return true;
        }
        return false;
      };
      // Continuously wet from one end of its reach to the other, except where
      // a crossing is laid over it. A channel with an unrecorded dry step in
      // it is a free crossing nothing on the map knows about — which is the
      // failure `noteRiverBreaches` exists to catch, so if this ever trips
      // that pass has stopped working.
      const onDeck = onAnyCrossing(map);
      for (let s = margin + 1; s < span - margin - 1; s++) {
        const deck = horizontal
          ? onDeck(s, map.river.centres[s])
          : onDeck(map.river.centres[s], s);
        assert.ok(wetAt(s) || deck, `seed ${seed}: the channel is dry at ${s} of ${span}`);
      }
      // And marsh rather than water at both ends, in equal measure. The flank
      // is the map's other route and it belongs to both players or to neither.
      // Checked against the channel's own band rather than the whole column,
      // because a pond can be anywhere and one sitting at the map's edge is
      // not the river reaching it.
      const channelWet = (s) => {
        const c = map.river.centres[margin];
        for (let t = c - 3; t < c + map.river.widths[margin] + 3; t++) {
          const x = horizontal ? s : t;
          const y = horizontal ? t : s;
          if (x < 0 || y < 0 || x >= map.width || y >= map.height) continue;
          if (map.terrain[y * map.width + x] === TERRAIN.WATER) return true;
        }
        return false;
      };
      assert.ok(!channelWet(1), `seed ${seed}: the channel reaches the near edge`);
      assert.ok(!channelWet(span - 2), `seed ${seed}: the channel reaches the far edge`);
      assert.ok(margin > 4, `seed ${seed}: a reach of ${margin} is not a flank`);
      assert.ok(margin < span * 0.28, `seed ${seed}: a reach of ${margin} is not a river`);
      // Clear of the landing zones, which is what stops `clearArea` levelling
      // a causeway through the channel at somebody's front door.
      for (const s of map.starts) {
        const along = horizontal ? s.x : s.y;
        assert.ok(
          Math.min(along, span - 1 - along) + 7 < margin,
          `seed ${seed}: the channel reaches the landing zone at ${s.x},${s.y}`
        );
      }
    }
  });

  test('it lies across the line between the two bases', () => {
    // Not `bankOf` on the two starts. The channel deliberately stops short of
    // both landing zones — see `carveRiver` — so out there it has no banks to
    // be on either side of. What matters is that the water is *in the way*:
    // walk the straight line from one base to the other and it goes through
    // the channel, which is why the crossings are where the armies meet.
    for (const seed of SWEEP) {
      const map = createMap(seed);
      const [a, b] = map.starts;
      const steps = Math.max(Math.abs(b.x - a.x), Math.abs(b.y - a.y));
      let crossed = 0;
      for (let s = 0; s <= steps; s++) {
        const x = Math.round(a.x + ((b.x - a.x) * s) / steps);
        const y = Math.round(a.y + ((b.y - a.y) * s) / steps);
        if (bankOf(map, x, y) === 0 && map.river.widths[map.river.horizontal ? x : y] > 0) {
          crossed++;
        }
      }
      // Two is the floor rather than a fudge: the bases are on the diagonal
      // and the channel is three cells wide, so a line crossing it at 45°
      // clips as few as two of them.
      assert.ok(
        crossed >= 2,
        `seed ${seed}: the line between the bases only meets ${crossed} cells of channel`
      );
    }
  });

  test('the channel itself is a wall — crossing it anywhere else is a hike', () => {
    // The local property, and the one that says "river" rather than "pond".
    // Stand on each bank a little along from the ford and walk to the other
    // side: with the crossings shut, the way round costs several times as
    // much. Measured at the ford because it sits at the middle of the channel,
    // furthest from the open ends — if any part of the water is a barrier,
    // that part is.
    for (const seed of SEEDS) {
      const map = createMap(seed);
      const ford = map.crossings.find((c) => c.kind === 'ford');
      assert.ok(ford, `seed ${seed} has no ford`);
      // Well clear of the deck along the river, so blocking it does not wall
      // in the test's own starting cell — and measured at the *middle* of the
      // channel, which is the part of it furthest from the open ends and so
      // the part that has to be a barrier if any of it is.
      const off = 9;
      const onDeck = onAnyCrossing(map);
      const stand = (side) => {
        for (let d = 1; d < 26; d++) {
          const x = ford.horizontal ? ford.x + off : ford.x + d * side;
          const y = ford.horizontal ? ford.y + d * side : ford.y + off;
          if (x < 1 || y < 1 || x >= map.width - 1 || y >= map.height - 1) return null;
          // Clear of every crossing, or the walling-off below walls in the
          // test's own feet and A* has nowhere to start from.
          if (onDeck(x, y)) continue;
          if (bankOf(map, x, y) === side && isWalkable(map, x, y)) return { x, y };
        }
        return null;
      };
      const a = stand(-1);
      const b = stand(1);
      if (!a || !b) continue;

      const cost = (path) =>
        path.reduce((n, p) => n + TERRAIN_INFO[map.terrain[p.y * map.width + p.x]].cost, 0);
      const over = findPath(map, a.x, a.y, b.x, b.y);
      const round = pathAvoiding(map, a, b, onAnyCrossing(map));
      assert.ok(over && round, `seed ${seed}: no route across the channel at all`);
      assert.ok(
        cost(round) > cost(over) * 3,
        `seed ${seed}: shutting the crossings only cost ${cost(round).toFixed(0)} against ${cost(over).toFixed(0)} — the channel is not a barrier`
      );
    }
  });

  test('it lies between the two bases, and the crossings are the short way over', () => {
    // What the river has to *do*, stated as the thing a player experiences: a
    // route from one base to the other that cannot use a crossing is a much
    // longer route. Not "impossible" — the map deliberately leaves a flank at
    // each end of the channel, because a hard partition is more than this
    // game can carry (see `carveRiver`). Long enough that the crossings are
    // where the fight is, is the whole requirement.
    //
    // It is also what catches every silent way the channel gets filled in: a
    // wreck field flattening it, a quarry rim painted over it, a landmark's
    // cleared ring. Any of those and the detour collapses to nothing.
    //
    // Averaged rather than asserted per seed, and that is honest rather than
    // lax. How much the flank costs on any one map is mostly that map's own
    // geometry — both bases sit at 16% of the edge on the same diagonal, so on
    // an unlucky roll the end of the channel is not far from one of them and
    // the two routes come out level. The barrier itself is pinned by the test
    // above, which measures it where it actually is: at the water. This one
    // asks whether the river is shaping the map as a whole, and a tenth or two
    // is the same order as the road network's own bonus — which this map has
    // always treated as a decision worth making.
    const penalty = [];
    for (const seed of SWEEP) {
      const map = createMap(seed);
      const [a, b] = map.starts;
      assert.ok(reaches(map, a, b), `seed ${seed} is not connected at all`);
      assert.ok(
        reaches(map, a, b, onAnyCrossing(map)),
        `seed ${seed}: blocking the crossings stranded a player entirely`
      );

      // Measured in movement cost rather than in cells, because that is what
      // a player pays. The way round the end of the channel is through marsh
      // at 1.7 a cell, and the cells alone hide most of the price.
      const direct = findPath(map, a.x, a.y, b.x, b.y);
      const round = pathAvoiding(map, a, b, onAnyCrossing(map));
      assert.ok(direct && round, `seed ${seed}: no route between the starts`);
      const cost = (path) =>
        path.reduce((n, p) => n + TERRAIN_INFO[map.terrain[p.y * map.width + p.x]].cost, 0);
      penalty.push(cost(round) / cost(direct));
    }

    const mean = penalty.reduce((n, p) => n + p, 0) / penalty.length;
    assert.ok(
      mean > 1.12,
      `taking the flank instead of a crossing costs ${((mean - 1) * 100).toFixed(0)}% on average — the river is not shaping the map`
    );
  });

  test('a small number of crossings, and one of them is the ford', () => {
    for (const seed of SWEEP) {
      const map = createMap(seed);
      const kinds = map.crossings.map((c) => c.kind);
      assert.ok(kinds.length >= 3, `seed ${seed} has only ${kinds.length} crossings`);
      assert.ok(kinds.length <= 8, `seed ${seed} has ${kinds.length} crossings — that is a bridge`);
      assert.equal(
        kinds.filter((k) => k === 'ford').length,
        1,
        `seed ${seed} has ${kinds.filter((k) => k === 'ford').length} fords`
      );
      assert.ok(kinds.includes('bridge'), `seed ${seed} has no bridge`);
    }
  });

  test('the ford is slow ground and the bridges are fast ground', () => {
    // The one design decision the whole feature rests on. If the ford were
    // paved it would be a second bridge eight cells wide, and the map would
    // have lost its safe crossing — which is exactly what happened before
    // `paveLine` learned to refuse it, because the road network happily ran a
    // dual carriageway straight through the shallows.
    for (const seed of SWEEP) {
      const map = createMap(seed);
      for (const c of map.crossings) {
        let road = 0;
        let rough = 0;
        for (let y = c.y0; y <= c.y1; y++) {
          for (let x = c.x0; x <= c.x1; x++) {
            const t = map.terrain[y * map.width + x];
            if (t === TERRAIN.ROAD) road++;
            if (t === TERRAIN.ROUGH) rough++;
          }
        }
        if (c.kind === 'ford') {
          assert.equal(road, 0, `seed ${seed}: the ford has ${road} cells of tarmac on it`);
          assert.ok(rough > 0, `seed ${seed}: the ford is not rough ground`);
        }
        if (c.kind === 'bridge') {
          assert.ok(road > 0, `seed ${seed}: a bridge deck has no road on it`);
        }
      }
      assert.ok(
        TERRAIN_INFO[TERRAIN.ROUGH].cost > TERRAIN_INFO[TERRAIN.ROAD].cost,
        'the ford has to be slower than the bridge or there is no decision'
      );
    }
  });

  test('every crossing is crossable, on foot, from bank to bank', () => {
    // Endpoints are *found* rather than guessed at a fixed offset. A channel
    // that meanders means "six cells past the deck" is back in the water at
    // one along-position and up a cliff at another, which tests the ground
    // beside the crossing rather than the crossing.
    const standingOn = (map, c, side) => {
      for (let d = 1; d < 20; d++) {
        const x = c.horizontal ? c.x : c.x + d * side;
        const y = c.horizontal ? c.y + d * side : c.y;
        if (x < 1 || y < 1 || x >= map.width - 1 || y >= map.height - 1) return null;
        if (bankOf(map, x, y) === side && isWalkable(map, x, y)) return { x, y };
      }
      return null;
    };

    for (const seed of SEEDS) {
      const map = createMap(seed);
      for (const c of map.crossings) {
        const from = standingOn(map, c, -1);
        const to = standingOn(map, c, 1);
        assert.ok(from && to, `seed ${seed}: the ${c.kind} at ${c.x},${c.y} has no dry bank`);
        const path = findPath(map, from.x, from.y, to.x, to.y);
        assert.ok(path && path.length > 0, `seed ${seed}: no route over the ${c.kind}`);
        const last = path[path.length - 1];
        assert.ok(
          Math.abs(last.x - to.x) <= 1 && Math.abs(last.y - to.y) <= 1,
          `seed ${seed}: the ${c.kind} at ${c.x},${c.y} does not reach the far bank`
        );
        // And it is a *crossing*, not a walk round: a route that leaves the
        // neighbourhood of this crossing has proved something about the map
        // rather than about the bridge.
        for (const step of path) {
          const off = c.horizontal
            ? Math.abs(step.x - c.x)
            : Math.abs(step.y - c.y);
          assert.ok(off < 14, `seed ${seed}: the route over the ${c.kind} went round instead`);
        }
      }
    }
  });

  test('the crossings are mirror images of each other', () => {
    // Same discipline as the props and the wreck fields. A bridge four cells
    // closer to one player is unfair in a way nobody can articulate while they
    // are losing to it.
    for (const seed of SWEEP) {
      const map = createMap(seed);
      const key = (c) => `${c.kind}:${c.x0},${c.y0},${c.x1},${c.y1}`;
      const placed = new Set(map.crossings.map(key));
      for (const c of map.crossings) {
        const twin = {
          kind: c.kind,
          x0: map.width - 1 - c.x1,
          y0: map.height - 1 - c.y1,
          x1: map.width - 1 - c.x0,
          y1: map.height - 1 - c.y0,
        };
        assert.ok(
          placed.has(key(twin)),
          `seed ${seed}: the ${c.kind} at ${c.x},${c.y} has no mirror`
        );
      }
    }
  });

  test('nobody is cut off from the scrap beside their own base', () => {
    // The river must never be between a player and their home field: an
    // opening that begins with a bridge crossing is an opening nobody can
    // survive, and no amount of counterplay fixes it.
    for (const seed of SWEEP) {
      const map = createMap(seed);
      for (const s of map.starts) {
        const home = map.fields
          .map((f) => ({ f, d: Math.abs(f.x - s.x) + Math.abs(f.y - s.y) }))
          .sort((a, b) => a.d - b.d)[0];
        assert.ok(home && home.d < 24, `seed ${seed}: no field near ${s.x},${s.y}`);
        assert.equal(
          reaches(map, s, home.f, onAnyCrossing(map)),
          true,
          `seed ${seed}: the river runs between ${s.x},${s.y} and its own wreck field`
        );
      }
    }
  });

  test('no wreck field ever drains the channel', () => {
    // `stampField` flattens impassable terrain so scrap is never stranded on a
    // cliff, and it does not care what it is flattening. A field whose ragged
    // edge reached the river opened a two-cell notch through it — invisible on
    // screen, fatal to the partition, and it happened on roughly one seed in
    // nine before the channel became a hard no.
    for (const seed of SWEEP) {
      const map = createMap(seed);
      const { horizontal, span, centres, widths } = map.river;
      const onDeck = onAnyCrossing(map);
      for (let s = 1; s < span - 1; s++) {
        for (let t = centres[s]; t < centres[s] + widths[s]; t++) {
          const x = horizontal ? s : t;
          const y = horizontal ? t : s;
          // A crossing is dry by design, and scrap on the ford is a fine thing
          // for a map to have — the richest patch on it is at the one place
          // both sides have to come to. This is about the *water*.
          if (onDeck(x, y)) continue;
          assert.equal(
            map.resource[y * map.width + x],
            0,
            `seed ${seed}: scrap in the channel at ${x},${y}`
          );
        }
      }
    }
  });

  test('a challenge map gets its landmark instead of a river', () => {
    // Deliberate, and worth pinning so it cannot be lost by accident.
    // `placeLandmark` clears a nineteen-cell ring so there is a way to the
    // door, by fiat, after the terrain is written — which on the seeds where
    // the two collide punches a hole through the channel wider than any
    // crossing on the map. One centrepiece per map.
    for (const seed of SEEDS) {
      const map = createMap(seed, { landmarks: ['castle'] });
      assert.equal(map.river, null, `seed ${seed} put a river on a landmark map`);
      assert.ok(map.landmarks.castle, `seed ${seed} lost its castle`);
    }
  });
});

describe('chokepoints', () => {
  test('every map has passes, and they carry the road', () => {
    let withPass = 0;
    for (const seed of SWEEP) {
      const map = createMap(seed);
      const major = map.chokepoints.filter((c) => c.kind === 'pass');
      if (major.length === 0) continue;
      withPass++;
      for (const c of major) {
        let road = 0;
        for (let y = c.y - 5; y <= c.y + 5; y++) {
          for (let x = c.x - 5; x <= c.x + 5; x++) {
            if (x < 0 || y < 0 || x >= map.width || y >= map.height) continue;
            if (map.terrain[y * map.width + x] === TERRAIN.ROAD) road++;
          }
        }
        // Not every pass is on the network — a map where the road visits all
        // of them has paved the whole ridge — but the widened ones exist to be
        // walked through, so the gap itself has to be open.
        let walkable = 0;
        for (let y = c.y - 2; y <= c.y + 2; y++) {
          for (let x = c.x - 2; x <= c.x + 2; x++) {
            if (x < 0 || y < 0 || x >= map.width || y >= map.height) continue;
            if (TERRAIN_INFO[map.terrain[y * map.width + x]].passable) walkable++;
          }
        }
        assert.ok(walkable >= 18, `seed ${seed}: the pass at ${c.x},${c.y} is not open`);
      }
    }
    assert.ok(withPass > SWEEP.length * 0.6, `only ${withPass} of ${SWEEP.length} seeds cut a pass`);
  });

  test('the road network runs through the chokepoints, not round them', () => {
    // The point of §3. `paveLine` bulldozes cliff, which kept the map
    // connected and made the ridgelines meaningless — every road cut its own
    // gap wherever it happened to meet rock, so a ridge had as many holes in
    // it as there were roads crossing it and none of them was *the* pass.
    //
    // Not every pass: a network that visits all of them has paved the ridge.
    // Every bridge, though — a crossing the fast ground does not reach is a
    // crossing nobody walks over.
    let passesWithRoad = 0;
    let passes = 0;
    let bridges = 0;
    let bridgesOnNetwork = 0;

    const roadNear = (map, x0, y0, x1, y1) => {
      let n = 0;
      for (let y = y0; y <= y1; y++) {
        for (let x = x0; x <= x1; x++) {
          if (x < 0 || y < 0 || x >= map.width || y >= map.height) continue;
          if (map.terrain[y * map.width + x] === TERRAIN.ROAD) n++;
        }
      }
      return n;
    };

    for (const seed of SWEEP) {
      const map = createMap(seed);
      for (const c of map.chokepoints) {
        if (c.kind !== 'pass') continue;
        passes++;
        if (roadNear(map, c.x - 4, c.y - 4, c.x + 4, c.y + 4) >= 4) passesWithRoad++;
      }
      for (const c of map.crossings) {
        if (c.kind !== 'bridge') continue;
        bridges++;
        if (roadNear(map, c.x0 - 4, c.y0 - 4, c.x1 + 4, c.y1 + 4) >= 30) bridgesOnNetwork++;
      }
    }

    assert.ok(passes > 100, `only ${passes} passes across ${SWEEP.length} seeds`);
    assert.ok(
      passesWithRoad > passes * 0.6,
      `only ${passesWithRoad} of ${passes} passes carry a road`
    );
    assert.equal(bridgesOnNetwork, bridges, `${bridges - bridgesOnNetwork} bridges reach no road`);
  });

  test('chokepoints are mirrored, and garrisoned', () => {
    let garrisoned = 0;
    for (const seed of SWEEP) {
      const map = createMap(seed);
      const placed = new Set(map.chokepoints.map((c) => `${c.kind}:${c.x},${c.y}`));
      for (const c of map.chokepoints) {
        const twin = `${c.kind}:${map.width - 1 - c.x},${map.height - 1 - c.y}`;
        assert.ok(placed.has(twin), `seed ${seed}: the ${c.kind} at ${c.x},${c.y} has no mirror`);
      }
      if (map.props.some((p) => p.defId === 'bunker')) garrisoned++;
    }
    assert.ok(
      garrisoned > SWEEP.length * 0.6,
      `only ${garrisoned} of ${SWEEP.length} seeds put anything at a chokepoint`
    );
  });

  test('no chokepoint is inside somebody’s base', () => {
    for (const seed of SWEEP) {
      const map = createMap(seed);
      for (const c of map.chokepoints) {
        for (const s of map.starts) {
          const d = Math.max(Math.abs(c.x - s.x), Math.abs(c.y - s.y));
          assert.ok(d >= 20, `seed ${seed}: a ${c.kind} ${d} cells from a landing zone`);
        }
      }
    }
  });
});

describe('two seeds are two places', () => {
  test('every character turns up, and biases the map it rolls on', () => {
    const seen = new Map();
    for (const seed of SWEEP) {
      const map = createMap(seed);
      assert.ok(MAP_CHARACTER_IDS.includes(map.character), `unknown character ${map.character}`);
      const list = seen.get(map.character) || [];
      list.push(map);
      seen.set(map.character, list);
    }
    for (const id of MAP_CHARACTER_IDS) {
      assert.ok(seen.has(id), `no seed in ${SWEEP.length} rolled ${id}`);
    }

    // The bias has to be visible in the output or the roll is decoration.
    // Farmland against a conurbation is the widest pair, and hedgerow is the
    // clearest single measure of it.
    const hedges = (maps) =>
      maps.reduce((n, m) => n + m.props.filter((p) => p.defId === 'hedge').length, 0) / maps.length;
    assert.ok(
      hedges(seen.get('pastoral')) > hedges(seen.get('sprawl')) * 2,
      `farmland grew ${Math.round(hedges(seen.get('pastoral')))} hedgerows against the city's ${Math.round(hedges(seen.get('sprawl')))}`
    );
  });

  test('between them the characters can roll every district kind', () => {
    // A district kind no character weights is a district kind nobody will
    // ever see, and it will rot without anything failing.
    const reachable = new Set();
    for (const id of MAP_CHARACTER_IDS) {
      for (const [kind, weight] of characterMix(id)) {
        assert.ok(weight > 0, `${id} weights ${kind} at ${weight}`);
        reachable.add(kind);
      }
    }
    for (const kind of DISTRICT_KINDS) {
      assert.ok(reachable.has(kind), `no map character ever builds a ${kind}`);
    }
  });

  test('the character is part of the seed, not of the machine', () => {
    for (const seed of SEEDS) {
      assert.equal(createMap(seed).character, createMap(seed).character);
    }
    // And it is not the same one every time, which is the failure mode a
    // one-line roll invites: a table that is never indexed past zero.
    assert.ok(new Set(SWEEP.map((s) => createMap(s).character)).size >= 4);
  });

  test('two maps on two seeds are furnished differently', () => {
    const profile = (map) => {
      const counts = new Map();
      for (const p of map.props) counts.set(p.defId, (counts.get(p.defId) || 0) + 1);
      return counts;
    };
    const a = profile(createMap(1));
    const b = profile(createMap(2));
    let differing = 0;
    for (const key of new Set([...a.keys(), ...b.keys()])) {
      if ((a.get(key) || 0) !== (b.get(key) || 0)) differing++;
    }
    assert.ok(differing >= 6, `only ${differing} kinds of scenery differ between two seeds`);
  });
});

describe('the new districts', () => {
  test('a rail yard, a farm and a quarry all turn up', () => {
    const kinds = new Set();
    for (const seed of SWEEP) {
      for (const p of createMap(seed).props) kinds.add(p.defId);
    }
    for (const want of ['boxcar', 'tanker', 'signal', 'barn', 'windpump', 'crusher', 'bunker']) {
      assert.ok(kinds.has(want), `no ${want} on any of ${SWEEP.length} seeds`);
    }
  });

  test('a rail yard lays sidings, and they are recorded for the renderer', () => {
    // Rails are ROAD, because the five terrain indices are fixed. `map.rails`
    // is the only thing that stops a yard painting as four parallel roads.
    let yards = 0;
    for (const seed of SWEEP) {
      const map = createMap(seed);
      if (map.rails.length === 0) continue;
      yards++;
      // Recorded in mirrored pairs, like everything else on the map.
      const key = (r) => `${r.x0},${r.y0},${r.x1},${r.y1}`;
      const placed = new Set(map.rails.map(key));
      for (const r of map.rails) {
        const twin = {
          x0: map.width - 1 - r.x1,
          y0: map.height - 1 - r.y1,
          x1: map.width - 1 - r.x0,
          y1: map.height - 1 - r.y0,
        };
        assert.ok(placed.has(key(twin)), `seed ${seed}: a siding at ${key(r)} has no mirror`);
      }
    }
    assert.ok(yards > 8, `only ${yards} of ${SWEEP.length} seeds built a rail yard`);
  });

  test('a quarry is a hole with a way in and scrap at the bottom', () => {
    let pits = 0;
    for (const seed of SWEEP) {
      const map = createMap(seed);
      for (const p of map.props) {
        if (p.defId !== 'crusher') continue;
        pits++;
        // The pit is somewhere near its plant, and it has scrap in it. Not a
        // precise position — the plant is placed by fit and can slide.
        let scrap = 0;
        for (let y = p.cy - 16; y <= p.cy + 16; y++) {
          for (let x = p.cx - 16; x <= p.cx + 16; x++) {
            if (x < 0 || y < 0 || x >= map.width || y >= map.height) continue;
            if (map.resource[y * map.width + x] > 0) scrap++;
          }
        }
        assert.ok(scrap > 0, `seed ${seed}: a quarry at ${p.cx},${p.cy} with nothing in it`);
      }
    }
    assert.ok(pits > 0, 'no quarry on any tested seed');
  });

  test('every new prop has a footprint, a height and something to say', () => {
    for (const id of ['boxcar', 'tanker', 'signal', 'barn', 'windpump', 'crusher', 'bunker']) {
      const def = PROPS[id];
      assert.ok(def, `${id} is not in the props table`);
      assert.ok(def.height > 0, `${id} has no height for the renderer`);
      assert.ok(def.size[0] > 0 && def.size[1] > 0, `${id} has no footprint`);
      assert.ok(def.hp > 0, `${id} cannot be knocked down`);
      assert.ok(def.hint && def.hint.length > 8, `${id} has no hint`);
    }
    // The yard's hazard has to be a hazard, or a rail yard is a safer estate.
    assert.ok(PROPS.tanker.deathExplosion.damage > 200);
    assert.ok(PROPS.tanker.hp < PROPS.boxcar.hp, 'the volatile wagon should be the fragile one');
  });
});

describe('the campaign still runs on these maps', () => {
  test('every mission generates a playable map', () => {
    for (const m of MISSIONS) {
      const map = createMap(m.id.length * 7919, { width: m.mapSize, height: m.mapSize });
      const [a, b] = map.starts;
      assert.ok(reaches(map, a, b), `${m.id} at ${m.mapSize} is partitioned`);
    }
  });
});
