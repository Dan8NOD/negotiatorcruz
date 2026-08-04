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

import { TERRAIN, TERRAIN_INFO, PROPS } from './content.js';
import { createRng } from './rng.js';
import { len, ringOffset } from './numeric.js';

/* ------------------------------------------------------------------ map -- */

export function createMap(seed, { width = 72, height = 72 } = {}) {
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

  // Scenery last: it reads the finished terrain and the wreck fields so it can
  // refuse to stand on either.
  addNeighbourhood(map, Math.round(width * 0.3), Math.round(height * 0.44), rng);
  addNeighbourhood(map, Math.round(width * 0.62), Math.round(height * 0.24), rng);
  addLandmarks(map, rng);

  return map;
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
    const x = horizontal ? cx + i : cx;
    const y = horizontal ? cy : cy + i;
    road.push({ x, y });
    // The street itself is kept clear so the block is walkable, not a wall.
    if (inBounds(map, x, y) && map.terrain[y * map.width + x] === TERRAIN.ROUGH) {
      paintMirrored(map, x, y, TERRAIN.GROUND);
    }
  }

  // Houses face the street from both sides, with gaps for driveways.
  for (const cell of road) {
    for (const side of [-2, 2]) {
      if (rng.chance(0.28)) continue;
      const x = horizontal ? cell.x : cell.x + side;
      const y = horizontal ? cell.y + side : cell.y;
      addPropPair(map, rng.chance(0.18) ? 'tree' : 'house', x, y);
    }
  }

  // Street trees in the verge.
  for (const cell of road) {
    if (!rng.chance(0.3)) continue;
    const side = rng.chance(0.5) ? -1 : 1;
    const x = horizontal ? cell.x : cell.x + side;
    const y = horizontal ? cell.y + side : cell.y;
    addPropPair(map, 'tree', x, y);
  }

  // The corner station.
  const end = road[road.length - 1];
  addPropPair(map, 'gasstation', horizontal ? end.x + 1 : end.x - 2, horizontal ? end.y + 2 : end.y + 1);
}

/**
 * Everything that is not suburbia: a tower cluster downtown, industrial fuel
 * tanks, a monument, and old growth scattered over the rough ground.
 */
function addLandmarks(map, rng) {
  const { width, height } = map;

  // Two tower blocks toward the middle — tall cover on the contested ground.
  for (let i = 0; i < 3; i++) {
    const x = Math.round(width * 0.36) + rng.int(6) - 3;
    const y = Math.round(height * 0.3) + rng.int(8) - 4;
    addPropPair(map, 'tower', x, y);
  }

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

  // A tank farm: several volatile props close enough to chain.
  const fx = Math.round(width * 0.22);
  const fy = Math.round(height * 0.68);
  for (let i = 0; i < 4; i++) {
    addPropPair(map, 'tank', fx + (i % 2) * 2, fy + Math.floor(i / 2) * 2);
  }

  // Old growth, thickest on rough ground where it reads as untended.
  const trees = Math.round((width * height) / 260);
  for (let i = 0; i < trees; i++) {
    addPropPair(map, 'tree', rng.int(width), rng.int(height));
  }
}


/**
 * Random-walk blobs of cliff and rough, mirrored as they are written so the
 * two halves stay identical without a second pass.
 */
function carveTerrain(map, rng) {
  const { width, height } = map;
  const blobs = Math.round((width * height) / 220);

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

function paintMirrored(map, x, y, kind) {
  const { width, height } = map;
  if (x < 0 || y < 0 || x >= width || y >= height) return;
  map.terrain[y * width + x] = kind;
  map.terrain[(height - 1 - y) * width + (width - 1 - x)] = kind;
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

const SQRT2 = Math.SQRT2;

/** Octile distance — the admissible heuristic for 8-way movement. */
function heuristic(ax, ay, bx, by) {
  const dx = Math.abs(ax - bx);
  const dy = Math.abs(ay - by);
  return dx + dy + (SQRT2 - 2) * Math.min(dx, dy);
}

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
export function findPath(map, sx, sy, gx, gy, { goalRadius = 0, maxNodes = 9000 } = {}) {
  sx |= 0;
  sy |= 0;
  gx |= 0;
  gy |= 0;
  if (!inBounds(map, sx, sy) || !inBounds(map, gx, gy)) return null;
  if (sx === gx && sy === gy) return [];

  const w = map.width;
  const size = w * map.height;
  const cameFrom = new Int32Array(size).fill(-1);
  const gScore = new Float32Array(size).fill(Infinity);
  const closed = new Uint8Array(size);
  const open = new MinHeap();

  const startIdx = sy * w + sx;
  gScore[startIdx] = 0;
  open.push(startIdx, heuristic(sx, sy, gx, gy));

  const reached = (x, y) =>
    goalRadius <= 0 ? x === gx && y === gy : len(x - gx, y - gy) <= goalRadius;

  let expanded = 0;
  let best = -1;
  let bestH = Infinity;

  while (open.size > 0) {
    const current = open.pop();
    if (closed[current]) continue;
    closed[current] = 1;

    const cx = current % w;
    const cy = (current / w) | 0;

    const h = heuristic(cx, cy, gx, gy);
    if (h < bestH) {
      bestH = h;
      best = current;
    }

    if (reached(cx, cy)) return reconstruct(cameFrom, current, w);
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
        if (closed[ni]) continue;
        const step = (dx !== 0 && dy !== 0 ? SQRT2 : 1) * cost;
        const tentative = gScore[current] + step;
        if (tentative >= gScore[ni]) continue;

        cameFrom[ni] = current;
        gScore[ni] = tentative;
        open.push(ni, tentative + heuristic(nx, ny, gx, gy));
      }
    }
  }

  // Unreachable goal: walk as close as the search got rather than refusing the
  // order outright. Players read a refused move order as the game ignoring them.
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
