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
    if (e.kind === 'building') vacate(world.map, e.size, e.cx, e.cy);
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
