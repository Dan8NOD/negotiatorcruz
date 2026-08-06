/**
 * Terrain, map generation and pathfinding.
 *
 * The map is a plain grid: one Uint8Array of terrain classes, one Uint16Array
 * of scrap remaining per cell, and one Uint8Array marking cells a structure
 * has claimed. Ground units path on cells; air units ignore all of it.
 *
 * Generation is 180°-rotationally symmetric on purpose. An RTS map that is not
 * mirrored is a map where one player's expansion is closer to the middle, and
 * no amount of unit balance fixes that.
 */

import { TERRAIN, TERRAIN_INFO, PROPS, MIN_TERRAIN_COST } from './content.js';
import { createRng } from './rng.js';
import { len, ringOffset } from './numeric.js';

/* ------------------------------------------------------------------ map -- */

/**
 * Default map edge.
 *
 * Doubled from the 72 the game shipped with. A 72×72 map is about ninety
 * seconds of walking corner to corner, which meant every fight happened in
 * the same contested middle and the flanks were decoration. At 144 there is
 * room for a route to be a *choice* — the road through the industrial
 * district or the long way round the ridge — which is the whole point of
 * having terrain at all.
 */
export const DEFAULT_MAP_SIZE = 144;

export function createMap(seed, { width = DEFAULT_MAP_SIZE, height = DEFAULT_MAP_SIZE } = {}) {
  const rng = createRng(seed ^ 0x9e3779b9);
  const map = {
    width,
    height,
    terrain: new Uint8Array(width * height),
    resource: new Uint16Array(width * height),
    /** The richness each cell started with — the ceiling regrowth restores to. */
    resourceMax: new Uint16Array(width * height),
    /** Entity id occupying each cell, or 0. Structures only. */
    occupied: new Uint32Array(width * height),
    starts: [],
    /** Wreck fields, kept as metadata so collectors can find a whole patch. */
    fields: [],
    /**
     * Destructible scenery, as placement data. The map generator decides
     * *where*; sim.js turns each one into an entity at world creation, because
     * only the sim can mint ids. Keeping generation free of entity concerns is
     * what lets the map be built and tested without a world.
     */
    props: [],
    /** Cells already claimed by a prop, so placement never double-books. */
    propCells: new Uint8Array(width * height),
  };

  carveTerrain(map, rng);

  // Start positions on opposing corners of the usable area, mirrored.
  const inset = Math.round(Math.min(width, height) * 0.16);
  map.starts = [
    { x: inset, y: inset },
    { x: width - 1 - inset, y: height - 1 - inset },
  ];

  for (const s of map.starts) clearArea(map, s.x, s.y, 6);

  // One guaranteed field per start, plus contested fields toward the middle.
  //
  // Every field is generated once and then *mirrored*, never generated twice
  // from the same stream. Two independent rolls produce two subtly different
  // patches, and "your home field had four more cells than mine" is exactly
  // the kind of invisible unfairness that makes a map feel wrong without
  // anyone being able to say why.
  const home = map.starts[0];
  addFieldPair(map, home.x + 5, home.y + 1, 4, 1500, rng);
  addFieldPair(map, Math.round(width * 0.33), Math.round(height * 0.62), 5, 1900, rng);
  addFieldPair(map, Math.round(width * 0.5), Math.round(height * 0.5), 6, 2600, rng);

  // Expansion fields, so a doubled map has something worth crossing it for.
  // Scaled by area: on the old 72×72 this adds none and the map is exactly
  // the three-field economy it always was.
  const extraFields = Math.max(0, Math.round((width * height) / 4200) - 1);
  for (let i = 0; i < extraFields; i++) {
    const fx = 6 + rng.int(width - 12);
    const fy = 6 + rng.int(height - 12);
    if (nearAny(map.starts, fx, fy, 14)) continue;
    addFieldPair(map, fx, fy, 4 + rng.int(2), 1400 + rng.int(700), rng);
  }

  // The opening Command Rig is 3×3 anchored one cell up and left of the
  // start, and `canPlace` refuses any footprint with scrap under it. The home
  // field is centred five cells away with a radius of four, so whether its
  // ragged edge reaches the rig has always been down to the seed — it just
  // happened not to on the seeds anyone had run. Clearing the footprint after
  // every field is stamped makes "your base fits where the game put you"
  // structural instead of lucky.
  for (const s of map.starts) clearResource(map, s.x, s.y, 2);

  // Scenery last: it reads the finished terrain and the wreck fields so it can
  // refuse to stand on either.
  const districts = planDistricts(map, rng);
  for (const d of districts) buildDistrict(map, d, rng);
  connectDistricts(map, districts);
  addLandmarks(map, rng);
  ensureConnected(map);

  return map;
}

/* ----------------------------------------------------------- connectivity -- */

/**
 * Guarantee the two starts can reach each other on foot.
 *
 * Ridgelines are long walls, and a long wall on an unlucky seed could
 * partition the map — at which point neither side can reach the other, no
 * objective can be completed, and the match is unwinnable. A generator that
 * does that on *some* seeds will do it to a player rather than to a test.
 *
 * In practice it does not happen: the gaps cut into every ridge, plus a road
 * network that paves straight through cliff, leave all six hundred seeds
 * swept connected without this. So this is a backstop, and it is tested as
 * one — against a map deliberately walled in half, not against a seed. It
 * stays because the cost is one flood fill at generation time and the failure
 * it prevents is an unwinnable match.
 *
 * The repair cuts *ground* rather than road: a road is unbuildable, and this
 * runs right through the middle of both bases.
 */
export function ensureConnected(map) {
  const [a, b] = map.starts;
  if (!a || !b) return;
  if (reachable(map, a, b)) return;

  cutCorridor(map, a.x, a.y, b.x, a.y);
  cutCorridor(map, b.x, a.y, b.x, b.y);
}

/** Breadth-first flood over passable cells. Terrain only — buildings move. */
function reachable(map, from, to) {
  const seen = new Uint8Array(map.width * map.height);
  const queue = [from.y * map.width + from.x];
  seen[queue[0]] = 1;
  const goal = to.y * map.width + to.x;

  for (let head = 0; head < queue.length; head++) {
    const at = queue[head];
    if (at === goal) return true;
    const x = at % map.width;
    const y = (at / map.width) | 0;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dy === 0) continue;
        const nx = x + dx;
        const ny = y + dy;
        if (!inBounds(map, nx, ny)) continue;
        const ni = ny * map.width + nx;
        if (seen[ni]) continue;
        if (!TERRAIN_INFO[map.terrain[ni]].passable) continue;
        seen[ni] = 1;
        queue.push(ni);
      }
    }
  }
  return false;
}

/** Flatten a two-cell-wide run to walkable ground, mirrored. */
function cutCorridor(map, x0, y0, x1, y1) {
  const steps = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0));
  if (steps === 0) return;
  const stepX = (x1 - x0) / steps;
  const stepY = (y1 - y0) / steps;
  const acrossX = Math.abs(stepX) > Math.abs(stepY) ? 0 : 1;
  const acrossY = acrossX === 1 ? 0 : 1;

  for (let s = 0; s <= steps; s++) {
    for (let lane = 0; lane < 2; lane++) {
      const x = Math.round(x0 + stepX * s) + acrossX * lane;
      const y = Math.round(y0 + stepY * s) + acrossY * lane;
      if (!inBounds(map, x, y)) continue;
      if (x < 1 || y < 1 || x >= map.width - 1 || y >= map.height - 1) continue;
      if (TERRAIN_INFO[map.terrain[y * map.width + x]].passable) continue;
      paintMirrored(map, x, y, TERRAIN.GROUND);
    }
  }
}

/* ------------------------------------------------------------ districts -- */

/**
 * The kinds of place a map can contain.
 *
 * Scattered props read as scenery. A *district* reads as somewhere — you
 * route through it, you fight over it, and you remember which one had the
 * propane depot in it. That memory is the thing worth generating.
 */
const DISTRICT_KINDS = ['suburb', 'downtown', 'industrial', 'park'];

/**
 * Choose district anchors: how many, where, and of what kind.
 *
 * Anchors are rolled rather than laid out, but rejected unless they clear the
 * start positions and every anchor already placed — an industrial estate
 * blended into a park is two districts nobody can name.
 *
 * Only the anchor is chosen here. Each district is stamped once and mirrored
 * by the prop placer, so both players always face the same city.
 */
function planDistricts(map, rng) {
  const { width, height } = map;
  const wanted = Math.max(2, Math.round((width * height) / 1500));
  const chosen = [];

  // A bounded number of attempts, not a loop until success: on a small or
  // cliff-heavy map there may be nowhere left, and spinning forever waiting
  // for a seed to cooperate is not a generation strategy.
  for (let attempt = 0; attempt < wanted * 12 && chosen.length < wanted; attempt++) {
    const x = 8 + rng.int(Math.max(1, width - 16));
    const y = 8 + rng.int(Math.max(1, height - 16));
    if (nearAny(map.starts, x, y, 16)) continue;
    if (nearAny(chosen, x, y, 15)) continue;
    chosen.push({ x, y, kind: DISTRICT_KINDS[rng.int(DISTRICT_KINDS.length)] });
  }
  return chosen;
}

function nearAny(points, x, y, distance) {
  return points.some((p) => Math.abs(p.x - x) < distance && Math.abs(p.y - y) < distance);
}

function buildDistrict(map, district, rng) {
  switch (district.kind) {
    case 'downtown':
      return addDowntown(map, district.x, district.y, rng);
    case 'industrial':
      return addIndustrial(map, district.x, district.y, rng);
    case 'park':
      return addPark(map, district.x, district.y, rng);
    default:
      return addNeighbourhood(map, district.x, district.y, rng);
  }
}

/**
 * Tower blocks on a street grid, with the mast and the billboards that make a
 * skyline legible from across the map.
 *
 * Laid out on an actual grid of blocks rather than scattered, because the
 * silhouette of downtown should be the thing you navigate by when you are
 * lost — and a grid casts long straight firing lanes, which is a different
 * kind of fight from the suburbs.
 */
function addDowntown(map, cx, cy, rng) {
  const blocks = 2 + rng.int(2);
  for (let by = 0; by < blocks; by++) {
    for (let bx = 0; bx < blocks; bx++) {
      // Avenues between blocks: three cells of tarmac, wide enough to fight in.
      const x = cx + bx * 6;
      const y = cy + by * 6;
      if (rng.chance(0.22)) continue;
      addPropPair(map, rng.chance(0.45) ? 'tower' : 'apartment', x, y);
      if (rng.chance(0.4)) addPropPair(map, 'billboard', x + 3, y + 1);
    }
  }
  // Streets through the grid, so downtown is walkable rather than a wall.
  for (let i = 0; i <= blocks; i++) {
    paveLine(map, cx - 2, cy + i * 6 - 2, cx + blocks * 6, cy + i * 6 - 2, 2);
    paveLine(map, cx + i * 6 - 2, cy - 2, cx + i * 6 - 2, cy + blocks * 6, 2);
  }
  addPropPair(map, 'mast', cx + blocks * 3, cy - 3);
  if (rng.chance(0.6)) addPropPair(map, 'bus', cx - 1, cy + rng.int(blocks * 6));
}

/**
 * The dangerous one: fuel, grain dust and propane inside one blast radius of
 * each other.
 *
 * Everything volatile is placed close enough to chain, which makes the estate
 * a weapon rather than an obstacle — the reason to push an enemy into it, and
 * the reason not to garrison it yourself.
 */
function addIndustrial(map, cx, cy, rng) {
  addPropPair(map, 'warehouse', cx, cy);
  if (rng.chance(0.7)) addPropPair(map, 'warehouse', cx + 4, cy + 3);
  addPropPair(map, 'silo', cx - 3, cy + 1);
  if (rng.chance(0.55)) addPropPair(map, 'silo', cx - 3, cy + 4);

  // The tank farm, tight enough that one rocket takes the row.
  for (let i = 0; i < 4; i++) {
    addPropPair(map, 'tank', cx + 1 + (i % 2) * 2, cy + 4 + Math.floor(i / 2) * 2);
  }
  addPropPair(map, 'depot', cx + 4, cy - 2);
  addPropPair(map, 'watertower', cx - 3, cy - 3);
  if (rng.chance(0.5)) addPropPair(map, 'mast', cx + 7, cy + 1);
  paveLine(map, cx - 5, cy + 8, cx + 8, cy + 8, 2);
}

/** Green space: old growth, hedges, and something to stand around. */
function addPark(map, cx, cy, rng) {
  addPropPair(map, 'fountain', cx, cy);
  const trees = 6 + rng.int(7);
  for (let i = 0; i < trees; i++) {
    const off = ringOffset(i + 1, 3 + rng.int(5));
    addPropPair(
      map,
      rng.chance(0.45) ? 'pine' : 'tree',
      cx + Math.round(off.x),
      cy + Math.round(off.y)
    );
  }
  for (let i = 0; i < 3; i++) {
    if (!rng.chance(0.6)) continue;
    addPropPair(map, 'hedge', cx - 4 + rng.int(9), cy - 4 + rng.int(9));
  }
  if (rng.chance(0.4)) addPropPair(map, 'statue', cx + 3, cy - 3);
}

/**
 * Tarmac between the districts.
 *
 * The road network is the reason the map has a shape. Road costs 0.72 against
 * open ground's 1.0, so the quick way across is *through* the built-up
 * ground, where the buildings block line of sight and the fuel stations are
 * one stray rocket from going up. Going round the outside is safe and slow.
 * A player who never notices the roads still has a working map; a player who
 * does has a decision.
 *
 * Each district is joined to its nearest neighbour rather than to all of
 * them: a complete graph paves half the map and stops meaning anything.
 */
function connectDistricts(map, districts) {
  for (let i = 0; i < districts.length; i++) {
    let best = -1;
    let bestD = Infinity;
    for (let j = 0; j < districts.length; j++) {
      if (i === j) continue;
      const d = len(districts[i].x - districts[j].x, districts[i].y - districts[j].y);
      if (d < bestD) {
        bestD = d;
        best = j;
      }
    }
    if (best < 0) continue;
    const a = districts[i];
    const b = districts[best];
    // Dog-leg rather than diagonal: roads meet at junctions, and a diagonal
    // road across a square grid is a staircase of half-cells that reads as a
    // rendering bug.
    paveLine(map, a.x, a.y, b.x, a.y, 2);
    paveLine(map, b.x, a.y, b.x, b.y, 2);
  }
}

/**
 * Lay tarmac along a straight run, `lanes` cells wide, mirrored as it goes.
 *
 * Paves over cliff as well as ground, so a road is also a mountain pass: the
 * network is what guarantees the districts are connected at all, and a road
 * that dead-ends into a rock face is a road that generated a map nobody can
 * cross. Water is the exception — the surface simply stops at the bank and
 * picks up on the far side, which reads as a ford.
 *
 * Never paves near a start: roads are unbuildable, and discovering that the
 * only flat ground next to your Command Rig is a dual carriageway is not a
 * difficulty setting.
 */
function paveLine(map, x0, y0, x1, y1, lanes = 2) {
  const steps = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0));
  if (steps === 0) return;
  const stepX = (x1 - x0) / steps;
  const stepY = (y1 - y0) / steps;
  // Lanes are laid perpendicular to travel, so a vertical road widens sideways
  // and a horizontal one widens up and down.
  const acrossX = Math.abs(stepX) > Math.abs(stepY) ? 0 : 1;
  const acrossY = acrossX === 1 ? 0 : 1;

  for (let s = 0; s <= steps; s++) {
    const bx = Math.round(x0 + stepX * s);
    const by = Math.round(y0 + stepY * s);
    for (let lane = 0; lane < lanes; lane++) {
      const x = bx + acrossX * lane;
      const y = by + acrossY * lane;
      if (!inBounds(map, x, y)) continue;
      // Leave the sealed border alone.
      if (x < 1 || y < 1 || x >= map.width - 1 || y >= map.height - 1) continue;
      const i = y * map.width + x;
      if (map.terrain[i] === TERRAIN.WATER) continue;
      if (map.resource[i] > 0) continue;
      if (map.propCells[i]) continue;
      if (nearAny(map.starts, x, y, 9)) continue;
      paintMirrored(map, x, y, TERRAIN.ROAD);
    }
  }
}
/* ----------------------------------------------------------------- props -- */

/**
 * Place a prop and its exact 180° mirror.
 *
 * Same discipline as the wreck fields: rolled once, stamped twice. A map where
 * one player has a fuel station on their approach and the other does not is
 * unfair in a way nobody can articulate while they are losing to it.
 *
 * The mirrored anchor is not `(W-1-cx, H-1-cy)` — that mirrors the top-left
 * corner and puts a 2x2 footprint one cell off. It is the mirror of the
 * *bottom-right* corner, which is `(W-w-cx, H-h-cy)`.
 */
function addPropPair(map, defId, cx, cy) {
  const def = PROPS[defId];
  if (!def) return;
  const [w, h] = def.size;
  const twin = { x: map.width - w - cx, y: map.height - h - cy };
  for (const at of [{ x: cx, y: cy }, twin]) {
    if (!propFits(map, def, at.x, at.y)) continue;
    // A prop on the mirror line can map onto itself; placing it twice would
    // stack two entities on one footprint.
    if (map.props.some((p) => p.cx === at.x && p.cy === at.y)) continue;
    map.props.push({ defId, cx: at.x, cy: at.y });
    for (let y = at.y; y < at.y + h; y++) {
      for (let x = at.x; x < at.x + w; x++) map.propCells[y * map.width + x] = 1;
    }
  }
}

/** Buildable ground, inside the border, clear of starts, fields and other props. */
function propFits(map, def, cx, cy) {
  const [w, h] = def.size;
  for (let y = cy; y < cy + h; y++) {
    for (let x = cx; x < cx + w; x++) {
      if (x < 2 || y < 2 || x >= map.width - 2 || y >= map.height - 2) return false;
      const i = y * map.width + x;
      if (map.terrain[i] !== TERRAIN.GROUND) return false;
      if (map.resource[i] > 0) return false;
      if (map.propCells[i]) return false;
      // Keep the landing zones clear — opening a mission walled into your own
      // base by a tower block is not a difficulty setting.
      for (const s of map.starts) {
        if (Math.abs(x - s.x) <= 7 && Math.abs(y - s.y) <= 7) return false;
      }
    }
  }
  return true;
}

/**
 * A block of suburbia: a street with houses down both sides, trees between
 * them, and a fuel station on the corner.
 *
 * Deliberately gridded rather than scattered. Scattered props read as scenery;
 * a street reads as a *place*, and a place is something a player routes
 * through, fights over and remembers. The fuel station on the corner is the
 * hook — it turns "cut through the neighbourhood" into a decision.
 */
function addNeighbourhood(map, cx, cy, rng) {
  const horizontal = rng.chance(0.5);
  const length = 5 + rng.int(4);
  const road = [];

  for (let i = -length; i <= length; i++) {
    road.push({ x: horizontal ? cx + i : cx, y: horizontal ? cy : cy + i });
  }

  // The street is tarmac, not just cleared ground: a suburb you can drive
  // through fast is a suburb worth driving through.
  const first = road[0];
  const last = road[road.length - 1];
  paveLine(map, first.x, first.y, last.x, last.y, 1);

  // Houses face the street from both sides, with gaps for driveways.
  for (const cell of road) {
    for (const side of [-2, 2]) {
      if (rng.chance(0.28)) continue;
      const x = horizontal ? cell.x : cell.x + side;
      const y = horizontal ? cell.y + side : cell.y;
      const roll = rng.next();
      const defId = roll < 0.14 ? 'tree' : roll < 0.24 ? 'chapel' : 'house';
      addPropPair(map, defId, x, y);
    }
  }

  // Street trees and hedges in the verge.
  for (const cell of road) {
    if (!rng.chance(0.34)) continue;
    const side = rng.chance(0.5) ? -1 : 1;
    const x = horizontal ? cell.x : cell.x + side;
    const y = horizontal ? cell.y + side : cell.y;
    addPropPair(map, rng.chance(0.3) ? 'hedge' : 'tree', x, y);
  }

  // A bus abandoned across the road, because an empty street is a corridor
  // and a blocked one is a decision.
  if (rng.chance(0.45)) {
    const at = road[rng.int(road.length)];
    addPropPair(map, 'bus', at.x + 1, at.y + 1);
  }

  // The corner station.
  addPropPair(
    map,
    'gasstation',
    horizontal ? last.x + 1 : last.x - 2,
    horizontal ? last.y + 2 : last.y + 1
  );
}

/**
 * Everything that belongs to no district: the monument at the centre, the
 * relay masts on the high ground, and the old growth in between.
 */
function addLandmarks(map, rng) {
  const { width, height } = map;

  // A monument, because a map needs one thing you can navigate by. Spiralled
  // out from the centre rather than dropped on a fixed cell: the middle of
  // the map is usually a wreck field, and a landmark that only exists on some
  // seeds is not a landmark.
  const mx = Math.round(width * 0.5);
  const my = Math.round(height * 0.5);
  placed: for (let r = 4; r < 16; r++) {
    for (let a = 0; a < 8; a++) {
      const off = ringOffset(a + 1, r);
      const x = Math.round(mx + off.x);
      const y = Math.round(my + off.y);
      if (!propFits(map, PROPS.statue, x, y)) continue;
      addPropPair(map, 'statue', x, y);
      break placed;
    }
  }

  // Relay masts, scattered wide. They are the tallest thing on the map and
  // cost almost nothing to draw, so they are what gives a big map a horizon.
  const masts = Math.max(1, Math.round((width * height) / 5200));
  for (let i = 0; i < masts; i++) {
    addPropPair(map, 'mast', 4 + rng.int(width - 8), 4 + rng.int(height - 8));
  }

  // Old growth, thickest on rough ground where it reads as untended. Two
  // species mixed, because a forest of one tree is a texture and a forest of
  // two is a wood.
  const trees = Math.round((width * height) / 210);
  for (let i = 0; i < trees; i++) {
    addPropPair(map, rng.chance(0.35) ? 'pine' : 'tree', rng.int(width), rng.int(height));
  }

  // Hedgerows out in the open country, marking field boundaries nobody has
  // farmed in years.
  const hedges = Math.round((width * height) / 1300);
  for (let i = 0; i < hedges; i++) {
    addPropPair(map, 'hedge', rng.int(width), rng.int(height));
  }
}


/**
 * Random-walk blobs of cliff and rough, mirrored as they are written so the
 * two halves stay identical without a second pass.
 */
function carveTerrain(map, rng) {
  const { width, height } = map;
  const blobs = Math.round((width * height) / 220);

  // Ridgelines first, so the blobs weather them rather than the other way
  // round. A map made only of random blobs has texture but no *shape* — no
  // line you can hold, no flank that means anything. A ridge with a gap in it
  // is the cheapest terrain feature that creates a decision, so a big map
  // gets several and a small one gets one or two.
  const ridges = Math.max(1, Math.round((width * height) / 3400));
  for (let i = 0; i < ridges; i++) {
    carveRidge(map, rng);
  }

  for (let i = 0; i < blobs; i++) {
    const kind = rng.chance(0.55) ? TERRAIN.CLIFF : TERRAIN.ROUGH;
    let x = rng.int(width);
    let y = rng.int(height);
    const steps = 6 + rng.int(kind === TERRAIN.CLIFF ? 14 : 26);

    for (let s = 0; s < steps; s++) {
      paintMirrored(map, x, y, kind);
      if (rng.chance(0.4)) paintMirrored(map, x + 1, y, kind);
      if (rng.chance(0.4)) paintMirrored(map, x, y + 1, kind);
      x += rng.int(3) - 1;
      y += rng.int(3) - 1;
      if (x < 1 || y < 1 || x >= width - 1 || y >= height - 1) break;
    }
  }

  // A water feature or two, purely to break up sightlines.
  for (let i = 0; i < 2; i++) {
    const cx = rng.int(width);
    const cy = rng.int(height);
    const r = 2 + rng.int(3);
    for (let y = cy - r; y <= cy + r; y++) {
      for (let x = cx - r; x <= cx + r; x++) {
        if ((x - cx) ** 2 + (y - cy) ** 2 <= r * r) paintMirrored(map, x, y, TERRAIN.WATER);
      }
    }
  }

  // Keep a one-cell impassable border so nothing walks off the world.
  for (let x = 0; x < width; x++) {
    map.terrain[x] = TERRAIN.CLIFF;
    map.terrain[(height - 1) * width + x] = TERRAIN.CLIFF;
  }
  for (let y = 0; y < height; y++) {
    map.terrain[y * width] = TERRAIN.CLIFF;
    map.terrain[y * width + width - 1] = TERRAIN.CLIFF;
  }
}

/**
 * A long wall of cliff with passes cut through it.
 *
 * Walks a mostly-straight line with a wandering thickness, and punches a gap
 * every so often. The gaps are the point: a solid ridge partitions the map
 * and a ridge with three passes in it is a map where holding a pass is worth
 * something. Written mirrored, so the pass on your side is the pass on theirs.
 */
function carveRidge(map, rng) {
  const { width, height } = map;
  const horizontal = rng.chance(0.5);
  const span = horizontal ? width : height;
  const length = Math.round(span * (0.45 + rng.next() * 0.35));

  // Start off-centre and run across; a ridge through the exact middle would
  // mirror onto itself and read as a wall rather than as terrain.
  let drift = horizontal ? 6 + rng.int(height - 12) : 6 + rng.int(width - 12);
  const from = rng.int(Math.max(1, span - length));

  let sinceGap = 0;
  for (let s = 0; s < length; s++) {
    sinceGap++;
    // A pass every eight to eighteen cells, four cells wide.
    if (sinceGap > 8 + rng.int(10)) {
      sinceGap = -4;
      continue;
    }
    if (sinceGap < 0) continue;

    const thickness = 1 + rng.int(3);
    for (let t = 0; t < thickness; t++) {
      const x = horizontal ? from + s : drift + t;
      const y = horizontal ? drift + t : from + s;
      paintMirrored(map, x, y, TERRAIN.CLIFF);
    }
    // Rough ground at the foot of the ridge — scree, and a movement penalty
    // that makes going round it feel like going round something.
    const footX = horizontal ? from + s : drift - 1;
    const footY = horizontal ? drift - 1 : from + s;
    if (rng.chance(0.5)) paintMirroredIf(map, footX, footY, TERRAIN.ROUGH, TERRAIN.GROUND);

    if (rng.chance(0.34)) drift += rng.int(3) - 1;
    if (drift < 3) drift = 3;
    if (drift > (horizontal ? height : width) - 5) drift = (horizontal ? height : width) - 5;
  }
}

/** Paint only where the current terrain is `only` — used to skirt, not carve. */
function paintMirroredIf(map, x, y, kind, only) {
  if (!inBounds(map, x, y)) return;
  if (map.terrain[y * map.width + x] !== only) return;
  paintMirrored(map, x, y, kind);
}

function paintMirrored(map, x, y, kind) {
  const { width, height } = map;
  if (x < 0 || y < 0 || x >= width || y >= height) return;
  map.terrain[y * width + x] = kind;
  map.terrain[(height - 1 - y) * width + (width - 1 - x)] = kind;
}

/**
 * Strip scrap from a radius. Symmetric by construction, because it is applied
 * to every start and the starts are each other's mirror.
 */
function clearResource(map, cx, cy, r) {
  for (let y = cy - r; y <= cy + r; y++) {
    for (let x = cx - r; x <= cx + r; x++) {
      if (!inBounds(map, x, y)) continue;
      const i = y * map.width + x;
      map.resource[i] = 0;
      map.resourceMax[i] = 0;
    }
  }
}

/** Flatten a radius to buildable ground — used around start positions. */
function clearArea(map, cx, cy, r) {
  for (let y = cy - r; y <= cy + r; y++) {
    for (let x = cx - r; x <= cx + r; x++) {
      if (!inBounds(map, x, y)) continue;
      if (x === 0 || y === 0 || x === map.width - 1 || y === map.height - 1) continue;
      map.terrain[y * map.width + x] = TERRAIN.GROUND;
    }
  }
}

/**
 * A wreck field and its exact 180° mirror image. The shape is rolled once and
 * stamped twice, so both halves of the map are provably identical.
 *
 * A field centred on the map's own centre would mirror onto itself; that is
 * harmless — the second stamp simply rewrites the same cells.
 */
function addFieldPair(map, cx, cy, r, amountPerCell, rng) {
  const shape = [];
  for (let y = cy - r; y <= cy + r; y++) {
    for (let x = cx - r; x <= cx + r; x++) {
      const d = len(x - cx, y - cy);
      if (d > r) continue;
      if (d > r * 0.55 && rng.chance(0.45)) continue;
      shape.push({ dx: x - cx, dy: y - cy, amount: Math.round(amountPerCell * (1 - (d / r) * 0.4)) });
    }
  }

  stampField(map, cx, cy, shape, 1);
  stampField(map, map.width - 1 - cx, map.height - 1 - cy, shape, -1);
}

function stampField(map, cx, cy, shape, sign) {
  const cells = [];
  for (const s of shape) {
    const x = cx + s.dx * sign;
    const y = cy + s.dy * sign;
    if (!inBounds(map, x, y)) continue;
    const i = y * map.width + x;
    // Scrap sitting on a cliff would be unreachable; flatten it.
    if (!TERRAIN_INFO[map.terrain[i]].passable) map.terrain[i] = TERRAIN.GROUND;
    // Take the richer of the two where fields overlap. A centre field mirrors
    // onto itself and would otherwise have its own first stamp overwritten by
    // its second, quietly breaking the symmetry it was meant to guarantee.
    if (s.amount > map.resource[i]) map.resource[i] = s.amount;
    if (s.amount > map.resourceMax[i]) map.resourceMax[i] = s.amount;
    cells.push({ x, y });
  }
  if (cells.length) map.fields.push({ x: cx, y: cy, cells });
}

/* -------------------------------------------------------------- queries -- */

export function inBounds(map, x, y) {
  return x >= 0 && y >= 0 && x < map.width && y < map.height;
}

export function terrainAt(map, x, y) {
  if (!inBounds(map, x, y)) return TERRAIN.CLIFF;
  return map.terrain[y * map.width + x];
}

/**
 * Can a ground unit stand here? Air callers should not ask — they never
 * consult the grid at all.
 */
export function isWalkable(map, x, y) {
  if (!inBounds(map, x, y)) return false;
  const i = y * map.width + x;
  return TERRAIN_INFO[map.terrain[i]].passable && map.occupied[i] === 0;
}

/** Movement cost multiplier, or Infinity where a unit cannot go. */
export function moveCost(map, x, y) {
  if (!inBounds(map, x, y)) return Infinity;
  const i = y * map.width + x;
  if (map.occupied[i] !== 0) return Infinity;
  return TERRAIN_INFO[map.terrain[i]].cost;
}

/** Every cell a structure of this size anchored at (cx, cy) would cover. */
export function footprint(size, cx, cy) {
  const cells = [];
  for (let y = 0; y < size[1]; y++) {
    for (let x = 0; x < size[0]; x++) cells.push({ x: cx + x, y: cy + y });
  }
  return cells;
}

/**
 * Placement legality: flat, unoccupied, resource-free ground.
 * Deliberately strict — a half-buildable footprint is the most common source
 * of "why is my refinery in the cliff" bug reports in every RTS ever shipped.
 */
export function canPlace(map, size, cx, cy) {
  for (const c of footprint(size, cx, cy)) {
    if (!inBounds(map, c.x, c.y)) return false;
    const i = c.y * map.width + c.x;
    if (map.terrain[i] !== TERRAIN.GROUND) return false;
    if (map.occupied[i] !== 0) return false;
    if (map.resource[i] > 0) return false;
  }
  return true;
}

export function occupy(map, size, cx, cy, entityId) {
  for (const c of footprint(size, cx, cy)) {
    if (inBounds(map, c.x, c.y)) map.occupied[c.y * map.width + c.x] = entityId;
  }
}

export function vacate(map, size, cx, cy) {
  for (const c of footprint(size, cx, cy)) {
    if (inBounds(map, c.x, c.y)) map.occupied[c.y * map.width + c.x] = 0;
  }
}

/** Nearest walkable cell to (x, y), spiralling outward. Null if hopeless. */
export function nearestWalkable(map, x, y, maxRadius = 12) {
  if (isWalkable(map, x, y)) return { x, y };
  for (let r = 1; r <= maxRadius; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        if (isWalkable(map, x + dx, y + dy)) return { x: x + dx, y: y + dy };
      }
    }
  }
  return null;
}

/* ---------------------------------------------------------- pathfinding -- */

/**
 * Binary min-heap. Small enough to inline here rather than take a dependency,
 * and A* is the only thing in the engine that needs a priority queue.
 */
class MinHeap {
  constructor() {
    this.items = [];
    this.keys = [];
  }
  get size() {
    return this.items.length;
  }
  push(item, key) {
    this.items.push(item);
    this.keys.push(key);
    let i = this.items.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.keys[p] <= this.keys[i]) break;
      this.swap(i, p);
      i = p;
    }
  }
  pop() {
    const top = this.items[0];
    const lastItem = this.items.pop();
    const lastKey = this.keys.pop();
    if (this.items.length) {
      this.items[0] = lastItem;
      this.keys[0] = lastKey;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1;
        const r = l + 1;
        let m = i;
        if (l < this.keys.length && this.keys[l] < this.keys[m]) m = l;
        if (r < this.keys.length && this.keys[r] < this.keys[m]) m = r;
        if (m === i) break;
        this.swap(i, m);
        i = m;
      }
    }
    return top;
  }
  swap(a, b) {
    const ti = this.items[a];
    this.items[a] = this.items[b];
    this.items[b] = ti;
    const tk = this.keys[a];
    this.keys[a] = this.keys[b];
    this.keys[b] = tk;
  }
}

/**
 * Search scratch, reused across calls.
 *
 * A* needs three arrays the size of the map. Allocating and clearing them per
 * call was affordable on a 5,184-cell map and is not on a 20,736-cell one: a
 * twenty-unit move order is twenty searches, and twenty rounds of allocating
 * 160 KB and filling it with Infinity is a frame nobody gets back.
 *
 * Instead the buffers persist and every entry carries the generation that
 * wrote it. A cell whose stamp is not the current generation is unvisited,
 * which is exactly what the fills used to mean — same search, same expansion
 * order, same path, none of the clearing.
 *
 * Module-level rather than per-map because only one search ever runs at a
 * time: the engine is single-threaded and `findPath` never yields.
 */
let scratch = null;
let generation = 0;

function scratchFor(size) {
  if (!scratch || scratch.size !== size) {
    scratch = {
      size,
      cameFrom: new Int32Array(size),
      gScore: new Float32Array(size),
      closed: new Uint32Array(size),
      stamp: new Uint32Array(size),
    };
    generation = 0;
  }
  // Generation 0 means "never written", so wrapping past the 32-bit ceiling
  // has to skip it — and clear, because at that point stale stamps from four
  // billion searches ago would start reading as current.
  if (generation === 0xffffffff) {
    scratch.closed.fill(0);
    scratch.stamp.fill(0);
    generation = 0;
  }
  return scratch;
}

const SQRT2 = Math.SQRT2;

/**
 * Octile distance, scaled to the cheapest terrain — the admissible heuristic
 * for 8-way movement over a grid where a step can cost less than one.
 */
function heuristic(ax, ay, bx, by) {
  const dx = Math.abs(ax - bx);
  const dy = Math.abs(ay - by);
  return (dx + dy + (SQRT2 - 2) * Math.min(dx, dy)) * MIN_TERRAIN_COST;
}

/**
 * Nodes expanded by the last search.
 *
 * Diagnostic only — nothing in the simulation reads it, and it is written
 * where it cannot influence a decision. It exists because the difference
 * between a good search and a catastrophic one is invisible in the result:
 * both return a usable path, and only the work differs. Something has to be
 * able to see that work or it cannot be defended against regression.
 */
let lastExpanded = 0;
export const pathStats = () => ({ expanded: lastExpanded });

/**
 * A* over the cell grid.
 *
 * `goalRadius` lets a caller path *toward* something it cannot stand on — a
 * building, a wreck field, an enemy — by accepting any cell within that many
 * cells of the goal. Without it, every order issued onto an occupied cell
 * would search the entire map before failing.
 *
 * Returns an array of cell coordinates excluding the start, or null.
 */
export function findPath(map, sx, sy, gx, gy, { goalRadius = 0, maxNodes = 0 } = {}) {
  // The node ceiling has to scale with the map or it stops being a runaway
  // guard and becomes a range limit: 9000 was most of a 72×72 map and is
  // under half of a 144×144 one, so a corner-to-corner order across a big
  // map would bail out early and "walk as close as it got" — which looks
  // exactly like a unit refusing to cross the map.
  if (maxNodes <= 0) maxNodes = Math.max(9000, map.width * map.height * 1.5);
  sx |= 0;
  sy |= 0;
  gx |= 0;
  gy |= 0;
  if (!inBounds(map, sx, sy) || !inBounds(map, gx, gy)) return null;

  // A goal nobody can stand on is the expensive case, not the rare one: with
  // scenery on the map most stray clicks land on a tree, a wall or a wreck,
  // and A* can only discover "unreachable" by exhausting the search — a
  // whole-map expansion for a ten-cell order. Snapping to the nearest cell
  // that *can* be stood on turns that back into an ordinary short search.
  //
  // Only when the caller has not asked for a radius. `goalRadius` already
  // means "get near this", and moving the centre out from under it would
  // quietly change what near means.
  if (goalRadius <= 0 && !isWalkable(map, gx, gy)) {
    const spot = nearestWalkable(map, gx, gy, 6);
    if (spot) {
      gx = spot.x;
      gy = spot.y;
    }
  }

  if (sx === gx && sy === gy) return [];

  const w = map.width;
  const size = w * map.height;
  const { cameFrom, gScore, closed, stamp } = scratchFor(size);
  const mark = ++generation;
  const open = new MinHeap();

  const startIdx = sy * w + sx;
  gScore[startIdx] = 0;
  stamp[startIdx] = mark;
  // Reconstruction walks `cameFrom` until it hits -1, so the start must say
  // -1 *this* generation rather than whatever the last search left there.
  cameFrom[startIdx] = -1;
  open.push(startIdx, heuristic(sx, sy, gx, gy));

  const reached = (x, y) =>
    goalRadius <= 0 ? x === gx && y === gy : len(x - gx, y - gy) <= goalRadius;

  let expanded = 0;
  let best = -1;
  let bestH = Infinity;
  lastExpanded = 0;

  while (open.size > 0) {
    const current = open.pop();
    if (closed[current] === mark) continue;
    closed[current] = mark;

    const cx = current % w;
    const cy = (current / w) | 0;

    const h = heuristic(cx, cy, gx, gy);
    if (h < bestH) {
      bestH = h;
      best = current;
    }

    if (reached(cx, cy)) {
      lastExpanded = expanded;
      return reconstruct(cameFrom, current, w);
    }
    if (++expanded > maxNodes) break;

    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dy === 0) continue;
        const nx = cx + dx;
        const ny = cy + dy;
        const cost = moveCost(map, nx, ny);
        if (!isFinite(cost)) continue;

        // No cutting corners around a blocked cell — units would clip walls.
        if (dx !== 0 && dy !== 0) {
          if (!isFinite(moveCost(map, cx + dx, cy)) || !isFinite(moveCost(map, cx, cy + dy))) {
            continue;
          }
        }

        const ni = ny * w + nx;
        if (closed[ni] === mark) continue;
        const step = (dx !== 0 && dy !== 0 ? SQRT2 : 1) * cost;
        const tentative = gScore[current] + step;
        // An unvisited cell has no score this generation, which is the same
        // thing the old `fill(Infinity)` meant — just without paying for the
        // fill on every single call.
        if (stamp[ni] === mark && tentative >= gScore[ni]) continue;

        cameFrom[ni] = current;
        gScore[ni] = tentative;
        stamp[ni] = mark;
        open.push(ni, tentative + heuristic(nx, ny, gx, gy));
      }
    }
  }

  // Unreachable goal: walk as close as the search got rather than refusing the
  // order outright. Players read a refused move order as the game ignoring them.
  lastExpanded = expanded;
  if (best >= 0 && best !== startIdx) return reconstruct(cameFrom, best, w);
  return null;
}

function reconstruct(cameFrom, node, w) {
  const path = [];
  let cur = node;
  while (cur !== -1) {
    path.push({ x: cur % w, y: (cur / w) | 0 });
    cur = cameFrom[cur];
  }
  path.pop(); // drop the start cell
  path.reverse();
  return path;
}

/** Unobstructed straight line between two cell centres? */
export function hasLineOfWalk(map, x0, y0, x1, y1) {
  let dx = Math.abs(x1 - x0);
  let dy = Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1;
  const sy = y0 < y1 ? 1 : -1;
  let err = dx - dy;
  let x = x0;
  let y = y0;

  for (;;) {
    if (!isFinite(moveCost(map, x, y))) return false;
    if (x === x1 && y === y1) return true;
    const e2 = 2 * err;
    if (e2 > -dy) {
      err -= dy;
      x += sx;
    }
    if (e2 < dx) {
      err += dx;
      y += sy;
    }
  }
}

/**
 * String-pulling: drop every waypoint that can be skipped in a straight line.
 * A* on a grid produces staircases; this is what stops units mincing
 * diagonally across open ground.
 */
export function smoothPath(map, startX, startY, path) {
  if (!path || path.length < 2) return path || [];
  const out = [];
  let anchorX = startX | 0;
  let anchorY = startY | 0;
  let i = 0;

  while (i < path.length) {
    let furthest = i;
    for (let j = path.length - 1; j > i; j--) {
      if (hasLineOfWalk(map, anchorX, anchorY, path[j].x, path[j].y)) {
        furthest = j;
        break;
      }
    }
    out.push(path[furthest]);
    anchorX = path[furthest].x;
    anchorY = path[furthest].y;
    i = furthest + 1;
  }
  return out;
}
