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
 *
 * A surface map is built in this order, and the order is load-bearing:
 *
 *   character   one roll, and every pass below reads it
 *   ridgelines  long walls, with the gaps recorded as they are cut
 *   blobs       weathering over the ridges
 *   ponds       sightline breakers
 *   river       last, so nothing can be painted into the channel
 *   starts      the landing zones, and the ground cleared around them
 *   passes      the recorded gaps widened — needs the starts to keep clear of
 *   fields      wreck fields, nudged off the water
 *   landmarks   a challenge's headquarters or castle, placed by fiat
 *   breaches    read the channel back: anything dry is a crossing
 *   districts   the places, and the roads that join them through the
 *               crossings and the passes
 *   scenery     trees, hedgerow, masts, and the garrisons at the chokepoints
 *
 * Nearly every rule in this file about what a pass may not do to a field, or a
 * quarry to a river, exists because two of those steps met on some seed and
 * quietly cancelled each other out.
 */

import { TERRAIN, TERRAIN_INFO, PROPS, MIN_TERRAIN_COST, BIOMES, DEFAULT_BIOME } from './content.js';
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

export function createMap(
  seed,
  { width = DEFAULT_MAP_SIZE, height = DEFAULT_MAP_SIZE, biome = DEFAULT_BIOME, landmarks = [] } = {}
) {
  const rng = createRng(seed ^ 0x9e3779b9);
  const biomeDef = BIOMES[biome] || BIOMES[DEFAULT_BIOME];
  /** Gaps punched through the ridgelines, handed to `openPasses` below. */
  let passes = [];
  const map = {
    width,
    height,
    /** Which world this is. Terrain indices are unchanged; see BIOMES. */
    biome: biomeDef.id,
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
    /**
     * Where each named landmark ended up, by prop id. A landmark is placed
     * once rather than mirrored, and `gateways.js` reads these to work out
     * where a shaft opens or a door stands.
     */
    landmarks: {},
    /**
     * Chambers cut out of the rock, for the underworld biomes. Empty on the
     * surface, where the open ground is the room and the cliffs are the walls.
     */
    rooms: [],

    /**
     * Which kind of place this map is. Rolled once from the seed and then
     * consulted by every later pass, which is what stops two seeds producing
     * the same map with the trees moved. Null underground: a chamber map's
     * character is that it is a chamber map.
     */
    character: null,

    /**
     * The watercourse, if this map has one: the channel's centre and width at
     * every step along its axis. Kept as arrays rather than as a cell mask
     * because everything that asks about the river asks *which side of it*
     * something is on, and that is one lookup rather than a flood fill.
     */
    river: null,

    /**
     * Every place the map narrows to something worth holding — bridges, the
     * ford, and the passes cut through the ridgelines.
     *
     * Recorded rather than rediscovered because three separate things need
     * them and none of them can find one by looking: the road network routes
     * *through* chokepoints instead of bulldozing its own, the scenery placer
     * garrisons them, and the renderer draws a bridge deck as a bridge rather
     * than as tarmac that happens to be over water.
     */
    crossings: [],
    chokepoints: [],

    /**
     * Sidings in the rail yards, as rectangles. Rails are ROAD like every
     * other prepared surface — the five terrain indices are fixed — so this
     * is the only thing that tells the renderer to draw sleepers instead of a
     * centre line. Without it a yard reads as four parallel roads.
     */
    rails: [],
  };

  if (biomeDef.generator === 'chambers') {
    carveChambers(map, biomeDef, rng);
  } else {
    // Rolled before anything is written, so every terrain pass below can bias
    // itself the same way. One roll, one map: an agricultural map has fewer
    // ridges *and* fewer tower blocks *and* more hedgerow, and that coherence
    // is the difference between a different map and the same map reshuffled.
    map.character = MAP_CHARACTERS[rng.int(MAP_CHARACTERS.length)].id;
    passes = carveTerrain(map, rng, characterOf(map), landmarks.length > 0);
  }

  // Start positions on opposing corners of the usable area, mirrored.
  const inset = Math.round(Math.min(width, height) * 0.16);
  map.starts = [
    { x: inset, y: inset },
    { x: width - 1 - inset, y: height - 1 - inset },
  ];

  for (const s of map.starts) clearArea(map, s.x, s.y, 6);

  // A chamber map is solid rock with holes in it, so the landing zones the
  // step above just cut are holes of their own until something joins them to
  // the network. On the surface this is what the open ground already is.
  if (biomeDef.generator === 'chambers') linkStartsToRooms(map);

  // Ridge gaps become *passes*: the good ones widened, all of them recorded so
  // the road network and the scenery placer can find them. Deferred until the
  // landing zones exist, because a pass twelve cells from a Command Rig is not
  // a chokepoint, it is a back door into somebody's base.
  if (passes.length) openPasses(map, rng, passes);

  // One guaranteed field per start, plus contested fields toward the middle.
  //
  // Every field is generated once and then *mirrored*, never generated twice
  // from the same stream. Two independent rolls produce two subtly different
  // patches, and "your home field had four more cells than mine" is exactly
  // the kind of invisible unfairness that makes a map feel wrong without
  // anyone being able to say why.
  //
  // Anchors are nudged clear of the water first. `stampField` flattens
  // impassable terrain so scrap is never stranded on a cliff — which, the
  // moment there was a river, meant a field landing on the channel quietly
  // punched a free crossing through it. The centre field is the one that did
  // it every time, because the centre of the map is exactly where a
  // rotationally symmetric watercourse has to pass.
  const home = map.starts[0];
  addFieldPair(map, home.x + 5, home.y + 1, 4, 1500, rng);
  addDryFieldPair(map, Math.round(width * 0.33), Math.round(height * 0.62), 5, 1900, rng);
  addDryFieldPair(map, Math.round(width * 0.5), Math.round(height * 0.5), 6, 2600, rng);

  // Expansion fields, so a doubled map has something worth crossing it for.
  // Scaled by area: on the old 72×72 this adds none and the map is exactly
  // the three-field economy it always was.
  const extraFields = Math.max(0, Math.round((width * height) / 4200) - 1);
  for (let i = 0; i < extraFields; i++) {
    const fx = 6 + rng.int(width - 12);
    const fy = 6 + rng.int(height - 12);
    if (nearAny(map.starts, fx, fy, 14)) continue;
    addDryFieldPair(map, fx, fy, 4 + rng.int(2), 1400 + rng.int(700), rng);
  }

  // A small, rich cache at the widened passes.
  //
  // A chokepoint is only worth holding if holding it pays. The road already
  // runs through the pass, which is worth something to a player who reads
  // maps; scrap in the gap is worth something to everybody, and it turns the
  // pass into the contested expansion every good RTS map has — an income you
  // can take, and cannot defend cheaply.
  for (const c of map.chokepoints) {
    if (!c.primary || c.kind !== 'pass' || !c.cache) continue;
    addDryFieldPair(map, c.x, c.y, 3, 2200, rng);
  }

  // The opening Command Rig is 3×3 anchored one cell up and left of the
  // start, and `canPlace` refuses any footprint with scrap under it. The home
  // field is centred five cells away with a radius of four, so whether its
  // ragged edge reaches the rig has always been down to the seed — it just
  // happened not to on the seeds anyone had run. Clearing the footprint after
  // every field is stamped makes "your base fits where the game put you"
  // structural instead of lucky.
  for (const s of map.starts) clearResource(map, s.x, s.y, 2);

  // Named landmarks before the ordinary scenery, so a headquarters claims its
  // ground and the districts grow around it rather than through it. One to a
  // map and *not* mirrored — which is a deliberate exception to the symmetry
  // rule above, and the reason for it is that a landmark is the objective
  // rather than a resource. Two headquarters would be two missions.
  landmarks.forEach((defId, i) => placeLandmark(map, defId, i, landmarks.length, rng));

  // Anything that flattens ground flattens water too, and the two things that
  // do it — a wreck field and a landmark's cleared ring — both run above this
  // line. So the river is re-read here rather than trusted: wherever it is no
  // longer wet, that is a crossing, and the map says so.
  if (map.river) noteRiverBreaches(map);

  // Scenery last: it reads the finished terrain and the wreck fields so it can
  // refuse to stand on either.
  if (biomeDef.generator === 'chambers') {
    furnishChambers(map, biomeDef, rng);
  } else {
    const districts = planDistricts(map, rng, characterOf(map));
    for (const d of districts) buildDistrict(map, d, rng);
    connectDistricts(map, districts);
    garrisonChokepoints(map, rng);
    addLandmarks(map, rng, characterOf(map));
  }
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

/* ------------------------------------------------------- map character -- */

/**
 * What kind of place this map is, rolled once from the seed.
 *
 * The generator was good and it was also the same map every time: seven
 * districts of assorted kinds, a couple of ridges and a fixed helping of
 * trees, reshuffled. Ten matches in, a player can feel that — every map has
 * the same *density*, and density is most of what a place feels like.
 *
 * So the mix is rolled once and every later pass reads it. A conurbation has
 * fewer ridges and more tower blocks; farmland has hedgerow instead of
 * downtown and twice the old growth; quarry country is broken up by rock and
 * has holes dug in it. The numbers are multipliers against the counts that
 * were already there, so no character can produce a map the generator could
 * not have produced before — it can only produce one it would rarely have
 * chosen, which is exactly the difference between variety and chaos.
 *
 * `mix` is an array rather than an object because the weighted pick walks it
 * in order and object key order is a language guarantee nobody should have to
 * look up — and because the Swift port has to walk it the same way.
 */
const MAP_CHARACTERS = [
  {
    id: 'sprawl',
    name: 'Conurbation',
    districts: 1.5,
    ridges: 0.6,
    blobs: 0.8,
    trees: 0.45,
    hedges: 0.5,
    ponds: 1,
    /** A narrow channel with hard banks: a city river is a canal. */
    river: { width: 3, pairs: 2 },
    mix: [
      ['downtown', 4],
      ['suburb', 4],
      ['industrial', 2],
      ['railyard', 2],
      ['park', 2],
    ],
  },
  {
    id: 'pastoral',
    name: 'Farmland',
    districts: 0.9,
    ridges: 0.7,
    blobs: 0.8,
    trees: 1.4,
    hedges: 1.5,
    ponds: 2,
    river: { width: 3, pairs: 2 },
    mix: [
      ['farm', 6],
      ['suburb', 2],
      ['park', 2],
      ['railyard', 1],
      ['industrial', 1],
    ],
  },
  {
    id: 'broken',
    name: 'Quarry Country',
    districts: 0.8,
    ridges: 2.0,
    blobs: 1.35,
    trees: 0.8,
    hedges: 0.6,
    ponds: 1,
    river: { width: 3, pairs: 2 },
    mix: [
      ['quarry', 5],
      ['industrial', 2],
      ['suburb', 2],
      ['railyard', 1],
      ['park', 1],
      ['farm', 1],
    ],
  },
  {
    id: 'works',
    name: 'The Works',
    districts: 1.3,
    ridges: 0.9,
    blobs: 0.9,
    trees: 0.5,
    hedges: 0.5,
    ponds: 1,
    river: { width: 4, pairs: 2 },
    mix: [
      ['railyard', 5],
      ['industrial', 5],
      ['suburb', 2],
      ['downtown', 1],
      ['quarry', 1],
    ],
  },
  {
    id: 'delta',
    name: 'Floodplain',
    districts: 1.0,
    ridges: 0.5,
    blobs: 0.7,
    trees: 1.0,
    hedges: 1.0,
    ponds: 3,
    /**
     * The wide one, and the reason this character exists. A five-cell channel
     * with three ponds around it is a different map from a three-cell one:
     * more of the ground is water, so more of the fighting happens at the
     * places where it is not.
     */
    river: { width: 5, pairs: 2 },
    mix: [
      ['farm', 3],
      ['suburb', 3],
      ['park', 2],
      ['industrial', 2],
      ['railyard', 1],
      ['downtown', 1],
    ],
  },
];

/** The character record for a map, falling back to the first for old saves. */
function characterOf(map) {
  return MAP_CHARACTERS.find((c) => c.id === map.character) || MAP_CHARACTERS[0];
}

/** Every character, for tests and for anything that wants to name one. */
export const MAP_CHARACTER_IDS = MAP_CHARACTERS.map((c) => c.id);

/** Which district kinds a character can roll, weight included. For tests. */
export const characterMix = (id) => {
  const c = MAP_CHARACTERS.find((k) => k.id === id);
  return c ? c.mix : [];
};

/** Weighted pick from `[value, weight]` pairs. One rng draw, order-stable. */
function pickWeighted(rng, pairs) {
  let total = 0;
  for (const [, weight] of pairs) total += weight;
  let roll = rng.next() * total;
  for (const [value, weight] of pairs) {
    roll -= weight;
    if (roll < 0) return value;
  }
  return pairs[pairs.length - 1][0];
}

/* ------------------------------------------------------------ districts -- */

/**
 * The kinds of place a map can contain.
 *
 * Scattered props read as scenery. A *district* reads as somewhere — you
 * route through it, you fight over it, and you remember which one had the
 * propane depot in it. That memory is the thing worth generating.
 *
 * The three later ones were each chosen for the shape of the fight in them
 * rather than for how they draw: a rail yard is parallel firing lanes with
 * hard cover across them, a farm is open ground cut into rooms by hedge you
 * can see over and cannot walk through, and a quarry is a hole in the map
 * with one ramp and the richest scrap on it at the bottom.
 *
 * Exported rather than consumed here — `buildDistrict` dispatches on the kind
 * and every character's `mix` names its own — so that a test can assert the
 * mixes between them cover the whole list. A district kind that no character
 * ever rolls is a district kind nobody will ever see.
 */
export const DISTRICT_KINDS = [
  'suburb',
  'downtown',
  'industrial',
  'park',
  'railyard',
  'farm',
  'quarry',
];

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
function planDistricts(map, rng, character) {
  const { width, height } = map;
  const wanted = Math.max(2, Math.round(((width * height) / 1500) * character.districts));
  const chosen = [];

  // A bounded number of attempts, not a loop until success: on a small or
  // cliff-heavy map there may be nowhere left, and spinning forever waiting
  // for a seed to cooperate is not a generation strategy.
  for (let attempt = 0; attempt < wanted * 12 && chosen.length < wanted; attempt++) {
    const x = 8 + rng.int(Math.max(1, width - 16));
    const y = 8 + rng.int(Math.max(1, height - 16));
    if (nearAny(map.starts, x, y, 16)) continue;
    if (nearAny(chosen, x, y, 15)) continue;
    chosen.push({ x, y, kind: pickWeighted(rng, character.mix) });
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
    case 'railyard':
      return addRailYard(map, district.x, district.y, rng);
    case 'farm':
      return addFarm(map, district.x, district.y, rng);
    case 'quarry':
      return addQuarry(map, district.x, district.y, rng);
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
 * A rail yard: three or four sidings, the stock left standing on them, and a
 * shed at one end.
 *
 * The best battlefield of the new districts, and it is the geometry that does
 * it. Parallel tracks are parallel *fast lanes*, so a yard is several routes
 * through one district; the wagons standing on them are hard cover across
 * those lanes rather than along them, so every siding is a firing lane with
 * doors in it; and the tank wagons are a chain hazard strung out down a lane
 * rather than piled in a corner the way the estate's tank farm is. Pushing
 * down a siding and pushing *across* one are different problems, which is the
 * most a district can be asked to do.
 *
 * Sidings always run east–west, like the estate and downtown before it. The
 * rolling stock is a fixed 3×1 footprint and props do not rotate, and a yard
 * is a long straight thing whose direction is not the interesting variable.
 *
 * Stock goes down *before* the track is laid, because `paveLine` refuses to
 * pave a cell a prop has claimed and `propFits` refuses to stand a prop on
 * road. Doing it the other way round produces a yard with no wagons in it.
 */
function addRailYard(map, cx, cy, rng) {
  const sidings = 3 + rng.int(2);
  const length = 16 + rng.int(10);
  const x0 = cx - Math.round(length / 2);
  const x1 = x0 + length;

  for (let i = 0; i < sidings; i++) {
    const y = cy + i * 3;
    const wagons = 1 + rng.int(3);
    for (let k = 0; k < wagons; k++) {
      const at = x0 + 2 + rng.int(Math.max(1, length - 6));
      // One wagon in six is a tanker: enough that a yard is dangerous, few
      // enough that a player has to look at which one they are standing next
      // to rather than treating the whole district as a minefield.
      addPropPair(map, rng.chance(0.17) ? 'tanker' : 'boxcar', at, y);
    }
    paveLine(map, x0, y, x1, y, 1);
    addRailPair(map, x0, y, x1, y);
  }

  // The shed and the yard buildings, clear of the running lines.
  addPropPair(map, 'warehouse', x0 - 4, cy);
  if (rng.chance(0.6)) addPropPair(map, 'warehouse', x0 - 4, cy + 3);
  addPropPair(map, 'watertower', x1 + 1, cy + sidings * 3 - 4);

  // Signals at both throats, which is what makes a yard read as a yard from
  // across the map — they are the only tall thing in it.
  addPropPair(map, 'signal', x0 - 1, cy - 2);
  addPropPair(map, 'signal', x1 + 1, cy - 2);
  if (rng.chance(0.5)) addPropPair(map, 'signal', x1 + 1, cy + sidings * 3);

  // The yard road, along the far side of the sidings.
  paveLine(map, x0 - 4, cy + sidings * 3, x1 + 2, cy + sidings * 3, 2);
}

/**
 * A farm: a yard, and the fields around it marked out in hedge.
 *
 * The hedgerows are the district. They are `low`, so they block a walker and
 * hide nothing — which turns open country into a set of rooms you can see
 * across and cannot walk across, and that is a completely different fight
 * from the suburb's blind corners. The gaps rolled into each run are the
 * gates, and a gate is a chokepoint that costs one prop to make.
 *
 * The silos are the hazard, and they are the *right* hazard here: grain dust
 * is a wide soft blast, so a farm punishes standing in the yard rather than
 * punishing walking past a forecourt.
 */
function addFarm(map, cx, cy, rng) {
  addPropPair(map, 'barn', cx, cy);
  addPropPair(map, 'house', cx + 5, cy + 1);
  addPropPair(map, 'silo', cx - 3, cy - 1);
  if (rng.chance(0.6)) addPropPair(map, 'silo', cx - 3, cy + 2);
  addPropPair(map, 'windpump', cx + 5, cy - 3);
  if (rng.chance(0.5)) addPropPair(map, 'tank', cx + 2, cy + 3);

  // Field boundaries, out past the yard in both directions. Two runs each way
  // makes a grid of fields; one would read as a fence.
  //
  // Kept deliberately short. A hedgerow is one prop every two cells and the
  // pastoral character puts six farms on a map, so a boundary that reaches
  // eighteen cells rather than eleven is another four hundred neutral entities
  // in the spatial index for scenery nobody can see the far end of. This is
  // the one district whose prop count has to be watched.
  const runs = 2;
  const reach = 9 + rng.int(4);
  for (let i = 0; i < runs; i++) {
    const y = cy - reach + Math.round(((i + 1) / (runs + 1)) * reach * 2);
    for (let x = cx - reach; x < cx + reach; x += 2) {
      if (rng.chance(0.16)) continue;
      addPropPair(map, 'hedge', x, y);
    }
  }
  for (let i = 0; i < runs; i++) {
    const x = cx - reach + Math.round(((i + 1) / (runs + 1)) * reach * 2);
    for (let y = cy - reach; y < cy + reach; y++) {
      if (rng.chance(0.2)) continue;
      addPropPair(map, 'hedge', x, y);
    }
  }

  // Trees in the boundaries, because a hedgerow with nothing standing in it is
  // a wall rather than a hedgerow.
  const trees = 3 + rng.int(4);
  for (let i = 0; i < trees; i++) {
    const off = ringOffset(i + 1, 6 + rng.int(reach - 6));
    addPropPair(map, 'tree', cx + Math.round(off.x), cy + Math.round(off.y));
  }

  // The farm track out to wherever the road network finds it.
  paveLine(map, cx + 2, cy + 2, cx + 2, cy + reach, 1);
}

/**
 * A quarry: a hole in the map with one or two ramps into it, and the best
 * scrap on the map at the bottom.
 *
 * The only district that is terrain rather than scenery, and that is the
 * point of it. A rim of cliff with two gaps is a chokepoint that was not cut
 * into a ridgeline, in the middle of open ground, with a reason to go in —
 * you cannot hold the pit, you can only hold the ramp, and whoever is mining
 * down there is mining with their back to a wall.
 *
 * The floor is flattened before the scrap is stamped so the pit is standable;
 * the benches are rough, which taxes the approach without blocking it.
 */
function addQuarry(map, cx, cy, rng) {
  // Not on top of a chokepoint. This is the only district that writes cliff,
  // and it writes it *after* the passes have been widened and the crossings
  // laid — so a pit whose rim happened to land on a pass filled the pass back
  // in, leaving a chokepoint that the road routes to, the scenery garrisons,
  // and nothing can walk through. Somewhere else on the map is a better place
  // to dig; the estate goes here instead.
  if (nearAny(map.chokepoints, cx, cy, 16) || nearAny(map.crossings, cx, cy, 16)) {
    return addIndustrial(map, cx, cy, rng);
  }

  const r = 6 + rng.int(4);

  for (let y = cy - r; y <= cy + r; y++) {
    for (let x = cx - r; x <= cx + r; x++) {
      const d = len(x - cx, y - cy);
      if (d > r) continue;
      // Never over the channel. A quarry dropped on the river filled it in
      // over a ten-cell run — which cost the map its partition on one seed in
      // nine, silently, on exactly the character that generates the most
      // quarries. A working with water through it is a flooded working; a
      // river with a quarry through it is a bug.
      //
      // Never over scrap either: this is the only pass that writes *cliff*
      // after the wreck fields are stamped, and a rim laid across a field
      // buries scrap somewhere nothing can reach it.
      //
      // Both tests read something symmetric — the river record and the
      // resource grid — rather than the terrain being written, which is what
      // keeps the decision the same for a cell and for its mirror. A pit big
      // enough to overlap its own mirror image is painted in whatever order
      // the loop reaches the cells, and only a symmetric *decision* survives
      // that.
      if (inChannel(map, x, y)) continue;
      if (map.resource[y * map.width + x] > 0) continue;
      if (d > r - 1.7) paintMirrored(map, x, y, TERRAIN.CLIFF);
      else if (d > r - 3.4) paintMirrored(map, x, y, TERRAIN.ROUGH);
      else paintMirrored(map, x, y, TERRAIN.GROUND);
    }
  }

  // Haul ramps: a run of spoil cut straight out through the rim. Two at most —
  // a pit with a gap on every side is a bowl, not a quarry.
  const ramps = 1 + rng.int(2);
  for (let i = 0; i < ramps; i++) {
    const off = ringOffset(rng.int(8) + 1, 1);
    for (let step = 0; step <= r + 3; step++) {
      for (let lane = -1; lane <= 1; lane++) {
        const x = Math.round(cx + off.x * step) + (Math.abs(off.x) > Math.abs(off.y) ? 0 : lane);
        const y = Math.round(cy + off.y * step) + (Math.abs(off.x) > Math.abs(off.y) ? lane : 0);
        paintMirroredIf(map, x, y, TERRAIN.ROUGH, TERRAIN.CLIFF);
      }
    }
  }

  // The reason to go down there. Rich and small: an income worth taking and
  // impossible to defend cheaply, which is what an expansion should be.
  addFieldPair(map, cx, cy, Math.max(2, r - 5), 2500, rng);

  // The plant, outside the rim where there is ground to stand it on.
  addPropPair(map, 'crusher', cx + r + 1, cy - 1);
  addPropPair(map, 'warehouse', cx - r - 4, cy);
  addPropPair(map, 'tank', cx + r + 1, cy + 3);
  if (rng.chance(0.6)) addPropPair(map, 'tank', cx + r + 3, cy + 3);
  if (rng.chance(0.5)) addPropPair(map, 'watertower', cx - r - 4, cy - 4);
  paveLine(map, cx + r + 1, cy + 5, cx + r + 9, cy + 5, 2);
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
    routeRoad(map, districts[i], districts[best]);
  }

  // Every bridge is joined to the nearest district on each bank, whether or
  // not any pair of districts happened to want to cross there. A bridge the
  // network does not reach is a bridge nobody walks over: road is the fastest
  // ground in the game, so the network is most of what decides where a player
  // *goes*, and a chokepoint off it is scenery.
  for (const c of map.crossings) {
    if (c.kind === 'ford') continue;
    for (const side of [-1, 1]) {
      const near = nearestOnBank(map, districts, c, side);
      if (near) routeRoad(map, c, near);
    }
  }
}

/**
 * Tarmac from `a` to `b`, through whatever the map narrows to in between.
 *
 * The old version paved a dog-leg and let `paveLine` bulldoze anything in the
 * way, which is what kept the map connected and also what made the ridgelines
 * pointless: a road cut its own pass wherever it happened to meet rock, so
 * every ridge ended up with as many gaps as there were roads crossing it and
 * none of them meant anything. Routing through the gaps that are already
 * there is what turns a pass into *the* pass — a handful of them on a map,
 * four in five carrying a road, each visible on the minimap as the place the
 * tarmac necks down.
 *
 * Waypoints are ordered by how far along the run they are, so a route that
 * needs both a bridge and a pass takes them in the order it meets them.
 */
function routeRoad(map, a, b) {
  const via = [];

  const crossing = crossingBetween(map, a, b);
  if (crossing) via.push(crossing);

  const pass = passBetween(map, a, b);
  if (pass) via.push(pass);

  via.sort(
    (p, q) => len(p.x - a.x, p.y - a.y) - len(q.x - a.x, q.y - a.y)
  );

  let from = a;
  for (const point of [...via, b]) {
    // Dog-leg rather than diagonal: roads meet at junctions, and a diagonal
    // road across a square grid is a staircase of half-cells that reads as a
    // rendering bug.
    paveLine(map, from.x, from.y, point.x, from.y, 2);
    paveLine(map, point.x, from.y, point.x, point.y, 2);
    from = point;
  }
}

/** The crossing a route between two banks should use, or null if it stays put. */
function crossingBetween(map, a, b) {
  if (!map.river || map.crossings.length === 0) return null;
  const sideA = bankOf(map, a.x, a.y);
  const sideB = bankOf(map, b.x, b.y);
  if (sideA === 0 || sideB === 0 || sideA === sideB) return null;

  let best = null;
  let bestD = Infinity;
  for (const c of map.crossings) {
    const d = len(a.x - c.x, a.y - c.y) + len(b.x - c.x, b.y - c.y);
    if (d < bestD) {
      bestD = d;
      best = c;
    }
  }
  return best;
}

/**
 * The pass a route through a ridgeline should use, or null if it is not in
 * one's way.
 *
 * "In the way" is measured rather than assumed: the direct dog-leg is walked
 * and its cliff cells counted. Under four the road is skirting a boulder and
 * paving straight through is right; over it the route is going through a wall,
 * and a wall is what passes are for.
 *
 * The detour budget is what stops this producing absurd roads. A pass on the
 * far side of the map is not the answer to a ridge in front of you, however
 * legible it is.
 */
function passBetween(map, a, b) {
  let blocked = 0;
  const count = (x0, y0, x1, y1) => {
    const steps = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0));
    for (let s = 0; s <= steps; s++) {
      const x = Math.round(x0 + ((x1 - x0) * s) / Math.max(1, steps));
      const y = Math.round(y0 + ((y1 - y0) * s) / Math.max(1, steps));
      if (terrainAt(map, x, y) === TERRAIN.CLIFF) blocked++;
    }
  };
  count(a.x, a.y, b.x, a.y);
  count(b.x, a.y, b.x, b.y);
  if (blocked < 4) return null;

  const direct = len(a.x - b.x, a.y - b.y);
  let best = null;
  let bestD = Infinity;
  for (const c of map.chokepoints) {
    if (c.kind !== 'pass') continue;
    const d = len(a.x - c.x, a.y - c.y) + len(b.x - c.x, b.y - c.y);
    if (d > direct * 1.6 + 12) continue;
    if (d < bestD) {
      bestD = d;
      best = c;
    }
  }
  return best;
}

/** The district nearest a crossing on one particular bank of the river. */
function nearestOnBank(map, districts, crossing, side) {
  let best = null;
  let bestD = Infinity;
  for (const d of districts) {
    if (bankOf(map, d.x, d.y) !== side) continue;
    const dist = len(d.x - crossing.x, d.y - crossing.y);
    if (dist < bestD) {
      bestD = dist;
      best = d;
    }
  }
  return best;
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
 *
 * Never paves a ford either, and that one is a game rule rather than a
 * courtesy. The ford is the map's slow crossing — wide, shallow and rough —
 * and the whole reason it plays differently from the bridges is that it costs
 * 1.7 to walk instead of 0.72. A road laid over it is a second bridge that
 * happens to be eight cells wide, and the map has lost its safe crossing.
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
      if (inFord(map, x, y)) continue;
      paintMirrored(map, x, y, TERRAIN.ROAD);
    }
  }
}

/**
 * Is this cell part of a ford's shallows? See `paveLine`.
 *
 * Tolerates a map with no crossings list at all: the tests build bare grids by
 * hand to assert things about pathfinding, and a query that throws on one is a
 * query nobody can use outside the generator.
 */
function inFord(map, x, y) {
  if (!map.crossings) return false;
  for (const c of map.crossings) {
    if (c.kind !== 'ford') continue;
    if (x >= c.x0 && x <= c.x1 && y >= c.y0 && y <= c.y1) return true;
  }
  return false;
}

/**
 * Record a siding and its mirror.
 *
 * Rails are ROAD, because there are five terrain indices and there is never
 * going to be a sixth — pathfinding, vision, the Swift port and every saved
 * replay read raw indices. So the track is fast ground like any other
 * prepared surface, and this is the note that tells the renderer to draw
 * sleepers on it. Recording the mirror here rather than deriving it in the
 * renderer keeps the mirroring rule in one place.
 */
function addRailPair(map, x0, y0, x1, y1) {
  map.rails.push({ x0: Math.min(x0, x1), y0: Math.min(y0, y1), x1: Math.max(x0, x1), y1: Math.max(y0, y1) });
  map.rails.push({
    x0: map.width - 1 - Math.max(x0, x1),
    y0: map.height - 1 - Math.max(y0, y1),
    x1: map.width - 1 - Math.min(x0, x1),
    y1: map.height - 1 - Math.min(y0, y1),
  });
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
function addLandmarks(map, rng, character) {
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
  // two is a wood. Scaled by the map's character: this one number is most of
  // the difference between farmland and a conurbation at a glance.
  const trees = Math.round(((width * height) / 210) * character.trees);
  for (let i = 0; i < trees; i++) {
    addPropPair(map, rng.chance(0.35) ? 'pine' : 'tree', rng.int(width), rng.int(height));
  }

  // Hedgerows out in the open country, marking field boundaries nobody has
  // farmed in years.
  const hedges = Math.round(((width * height) / 1300) * character.hedges);
  for (let i = 0; i < hedges; i++) {
    addPropPair(map, 'hedge', rng.int(width), rng.int(height));
  }
}


/* -------------------------------------------------------- the underworld -- */

/**
 * The other kind of world: chambers cut out of solid rock.
 *
 * The surface generator starts from open ground and adds obstacles. This one
 * inverts it — everything is wall until something carves it away — and that
 * inversion is the whole difference in how the two play. Up top you route
 * *around* things and the map's shape is a suggestion; down here the map's
 * shape is the only thing there is, every fight happens in a room or in the
 * corridor between two, and a held doorway is genuinely held.
 *
 * Same discipline as the surface: every cell is written mirrored, so the two
 * halves are provably identical and neither side gets the better chamber.
 */
function carveChambers(map, biome, rng) {
  const { width, height } = map;
  map.terrain.fill(TERRAIN.CLIFF);

  const [minR, maxR] = biome.chamberRadius;
  const count = Math.max(4, Math.round((width * height) / 900));
  const rooms = [];

  for (let i = 0; i < count; i++) {
    const r = minR + rng.int(maxR - minR + 1);
    const x = r + 2 + rng.int(Math.max(1, width - (r + 2) * 2));
    const y = r + 2 + rng.int(Math.max(1, height - (r + 2) * 2));
    // Rooms are allowed to overlap — two chambers that share a wall read as
    // one bigger, more interesting space, and refusing the overlap produces a
    // grid of identical circles.
    carveChamber(map, x, y, r, rng);
    rooms.push({ x, y, r });
    // The mirror image is carved by paintMirrored as the original is written;
    // recording it here is what lets the corridor pass and the furnishing pass
    // see both halves.
    rooms.push({ x: width - 1 - x, y: height - 1 - y, r });
  }

  // Corridors. Each room reaches for the next one in the list plus one further
  // off, which produces a network with loops in it rather than a tree — a
  // corridor system you can only ever back out of is a corridor system where
  // every fight is decided by who walked in first.
  const half = rooms.filter((_, i) => i % 2 === 0);
  for (let i = 0; i < half.length; i++) {
    const a = half[i];
    const b = half[(i + 1) % half.length];
    cutTunnel(map, a.x, a.y, b.x, b.y, biome.corridor);
    if (i % 3 === 0) {
      const far = half[(i + 3) % half.length];
      cutTunnel(map, a.x, a.y, far.x, far.y, biome.corridor);
    }
  }

  // Chasms: the underworld's water. A hole in the floor of a room is the
  // cheapest way to make a chamber a shape rather than a circle.
  //
  // Minimum radius two, and only in a chamber with room for it: the circle
  // test at radius one produces a five-cell plus sign, and a keep whose moats
  // are little blue crosses reads as a rendering bug rather than as water.
  for (let i = 0; i < Math.max(1, Math.round(rooms.length / 6)); i++) {
    const room = rooms[rng.int(rooms.length)];
    if (room.r < 5) continue;
    const r = 2 + rng.int(Math.max(1, room.r - 4));
    for (let y = room.y - r; y <= room.y + r; y++) {
      for (let x = room.x - r; x <= room.x + r; x++) {
        if ((x - room.x) ** 2 + (y - room.y) ** 2 <= r * r) paintMirrored(map, x, y, TERRAIN.WATER);
      }
    }
  }

  weatherWalls(map, rng);
  map.rooms = rooms;

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
 * Break the straight edges off the rock.
 *
 * Corridors are axis-aligned, so the rock left standing between them comes out
 * as clean rectangles — which reads as a tiled dungeon rather than as a cave,
 * and the first zoomed-out screenshot made that unarguable. Nibbling the wall
 * cells that face open floor turns every straight run ragged for one pass over
 * the grid.
 *
 * Candidates are collected before any of them are written, because eroding in
 * place lets one nibbled cell expose the next and the whole wall dissolves.
 */
function weatherWalls(map, rng) {
  const { width, height } = map;
  const bite = [];

  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      if (map.terrain[y * width + x] !== TERRAIN.CLIFF) continue;
      let open = 0;
      for (const [dx, dy] of [
        [-1, 0],
        [1, 0],
        [0, -1],
        [0, 1],
      ]) {
        if (TERRAIN_INFO[map.terrain[(y + dy) * width + x + dx]].passable) open++;
      }
      // A cell with one open neighbour is the flat face of a wall; one with
      // three is a spur already. Chewing the faces is what does the work.
      if (open === 0 || open > 2) continue;
      if (!rng.chance(open === 1 ? 0.3 : 0.55)) continue;
      bite.push({ x, y });
    }
  }

  for (const cell of bite) paintMirrored(map, cell.x, cell.y, TERRAIN.ROUGH);
}

/** One chamber: a rough disc of floor with a scree fringe. */
function carveChamber(map, cx, cy, r, rng) {
  for (let y = cy - r; y <= cy + r; y++) {
    for (let x = cx - r; x <= cx + r; x++) {
      const d = len(x - cx, y - cy);
      if (d > r) continue;
      // A ragged edge, so a chamber reads as cut rather than as drawn.
      if (d > r * 0.78 && rng.chance(0.42)) continue;
      paintMirrored(map, x, y, d > r * 0.7 && rng.chance(0.4) ? TERRAIN.ROUGH : TERRAIN.GROUND);
    }
  }
}

/**
 * A corridor between two points, with the worn path down the middle.
 *
 * The centre line is ROAD — the same 0.72 movement cost the surface's tarmac
 * has — which keeps the map's one real routing decision intact underground:
 * the fast way is the middle of the corridor, and the middle of the corridor
 * is exactly where anything holding the far end is aiming.
 */
function cutTunnel(map, x0, y0, x1, y1, width) {
  const half = Math.max(0, Math.floor(width / 2));
  const carve = (x, y) => {
    for (let dy = -half; dy <= half; dy++) {
      for (let dx = -half; dx <= half; dx++) {
        paintMirrored(map, x + dx, y + dy, TERRAIN.GROUND);
      }
    }
    paintMirrored(map, x, y, TERRAIN.ROAD);
  };

  // L-shaped: across, then down. Two straight runs make a corner, and a corner
  // is a place worth standing.
  const stepX = Math.sign(x1 - x0);
  for (let x = x0; x !== x1; x += stepX || 1) {
    carve(x, y0);
    if (!stepX) break;
  }
  const stepY = Math.sign(y1 - y0);
  for (let y = y0; y !== y1; y += stepY || 1) {
    carve(x1, y);
    if (!stepY) break;
  }
  carve(x1, y1);
}

/** Join each landing zone to the chamber nearest it. */
function linkStartsToRooms(map) {
  if (map.rooms.length === 0) return;
  for (const s of map.starts) {
    let best = map.rooms[0];
    let bestD = Infinity;
    for (const room of map.rooms) {
      const d = len(room.x - s.x, room.y - s.y);
      if (d < bestD) {
        bestD = d;
        best = room;
      }
    }
    cutTunnel(map, s.x, s.y, best.x, best.y, 3);
  }
}

/**
 * Scenery for a chamber map.
 *
 * Rolled per room rather than scattered over the whole map, for the same
 * reason the surface builds streets rather than sprinkling houses: a chamber
 * with a pillar in the middle and firestone round the edge is a place, and a
 * place is something you fight over twice.
 */
function furnishChambers(map, biome, rng) {
  for (const room of map.rooms) {
    const pieces = 2 + rng.int(4);
    for (let i = 0; i < pieces; i++) {
      const defId = biome.scenery[rng.int(biome.scenery.length)];
      const off = ringOffset(i + 1, room.r * (0.35 + rng.next() * 0.5));
      addPropPair(map, defId, Math.round(room.x + off.x), Math.round(room.y + off.y));
    }
    // One hazard near the centre of the bigger chambers, which is what turns
    // "the room with the pillar" into "the room you do not brawl in".
    if (room.r >= 6 && rng.chance(0.55)) {
      addPropPair(map, biome.hazard, room.x + 1, room.y + 1);
    }
  }
}

/* ------------------------------------------------------------ landmarks -- */

/**
 * Place a unique landmark and record where it went.
 *
 * Unlike every other prop this one is placed by fiat rather than by fit: the
 * ground under it is flattened, the scrap is stripped and a ring around it is
 * cleared. A challenge that only works on seeds where a 6×6 footprint happened
 * to find a home is not a challenge, it is a lottery — and a castle you cannot
 * walk round is a castle whose door nobody can reach.
 *
 * Landmarks are strung along the line between the two landing zones, weighted
 * toward the far end: whoever built the thing built it on their own ground.
 */
function placeLandmark(map, defId, index, total, rng) {
  const def = PROPS[defId];
  if (!def || map.starts.length < 2) return null;

  const [w, h] = def.size;
  const [from, to] = map.starts;
  const t = total <= 1 ? 0.72 : 0.55 + (index / Math.max(1, total - 1)) * 0.3;

  // A little sideways drift off the diagonal, so a two-landmark map does not
  // read as beads on a string. Rolled, so it is part of the seed.
  const drift = (rng.next() - 0.5) * Math.min(map.width, map.height) * 0.18;
  const ax = Math.round(from.x + (to.x - from.x) * t - drift);
  const ay = Math.round(from.y + (to.y - from.y) * t + drift);

  const cx = clampCell(map, ax - Math.floor(w / 2), w);
  const cy = clampCell(map, ay - Math.floor(h / 2), h, true);

  // Clear approach, floor and footprint, in that order: the ring is what
  // guarantees a way round to the door.
  const ring = Math.max(w, h) + 3;
  clearArea(map, cx + Math.floor(w / 2), cy + Math.floor(h / 2), ring);
  clearResource(map, cx + Math.floor(w / 2), cy + Math.floor(h / 2), ring);

  map.props.push({ defId, cx, cy });
  for (let y = cy; y < cy + h; y++) {
    for (let x = cx; x < cx + w; x++) {
      if (inBounds(map, x, y)) map.propCells[y * map.width + x] = 1;
    }
  }
  map.landmarks[defId] = { defId, cx, cy, size: [w, h] };
  return map.landmarks[defId];
}

/** Keep a footprint of `span` cells inside the sealed border. */
function clampCell(map, v, span, vertical = false) {
  const limit = (vertical ? map.height : map.width) - span - 3;
  return Math.max(3, Math.min(limit, v));
}

/**
 * Random-walk blobs of cliff and rough, mirrored as they are written so the
 * two halves stay identical without a second pass.
 *
 * Returns the gaps punched through the ridgelines. They are not turned into
 * passes here because that needs the landing zones, which do not exist yet.
 */
function carveTerrain(map, rng, character, hasLandmark) {
  const { width, height } = map;
  const blobs = Math.round(((width * height) / 220) * character.blobs);

  // Ridgelines first, so the blobs weather them rather than the other way
  // round. A map made only of random blobs has texture but no *shape* — no
  // line you can hold, no flank that means anything. A ridge with a gap in it
  // is the cheapest terrain feature that creates a decision, so a big map
  // gets several and a small one gets one or two.
  const passes = [];
  const ridges = Math.max(1, Math.round(((width * height) / 3400) * character.ridges));
  for (let i = 0; i < ridges; i++) {
    carveRidge(map, rng, passes);
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

  // Ponds. Still purely to break up sightlines — the watercourse below is a
  // different feature with a different job.
  for (let i = 0; i < character.ponds; i++) {
    const cx = rng.int(width);
    const cy = rng.int(height);
    const r = 2 + rng.int(3);
    for (let y = cy - r; y <= cy + r; y++) {
      for (let x = cx - r; x <= cx + r; x++) {
        if ((x - cx) ** 2 + (y - cy) ** 2 <= r * r) paintMirrored(map, x, y, TERRAIN.WATER);
      }
    }
  }

  // The river last, so a blob cannot land in the channel and plug it.
  //
  // Not on a map that carries a landmark, and the reason is arithmetic rather
  // than taste. `placeLandmark` clears a ring around its footprint so there is
  // a way to the door — nineteen cells across for the castle, wider than any
  // channel — and it runs *after* this, by fiat, on ground it does not check.
  // Where the two meet the river gets a nineteen-cell hole in it, on whichever
  // seeds they happen to collide, and a watercourse that partitions the map on
  // some seeds and not others is worse than one that never does. A challenge
  // map has a centrepiece already; this is the one for every other map.
  if (!hasLandmark && Math.min(width, height) >= 64) carveRiver(map, rng, character);

  // Keep a one-cell impassable border so nothing walks off the world.
  for (let x = 0; x < width; x++) {
    map.terrain[x] = TERRAIN.CLIFF;
    map.terrain[(height - 1) * width + x] = TERRAIN.CLIFF;
  }
  for (let y = 0; y < height; y++) {
    map.terrain[y * width] = TERRAIN.CLIFF;
    map.terrain[y * width + width - 1] = TERRAIN.CLIFF;
  }

  return passes;
}

/* ---------------------------------------------------------- the river -- */

/** Steps the channel centre may take, weighted toward not turning at all. */
const MEANDER = [-1, 0, 0, 1];

/**
 * A watercourse across the middle of the map, and the crossings over it.
 *
 * The strongest thing a map can have. Two decorative ponds break up a
 * sightline; a river makes every approach a *decision about which crossing*,
 * which is the only terrain feature that changes what a whole match is about.
 * Both landing zones sit on opposite corners, so a channel through the middle
 * lies across the line between them however it is oriented.
 *
 * ## Symmetry
 *
 * Only the half from the map's centre out to one edge is walked. Every cell is
 * written through `paintMirrored`, so the far half is the exact 180° image of
 * the near one and the two meet at the centre by construction — the same
 * rolled-once-stamped-twice discipline as the wreck fields and the props. A
 * river generated twice from the same stream would give one player a wider
 * channel or a bridge four cells further from their base, and that is the kind
 * of unfairness nobody can name while they are losing to it.
 *
 * ## Are the bridges destructible?
 *
 * No, and this is the interesting decision in the file, so here is the whole
 * argument.
 *
 * A destructible bridge is a better game, and it is the obvious fit for a
 * codebase whose thesis is that the map comes apart. It is also not something
 * a prop can be. A prop claims its cells through `occupy`, which makes them
 * *impassable*; `killEntity` frees them again through `vacate`. That is
 * exactly backwards for a bridge, which has to be passable while it stands
 * over water that is not. `vacate` clears the occupancy layer and never
 * touches terrain, so a prop standing on the channel is a wall on top of a
 * wall, and knocking it down changes nothing. Making the deck real needs a
 * terrain write on death — a hook in `killEntity`, in `engine/entities.js`,
 * which this change does not own. It is a small hook and it is worth having;
 * it is reported rather than written.
 *
 * The second half of the argument survives that hook, though, and it is why
 * the ford below exists either way. `ensureConnected` runs once, at
 * generation. A map whose spans can be dropped is a map that can be cut in
 * half at minute nine, and the honest defence — air units and jump jets are
 * the counterplay — is only half true here: a Collector has neither. An
 * economy that one rocket can permanently sever is a different game from the
 * one this is.
 *
 * So the answer this map generator gives is the one good RTS maps give: **the
 * middle crossing is a ford**. Wide, shallow, rough underfoot at 1.7 against
 * road's 0.72 — the slow, safe way over, and nothing can drop it because it is
 * not built. The flanking bridges are the fast, narrow way, and they are the
 * ones worth holding. If spans become destructible tomorrow, that ford is
 * already the guarantee that the map cannot be partitioned, and it is here
 * now rather than added in a panic afterwards. So is the marsh off each end of
 * the channel, below — between the two of them, no number of dropped bridges
 * can leave a Collector with nowhere to walk.
 *
 * What *is* destructible today is the bridgehead. The blockhouses at each end
 * are ordinary props, so the approach to a crossing can be opened up or shut
 * down with rockets, which is most of the fight over a bridge anyway.
 */
function carveRiver(map, rng, character) {
  const { width, height } = map;
  const horizontal = rng.chance(0.5);
  const span = horizontal ? width : height;
  const cross = horizontal ? height : width;
  const half = Math.floor((span - 1) / 2);

  // The water runs across the middle of the map and peters out into *marsh*
  // at both ends, and where exactly it stops is the most important number in
  // this file. It is derived rather than chosen, and that took a while to see.
  //
  // The first version was water edge to edge and cut the map cleanly in two,
  // which is what a river is for and which this game cannot afford. Every
  // route between the two landing zones was forced through five gaps: AI
  // skirmishes that had resolved in six minutes ran to sixteen or never
  // resolved at all, and two campaign missions stopped being winnable — a
  // scripted attack that used to walk at the enemy reactors spent the mission
  // queueing at a bridge instead. Nothing was broken. The map was simply
  // harder to cross than the game was built for.
  //
  // Leaving the ends merely *open* did not work either, and the reason is the
  // start layout rather than the river: both landing zones sit at 16% of the
  // map's edge, so an open reach at either end of the channel is an open reach
  // beside somebody's base. Going round cost fifteen per cent, and a fifteen
  // per cent detour is not a decision.
  //
  // Marsh answers both. Rough ground costs 1.7 against open ground's 1.0, so
  // the way round the end of the river is always *available* — nothing
  // stranded, no partition, the campaign's scripted attacks still arrive — and
  // always expensive, which keeps the crossings the routes that matter.
  //
  // And the water starts a clear eight cells past the landing zone rather than
  // at some fraction of the span, because `clearArea` levels a thirteen-cell
  // box around each zone *after* this runs. A channel that reaches further out
  // than that gets flattened into a causeway at somebody's front door — on
  // those seeds the start ended up inside a hole in its own river, and
  // shutting the crossings walled the base in completely.
  //
  // Symmetric by construction: the water stops at `margin` and its mirror
  // stops at `span - 1 - margin`, so each player has the same marsh to wade.
  const inset = Math.round(Math.min(width, height) * 0.16);
  const margin = inset + 8;

  const baseWidth = Math.max(3, character.river.width + rng.int(2));
  const centres = new Int16Array(span);
  const widths = new Uint8Array(span);

  // The channel that self-mirrors: an interval [c, c+w) maps onto itself only
  // at c = (cross - w) / 2. Starting there is what makes the two halves join
  // at the centre instead of meeting in a diagonal kink.
  const mid = Math.floor((cross - baseWidth) / 2);
  const band = Math.round(cross * 0.17);

  // The channel's position is tracked as a fraction and rounded to a cell.
  //
  // Stepping a whole cell per turn means a held direction runs at exactly 45°,
  // and a walk with this much persistence spends most of its length either at
  // 45° or bouncing off the band — which draws a zigzag, not a river. Half a
  // cell per step gives a shallow reach that takes twenty cells to move ten,
  // which is what a watercourse does. It also keeps the channel's movement
  // under one cell per step, so consecutive spans always overlap by at least
  // two cells and nothing can slip diagonally between them.
  let pos = mid;
  let c = mid;
  let drift = 0;
  for (let s = half; s >= margin; s--) {
    // A little breathing in the width, so the channel reads as a river rather
    // than as a canal. Never below three: at two cells a diagonal step can
    // find the corner between two water cells, and a river you can walk over
    // is a decorative stripe.
    const w = Math.max(3, baseWidth + (rng.chance(0.12) ? 1 : 0));
    centres[s] = c;
    widths[s] = w;

    for (let t = 0; t < w; t++) paintChannel(map, horizontal, s, c + t, TERRAIN.WATER);
    // Silt on both banks: texture, and a cost on the approach that makes the
    // crossings feel like crossings for one extra cell either side.
    if (rng.chance(0.55)) paintChannelIf(map, horizontal, s, c - 1, TERRAIN.ROUGH);
    if (rng.chance(0.55)) paintChannelIf(map, horizontal, s, c + w, TERRAIN.ROUGH);

    // Meander: a held direction rather than a fresh coin flip per cell, which
    // is the difference between a curve and a jitter. One cell per step at
    // most, so consecutive channels always overlap and nothing can slip
    // diagonally between them.
    //
    // Straight is twice as likely as either turn, and that ratio is doing
    // real work. An even three-way pick spends two thirds of its length
    // running at exactly 45°, which on the minimap is not a river — it is a
    // lightning bolt. Weighting the middle gives long shallow reaches with
    // bends between them, which is what a watercourse looks like from above.
    if (rng.chance(0.3)) drift = MEANDER[rng.int(MEANDER.length)];
    pos += drift * 0.5;
    if (pos < mid - band) {
      pos = mid - band;
      drift = 1;
    }
    if (pos > mid + band) {
      pos = mid + band;
      drift = -1;
    }
    c = Math.round(pos);
  }

  // The marsh, running on from where the water stops out to the edge. Wider
  // than the channel and widening as it goes, because a river ends in a fan
  // rather than a stub — and because the wider it is the more it costs to
  // wade, which is the whole job it is doing.
  for (let s = margin - 1; s >= 1; s--) {
    const spread = margin - s;
    for (let t = -1 - spread; t < widths[margin] + 1 + spread; t++) {
      // Only over open ground: the marsh is what the river leaves behind, not
      // something that eats the cliffs and the districts at the map's edge.
      paintChannelIf(map, horizontal, s, centres[margin] + t, TERRAIN.ROUGH);
    }
  }

  // Mirror the record. The cells are already mirrored on the grid; this is so
  // `bankOf` can answer for the far half without a second walk.
  for (let s = half + 1; s < span - margin; s++) {
    const ms = span - 1 - s;
    widths[s] = widths[ms];
    centres[s] = cross - centres[ms] - widths[ms];
  }

  map.river = { horizontal, span, cross, margin, centres, widths };

  // The ford, dead centre, self-mirroring.
  //
  // Fourteen cells of shallows, and the width is the load-bearing number in
  // this whole feature. Two AI skirmishes on a river map went from six
  // minutes to sixteen, and one never resolved at all, purely because every
  // army in the match had to file through the same narrow gaps: a push
  // arrives piecemeal, gets broken at the crossing, and goes home to rebuild,
  // and neither side can ever land a blow. A ford an army can walk through
  // abreast is what keeps a partitioned map a *decision* rather than a siege
  // that neither side can win.
  addCrossing(map, half, 6, 'ford', 0, TERRAIN.ROUGH);

  // Two pairs of bridges, spread down each half of the channel.
  //
  // Both numbers here were paid for in AI matches rather than reasoned out.
  //
  // *Where*: both landing zones sit on opposite corners, so the shortest line
  // between them runs through the middle of the map — through the ford. A
  // bridge out at the 10% mark is so far off that line that nothing ever uses
  // it, and the map collapses to one crossing that every unit in the match
  // walks through.
  //
  // *How many*: three crossings on a 144-cell frontage is a beautiful map and
  // an unresolvable one. Two AI skirmishes that finished in six minutes on the
  // old generator ran to sixteen and to never, because a pursuit that has to
  // funnel through one gap stops being a pursuit — the winning side spends the
  // endgame queueing while five surviving Collectors wander a map it has only
  // explored a third of. Five crossings is still a small number and still a
  // partition; it is simply one a beaten player cannot hide behind.
  //
  // The decks are five cells rather than three for the same reason: three is
  // the width a chokepoint wants to be and about half the width an RTS crowd
  // can get through, which is a traffic jam pretending to be a decision.
  // Spread across the *water's* reach rather than the map's span, which is the
  // only version of this that survives the marsh. Positioned as a fraction of
  // the span, a bridge could land out past where the channel stops — and a
  // deck over a channel that is not there is five cells of road painted at the
  // map's edge.
  const pairs = character.river.pairs;
  const from = margin + 5;
  const to = half - 6;
  for (let i = 0; i < pairs; i++) {
    const t = (i + 0.35 + rng.next() * 0.3) / pairs;
    addCrossing(map, Math.round(from + (to - from) * t), 2, 'bridge', 2, TERRAIN.ROAD);
  }
}

/** One cell of the channel, in river coordinates, mirrored. */
function paintChannel(map, horizontal, along, across, kind) {
  paintMirrored(map, horizontal ? along : across, horizontal ? across : along, kind);
}

/** The same, but only over open ground — used for banks, not for the channel. */
function paintChannelIf(map, horizontal, along, across, kind) {
  paintMirroredIf(
    map,
    horizontal ? along : across,
    horizontal ? across : along,
    kind,
    TERRAIN.GROUND
  );
}

/**
 * Lay a crossing over the channel and record it.
 *
 * `reach` is how far along the river the deck runs either side of its centre,
 * so a bridge is a five-cell strip and the ford is fourteen. The deck is
 * painted over everything in its footprint including cliff, for the same
 * reason `paveLine` paves cliff: a crossing that dead-ends into a rock face on
 * one bank is a crossing nobody can use, and the whole map's connectivity now
 * runs through these.
 */
function addCrossing(map, along, reach, kind, bank, terrain) {
  const { horizontal, span, centres, widths } = map.river;
  const record = (from, to) => {
    let lo = Infinity;
    let hi = -Infinity;
    for (let s = from; s <= to; s++) {
      if (s < 1 || s >= span - 1) continue;
      const c = centres[s];
      const w = widths[s];
      // Outside the water's reach there is no channel to deck over, and the
      // record is all zeroes. Painting it anyway laid a bridge across the top
      // two rows of the map — unmirrored, because this writes terrain
      // directly — and the symmetry tests found it before anyone had to look
      // at the corner of a map and wonder what that was.
      if (w === 0) continue;
      // `bank` is how far up the dry ground the crossing reaches. A bridge
      // needs two cells of abutment so the deck lands on something; a ford is
      // nothing but the channel gone shallow, and painting *it* two cells onto
      // each bank turned the river's one soft feature into a hard grey
      // rectangle laid across it — visibly a block rather than a shallows.
      for (let t = c - bank; t < c + w + bank; t++) {
        const x = horizontal ? s : t;
        const y = horizontal ? t : s;
        if (!inBounds(map, x, y)) continue;
        if (x < 1 || y < 1 || x >= map.width - 1 || y >= map.height - 1) continue;
        map.terrain[y * map.width + x] = terrain;
        lo = Math.min(lo, t);
        hi = Math.max(hi, t);
      }
    }
    if (!isFinite(lo)) return;
    const mid = Math.round((from + to) / 2);
    const across = Math.round((lo + hi) / 2);
    map.crossings.push({
      kind,
      x: horizontal ? mid : across,
      y: horizontal ? across : mid,
      horizontal,
      x0: horizontal ? from : lo,
      x1: horizontal ? to : hi,
      y0: horizontal ? lo : from,
      y1: horizontal ? hi : to,
    });
  };

  // Written directly rather than through `paintMirrored`, then recorded twice,
  // because the deck's *extent* differs between the two halves — the channel
  // is not the same width at `a` as at its mirror — and a mirrored write would
  // stamp the near half's rectangle onto the far half's channel.
  const twin = span - 1 - along;
  if (Math.abs(twin - along) <= 1) {
    // A crossing on the mirror line is its own twin, and on an even span the
    // two centres land one cell apart. Recording both would put two
    // overlapping fords in `map.crossings` where the map has one — but taking
    // just one of them is worse: its deck would run from 66 to 76 where its
    // own mirror image runs from 67 to 77, and a crossing that is not its own
    // mirror is a crossing one player reaches a cell sooner. So it is written
    // once, over the union of the two.
    record(Math.min(along, twin) - reach, Math.max(along, twin) + reach);
    return;
  }
  record(along - reach, along + reach);
  record(twin - reach, twin + reach);
}

/**
 * Which side of the river a cell is on: -1, 1, or 0 for in the channel or on
 * a map with no river.
 *
 * One array lookup rather than a flood fill, which is the whole reason the
 * channel is stored as centres and widths instead of as a cell mask.
 */
/** Where along its own axis the river actually has a channel. */
function inReach(river, s) {
  return s >= river.margin && s < river.span - river.margin;
}

/** Is this cell in the river's channel — the water, not the deck over it? */
function inChannel(map, x, y) {
  const r = map.river;
  if (!r) return false;
  const s = r.horizontal ? x : y;
  const t = r.horizontal ? y : x;
  if (!inReach(r, s)) return false;
  if (t < r.centres[s] || t >= r.centres[s] + r.widths[s]) return false;
  return !onCrossing(map, x, y);
}

export function bankOf(map, x, y) {
  const r = map.river;
  if (!r) return 0;
  const s = r.horizontal ? x : y;
  const t = r.horizontal ? y : x;
  // Zero in the open reach off each end of the channel, and that is the honest
  // answer rather than a fallback: out there the river separates nothing, so
  // a road between two points in it has no reason to detour to a bridge.
  if (!inReach(r, s)) return 0;
  if (t < r.centres[s]) return -1;
  if (t >= r.centres[s] + r.widths[s]) return 1;
  return 0;
}

/**
 * Find the places the river is no longer wet, and call them crossings.
 *
 * Two later passes flatten terrain without asking what was under it: a wreck
 * field, which levels impassable cells so scrap is never stranded on a cliff,
 * and a landmark's cleared ring. Field anchors are nudged off the water for
 * exactly this reason, but the nudge can fail on a crowded map and then the
 * channel has a hole in it.
 *
 * Rather than fight that, this reads the truth back off the grid. A dry run of
 * channel is a crossing whether or not anything meant it to be, and the road
 * network and the renderer should both be told about it — a hole the map does
 * not know about is a hole that gets no road, no bunkers and no bridge deck
 * drawn on it, which is how a player ends up walking over water.
 */
function noteRiverBreaches(map) {
  const { horizontal, span, centres, widths } = map.river;
  let runStart = -1;

  const close = (from, to) => {
    // Under three cells is a chip out of the bank, not a way across.
    if (from < 0 || to - from < 2) return;
    const a = Math.round((from + to) / 2);
    const c = centres[a];
    const w = widths[a];
    map.crossings.push({
      kind: 'causeway',
      x: horizontal ? a : c + Math.floor(w / 2),
      y: horizontal ? c + Math.floor(w / 2) : a,
      horizontal,
      x0: horizontal ? from : c - 1,
      x1: horizontal ? to : c + w,
      y0: horizontal ? c - 1 : from,
      y1: horizontal ? c + w : to,
    });
  };

  for (let s = map.river.margin; s < span - map.river.margin; s++) {
    let wet = false;
    for (let t = centres[s]; t < centres[s] + widths[s]; t++) {
      const x = horizontal ? s : t;
      const y = horizontal ? t : s;
      if (terrainAt(map, x, y) === TERRAIN.WATER) {
        wet = true;
        break;
      }
    }
    // A deck is a dry run on purpose and is already recorded; skip it or every
    // bridge would be logged twice, once as itself and once as a breach.
    if (!wet && !onCrossing(map, horizontal ? s : centres[s], horizontal ? centres[s] : s)) {
      if (runStart < 0) runStart = s;
    } else {
      close(runStart, s - 1);
      runStart = -1;
    }
  }
  close(runStart, span - map.river.margin - 1);
}

/** Is this cell inside any recorded crossing's rectangle? */
function onCrossing(map, x, y) {
  if (!map.crossings) return false;
  for (const c of map.crossings) {
    if (x >= c.x0 - 1 && x <= c.x1 + 1 && y >= c.y0 - 1 && y <= c.y1 + 1) return true;
  }
  return false;
}

/* ------------------------------------------------------- the chokepoints -- */

/**
 * Turn the ridgelines' gaps into passes worth the name.
 *
 * A four-cell gap in a ridge is a gap. What makes it a *pass* is that it is
 * wide enough to fight in rather than to file through, that the road goes
 * through it, that there is something at it worth taking, and that a player
 * can see all three from the minimap. This does the first; `routeRoad` does
 * the second, the pass cache does the third, and `garrisonChokepoints` does
 * the fourth.
 *
 * Not every gap: a map where every gap is a landmark has no landmarks. Under
 * half of them are widened, the rest stay as the goat tracks they were —
 * usable, unimproved, and the flank that a player who has read the map takes
 * while everybody else is at the pass.
 */
function openPasses(map, rng, passes) {
  const { width, height } = map;
  let caches = 0;

  for (const p of passes) {
    if (p.x < 10 || p.y < 10 || p.x >= width - 10 || p.y >= height - 10) continue;
    // A pass inside somebody's base is a back door, not a chokepoint.
    if (nearAny(map.starts, p.x, p.y, 20)) continue;
    if (nearAny(map.chokepoints, p.x, p.y, 14)) continue;
    // A gap the river runs through is a gorge. Widening it makes a wider
    // riverbank, garrisoning it puts blockhouses on the wrong side of the
    // water from each other, and routing a road through it paves up to the
    // channel and stops. The map already has a name for the places you can
    // get over the river and this is not one of them.
    if (wetWithin(map, p.x, p.y, 4)) continue;

    const major = rng.chance(0.45);
    if (major) {
      // Widen to about seven cells and skirt it in scree, so the shape of the
      // gap survives the blobs that were painted over it.
      for (let dy = -3; dy <= 3; dy++) {
        for (let dx = -3; dx <= 3; dx++) {
          const d = len(dx, dy);
          if (d > 3.2) continue;
          if (d > 2.2) paintMirroredIf(map, p.x + dx, p.y + dy, TERRAIN.ROUGH, TERRAIN.CLIFF);
          else paintMirroredIf(map, p.x + dx, p.y + dy, TERRAIN.GROUND, TERRAIN.CLIFF);
        }
      }
    }

    // At most two cached passes a map, and only major ones. Scrap at every
    // chokepoint is an economy, not a decision.
    const cache = major && caches < 2 && rng.chance(0.7);
    if (cache) caches++;

    const kind = major ? 'pass' : 'gap';
    map.chokepoints.push({ kind, x: p.x, y: p.y, primary: true, cache });
    map.chokepoints.push({
      kind,
      x: width - 1 - p.x,
      y: height - 1 - p.y,
      primary: false,
      cache,
    });
  }
}

/**
 * Put something at the chokepoints.
 *
 * The map already routes its roads through them and puts scrap in some of
 * them, but neither of those is visible from a hundred cells away. Two
 * blockhouses either side of the gap are: they say *somebody held this*, which
 * is the only sentence a piece of scenery needs to say for a player to
 * understand why they are about to fight there.
 *
 * The fuel on a bridgehead is deliberate cruelty. A bridge is the one place on
 * the map where both sides have to come to the same twelve cells, and a fuel
 * station on the approach is the difference between a firefight and a
 * catastrophe. Only some bridges get one; a rule is a habit, and a habit is
 * not a decision.
 *
 * The ford gets nothing, on purpose. Nobody built it — it is where the river
 * happens to be shallow — and a crossing with no cover on it is a different
 * proposition from one with blockhouses at both ends. That difference is the
 * whole reason the map has two kinds of crossing.
 */
function garrisonChokepoints(map, rng) {
  for (const c of map.chokepoints) {
    if (!c.primary || c.kind !== 'pass') continue;
    addPropPairNear(map, 'bunker', c.x - 5, c.y - 1);
    addPropPairNear(map, 'bunker', c.x + 3, c.y + 1);
    if (rng.chance(0.5)) addPropPairNear(map, 'mast', c.x - 1, c.y - 5);
    if (rng.chance(0.4)) addPropPairNear(map, 'bus', c.x + 1, c.y + 4);
  }

  for (const c of map.crossings) {
    if (c.kind !== 'bridge') continue;
    // Off the ends of the deck, on whichever bank has ground for them.
    const along = c.horizontal ? 'x' : 'y';
    const across = c.horizontal ? 'y' : 'x';
    for (const end of [-1, 1]) {
      const at = { x: c.x, y: c.y };
      at[across] += (end * (c.horizontal ? c.y1 - c.y0 : c.x1 - c.x0)) / 2 + end * 3;
      at[along] += 2;
      addPropPairNear(map, 'bunker', Math.round(at.x), Math.round(at.y));
    }
    if (rng.chance(0.45)) {
      addPropPairNear(map, 'gasstation', c.x - 4, c.y + (c.horizontal ? 4 : 1));
    }
  }
}

/**
 * Place a prop pair at an anchor, or as near to it as will take one.
 *
 * `addPropPair` refuses anything that does not fit and says nothing, which is
 * right for scattered scenery and wrong here: a bridgehead is a *composition*,
 * and one of its two blockhouses landing on the cliff at the end of the deck
 * meant half the bridges on the map had a garrison on one side only. Nothing
 * failed; it just looked like nobody had bothered.
 *
 * The search is a deterministic spiral, not a roll, so a crowded anchor does
 * not consume rng that an empty one would leave alone.
 */
function addPropPairNear(map, defId, cx, cy, spread = 3) {
  const before = map.props.length;
  addPropPair(map, defId, cx, cy);
  if (map.props.length > before) return;
  for (let r = 1; r <= spread; r++) {
    for (let a = 0; a < 8; a++) {
      const off = ringOffset(a + 1, r);
      addPropPair(map, defId, cx + Math.round(off.x), cy + Math.round(off.y));
      if (map.props.length > before) return;
    }
  }
}

/**
 * A long wall of cliff with passes cut through it.
 *
 * Walks a mostly-straight line with a wandering thickness, and punches a gap
 * every so often. The gaps are the point: a solid ridge partitions the map
 * and a ridge with three passes in it is a map where holding a pass is worth
 * something. Written mirrored, so the pass on your side is the pass on theirs.
 *
 * The gaps are recorded as they are cut. Rediscovering them afterwards would
 * mean looking for holes in a wall that the blob pass has already weathered
 * and the river may have cut through, and a pass found that way is wherever
 * the erosion happened to leave one rather than where the ridge was designed
 * to have one.
 */
function carveRidge(map, rng, passes) {
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
      passes.push({
        x: horizontal ? from + s + 2 : drift + 1,
        y: horizontal ? drift + 1 : from + s + 2,
      });
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
/**
 * A wreck field, moved off the water first.
 *
 * `stampField` flattens impassable terrain so scrap is never stranded on a
 * cliff, and that rule quietly became a hole-punch the moment there was a
 * river: a field whose ragged edge reached the channel filled it in. The
 * centre field did it on every seed, because a 180°-symmetric watercourse has
 * to pass through the centre of the map and that is exactly where the richest
 * field is anchored.
 *
 * The nudge is a deterministic spiral rather than a roll — a field that
 * consumed rng only on maps with rivers would make every downstream decision
 * depend on the weather. Where the spiral finds nowhere dry the field is
 * stamped anyway: an unreachable start is a worse map than a breached river,
 * and `noteRiverBreaches` will notice and call the hole a causeway.
 */
function addDryFieldPair(map, cx, cy, r, amountPerCell, rng) {
  const dry = map.river ? driestNear(map, cx, cy, r) : { x: cx, y: cy };
  addFieldPair(map, dry.x, dry.y, r, amountPerCell, rng);
}

/** Spiral out for an anchor whose field would not touch water. */
function driestNear(map, cx, cy, r) {
  if (!wetWithin(map, cx, cy, r + 1)) return { x: cx, y: cy };
  for (let d = 3; d <= 21; d += 3) {
    for (let a = 0; a < 8; a++) {
      const off = ringOffset(a + 1, d);
      const x = Math.round(cx + off.x);
      const y = Math.round(cy + off.y);
      if (x < r + 2 || y < r + 2) continue;
      if (x >= map.width - r - 2 || y >= map.height - r - 2) continue;
      if (nearAny(map.starts, x, y, 10)) continue;
      if (!wetWithin(map, x, y, r + 1)) return { x, y };
    }
  }
  return { x: cx, y: cy };
}

function wetWithin(map, cx, cy, r) {
  for (let y = cy - r; y <= cy + r; y++) {
    for (let x = cx - r; x <= cx + r; x++) {
      if (!inBounds(map, x, y)) continue;
      if (map.terrain[y * map.width + x] === TERRAIN.WATER) return true;
    }
  }
  return false;
}

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
    // Never into the channel, and this is a hard rule rather than a
    // preference. Flattening below is what stops scrap being stranded on a
    // cliff, and it does not care what it is flattening: a field whose ragged
    // edge reached the river drained a two-cell notch through it and handed
    // the map a free crossing nobody could see. `addDryFieldPair` moves the
    // anchors that can be moved; this catches the ones that cannot — the
    // quarry's pit field is anchored to the pit and has nowhere else to go.
    if (inChannel(map, x, y)) continue;
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
