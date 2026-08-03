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

import { TERRAIN, TERRAIN_INFO } from './content.js';
import { createRng } from './rng.js';

/* ------------------------------------------------------------------ map -- */

export function createMap(seed, { width = 72, height = 72 } = {}) {
  const rng = createRng(seed ^ 0x9e3779b9);
  const map = {
    width,
    height,
    terrain: new Uint8Array(width * height),
    resource: new Uint16Array(width * height),
    /** Entity id occupying each cell, or 0. Structures only. */
    occupied: new Uint32Array(width * height),
    starts: [],
    /** Wreck fields, kept as metadata so collectors can find a whole patch. */
    fields: [],
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

  return map;
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
      const d = Math.hypot(x - cx, y - cy);
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
    goalRadius <= 0 ? x === gx && y === gy : Math.hypot(x - gx, y - gy) <= goalRadius;

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
