/**
 * Fog of war.
 *
 * Two bitmaps per player: `visible` is recomputed from scratch on a slow
 * cadence, `explored` only ever accumulates. Terrain you have seen stays
 * drawn but dimmed; units in unseen cells are simply not rendered and not
 * targetable, which is what makes a Sensor Mast worth 350 scrap.
 *
 * Vision is circular rather than line-of-sight traced. Shadow-casting looks
 * better on a cliff map but costs more than it earns at this scale, and "my
 * mech can see over that rock" has never lost anyone a game.
 *
 * That stays true now that *shooting* traces a line (see `traceShot`), and the
 * split is deliberate rather than an omission. Seeing something you cannot
 * shoot is ordinary and readable — every RTS does it — whereas fog that
 * flickers as units shuffle round a rock is the expensive half and the one
 * nobody enjoys. The two answer different questions and only one of them has
 * to be exact.
 *
 * The one thing terrain does buy here is height: a machine on the lip of a
 * cliff sees further, which is the other half of what makes taking the high
 * ground worth the walk.
 */

import { isCombatant, isElevated, ELEVATION } from './entities.js';

/** Recompute cadence. Four ticks is 200ms — imperceptible, and 4× cheaper. */
export const VISION_INTERVAL = 4;

const stampCache = new Map();

/** Cell offsets forming a filled disc of the given radius. */
function discOffsets(radius) {
  const key = Math.round(radius * 4);
  const cached = stampCache.get(key);
  if (cached) return cached;

  const r = Math.ceil(radius);
  const offsets = [];
  for (let dy = -r; dy <= r; dy++) {
    for (let dx = -r; dx <= r; dx++) {
      if (dx * dx + dy * dy <= radius * radius) offsets.push(dx, dy);
    }
  }
  const packed = Int16Array.from(offsets);
  stampCache.set(key, packed);
  return packed;
}

export function createVision(map) {
  return {
    visible: new Uint8Array(map.width * map.height),
    explored: new Uint8Array(map.width * map.height),
  };
}

/**
 * Rebuild one player's visibility. Structures under construction still see —
 * a half-built Sensor Mast is a scout that cannot run away.
 */
export function updateVision(world, player) {
  const { map } = world;
  const { visible, explored } = player.vision;
  visible.fill(0);

  for (const e of world.entities.values()) {
    if (e.dead || e.player !== player.id) continue;
    // High ground, for everyone equally — the AI reads its enemies through
    // this same function and its own fog, so a ridge is worth exactly as much
    // to it as it is to the player, and no more.
    const sight =
      (e.def.sight || 4) + (e.layer !== 'air' && isElevated(map, e.x, e.y) ? ELEVATION.SIGHT : 0);
    const offsets = discOffsets(sight);
    const ox = Math.floor(e.x);
    const oy = Math.floor(e.y);

    for (let i = 0; i < offsets.length; i += 2) {
      const x = ox + offsets[i];
      const y = oy + offsets[i + 1];
      if (x < 0 || y < 0 || x >= map.width || y >= map.height) continue;
      const idx = y * map.width + x;
      visible[idx] = 1;
      explored[idx] = 1;
    }
  }
}

export function isVisible(world, playerId, x, y) {
  const map = world.map;
  const cx = Math.floor(x);
  const cy = Math.floor(y);
  if (cx < 0 || cy < 0 || cx >= map.width || cy >= map.height) return false;
  return world.players[playerId].vision.visible[cy * map.width + cx] === 1;
}

export function isExplored(world, playerId, x, y) {
  const map = world.map;
  const cx = Math.floor(x);
  const cy = Math.floor(y);
  if (cx < 0 || cy < 0 || cx >= map.width || cy >= map.height) return false;
  return world.players[playerId].vision.explored[cy * map.width + cx] === 1;
}

/**
 * Everything `playerId` can currently see that belongs to someone else.
 * The AI and the renderer both go through this, so neither can accidentally
 * read through the fog.
 */
export function visibleEnemies(world, playerId) {
  const out = [];
  for (const e of world.entities.values()) {
    if (e.dead || e.player === playerId || !isCombatant(e)) continue;
    if (isVisible(world, playerId, e.x, e.y)) out.push(e);
  }
  return out;
}
