/**
 * Shared test scaffolding.
 *
 * These helpers exist so the suites assert on *behaviour* rather than each
 * re-deriving how to stand a world up, and so a determinism check has one
 * agreed definition of "the same world".
 */

import { createWorld, tick } from '../engine/sim.js';
import { updateAI } from '../engine/ai.js';
import { vacate } from '../engine/grid.js';
import { spawnBuilding } from '../engine/entities.js';
import { TERRAIN } from '../engine/content.js';

/** A two-player world with nothing running yet. */
export function makeWorld(overrides = {}) {
  return createWorld({
    seed: 1234,
    players: [{ faction: 'ascendancy' }, { faction: 'bulwark' }],
    ...overrides,
  });
}

/** An empty-ish world: no starting units, for isolated combat/movement tests. */
export function makeBareWorld(overrides = {}) {
  const world = makeWorld(overrides);
  for (const [id, e] of world.entities) {
    if (e.kind === 'unit') world.entities.delete(id);
  }
  return world;
}

/**
 * A genuinely empty world — no units *and* no structures.
 *
 * Objective tests need this: `makeBareWorld` leaves both Command Rigs
 * standing, so "destroy every enemy structure" can never complete and
 * "protect the base" can never fail, and the tests silently assert nothing.
 * Footprints are released so later placements in the same test are legal.
 */
export function makeEmptyWorld(overrides = {}) {
  const world = makeWorld(overrides);
  for (const [id, e] of world.entities) {
    // Props claim cells exactly as buildings do — the engine's own
    // `killEntity` releases both — so deleting one without vacating leaves a
    // cell nothing occupies and nothing can enter. That was invisible while
    // maps carried a hundred props and the tests looked elsewhere; on a
    // doubled map with four hundred it is a minefield of dead cells.
    if (e.kind === 'building' || e.kind === 'prop') vacate(world.map, e.size, e.cx, e.cy);
    world.entities.delete(id);
  }
  return world;
}

/**
 * An empty world that will still *run*.
 *
 * `checkVictory` ends a match the instant a player owns nothing, and a
 * finished world ignores every subsequent tick. A test that empties the world
 * and then runs a few hundred ticks to watch something charge, repair or
 * regrow therefore measures exactly one tick and silently passes or fails for
 * the wrong reason. Giving each player a Command Rig in its own corner keeps
 * the clock running without putting anything near the middle of the map.
 */
export function makeArena(overrides = {}) {
  const world = makeEmptyWorld(overrides);
  const [a, b] = world.map.starts;
  spawnBuilding(world, 'command', 0, a.x - 1, a.y - 1, { complete: true });
  spawnBuilding(world, 'command', 1, b.x - 1, b.y - 1, { complete: true });
  return world;
}

/**
 * Flatten a rectangle to bare, empty ground.
 *
 * A test that asserts something about walkability needs to *know* the cells
 * it is using are walkable. Picking a cell in the middle of a generated map
 * and hoping is how "a prop blocks its cell" came to depend on seed 1234
 * happening to put open ground at (30, 30) — which stopped being true the
 * moment the maps changed size, in a test that has nothing to do with either.
 *
 * Deliberately does not touch `occupied` outside the rectangle, so the
 * Command Rigs in their corners keep the match running.
 */
export function clearGround(world, x0, y0, x1, y1) {
  const { map } = world;
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      if (x < 1 || y < 1 || x >= map.width - 1 || y >= map.height - 1) continue;
      const i = y * map.width + x;
      map.terrain[i] = TERRAIN.GROUND;
      map.resource[i] = 0;
      map.resourceMax[i] = 0;
      map.occupied[i] = 0;
    }
  }
  return world;
}

export function run(world, ticks, commandsFor = null) {
  for (let i = 0; i < ticks; i++) {
    const commands = commandsFor ? commandsFor(world) : [];
    tick(world, commands);
  }
  return world;
}

/** Drive both AI players for `ticks`, the way the real match loop does. */
export function runAI(world, ticks) {
  return run(world, ticks, (w) => {
    const commands = [];
    for (const p of w.players) {
      if (p.isAI && !p.defeated) commands.push(...updateAI(w, p));
    }
    return commands;
  });
}

/**
 * A cheap fingerprint of everything a desync would show up in. Deliberately
 * includes float positions — if two runs diverge at all, this catches it.
 */
export function hashWorld(world) {
  const parts = [world.tick, world.rng.state(), world.projectiles.length];
  for (const p of world.players) {
    parts.push(Math.round(p.scrap), p.powerMade, p.powerUsed, p.stats.killed, p.stats.lost);
  }
  const ids = [...world.entities.keys()].sort((a, b) => a - b);
  for (const id of ids) {
    const e = world.entities.get(id);
    parts.push(id, e.defId, e.x.toFixed(4), e.y.toFixed(4), e.hp.toFixed(3), (e.shield || 0).toFixed(3));
  }
  return parts.join('|');
}

/** Find the first entity matching a predicate. */
export function findEntity(world, predicate) {
  for (const e of world.entities.values()) if (predicate(e)) return e;
  return null;
}

export function countOf(world, defId, playerId = null) {
  let n = 0;
  for (const e of world.entities.values()) {
    if (e.dead || e.defId !== defId) continue;
    if (playerId !== null && e.player !== playerId) continue;
    n++;
  }
  return n;
}
