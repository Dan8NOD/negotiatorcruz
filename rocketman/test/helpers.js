/**
 * Shared test scaffolding.
 *
 * These helpers exist so the suites assert on *behaviour* rather than each
 * re-deriving how to stand a world up, and so a determinism check has one
 * agreed definition of "the same world".
 */

import { createWorld, tick } from '../engine/sim.js';
import { updateAI } from '../engine/ai.js';

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
