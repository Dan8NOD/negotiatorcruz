/**
 * Mission objectives.
 *
 * An objective is a small tagged record evaluated against world state. Keeping
 * them declarative rather than scripted is what makes a mission a *data file*
 * — new missions are written in campaign.js without touching simulation code,
 * and every objective type is tested once instead of once per mission.
 *
 * Evaluation is pure and idempotent apart from latching: an objective that has
 * completed stays completed even if the condition later stops holding. Killing
 * the last Bulwark reactor wins you the mission; the enemy rebuilding one
 * afterwards must not un-win it.
 */

import { playerEntities } from './entities.js';
import { TICKS_PER_SECOND } from './content.js';
import { len } from './numeric.js';

/** How often objectives are re-checked. Five ticks is a quarter-second. */
export const OBJECTIVE_INTERVAL = 5;

/* --------------------------------------------------------------- kinds -- */

/**
 * Each kind reports `{ done, progress, total }`. `progress`/`total` drive the
 * tracker in the HUD, so an objective that cannot show progress returns 0/1
 * and renders as a plain checkbox.
 */
const KINDS = {
  /** Destroy everything a given player owns. */
  destroyAll(world, o) {
    const remaining = playerEntities(world, o.player).length;
    return { done: remaining === 0, progress: remaining === 0 ? 1 : 0, total: 1 };
  },

  /**
   * Destroy every structure a player owns — "break their base", not "hunt
   * every last scout across the map", which is the most tedious way an RTS
   * mission can end and never what the briefing actually asked for.
   */
  destroyStructures(world, o) {
    const remaining = playerEntities(world, o.player, 'building').filter(
      (b) => !o.defId || b.defId === o.defId
    ).length;
    // The enemy can build more than it started with, so the bar tracks the
    // high-water mark and progress is clamped to it rather than going backwards
    // or overshooting.
    if (o.startCount === undefined || remaining > o.startCount) o.startCount = remaining;
    const killed = Math.max(0, o.startCount - remaining);
    return {
      done: remaining === 0,
      progress: Math.min(killed, o.startCount),
      total: Math.max(1, o.startCount),
    };
  },

  /** Destroy a set number of a specific enemy unit or structure. */
  destroyCount(world, o) {
    const remaining = playerEntities(world, o.player).filter((e) => e.defId === o.defId).length;
    if (o.startCount === undefined) o.startCount = remaining;
    const killed = Math.max(0, o.startCount - remaining);
    const target = o.count || o.startCount || 1;
    return { done: killed >= target, progress: Math.min(killed, target), total: target };
  },

  /** Stay alive for a while. The tutorial's favourite. */
  survive(world, o) {
    const elapsed = world.tick - (world.missionStartTick || 0);
    return {
      done: elapsed >= o.ticks,
      progress: Math.min(elapsed, o.ticks),
      total: o.ticks,
      isTimer: true,
    };
  },

  /** Bank a total amount of scrap over the mission. */
  accumulate(world, o) {
    const mined = world.players[o.player ?? 0].scrapMined;
    return { done: mined >= o.amount, progress: Math.min(mined, o.amount), total: o.amount };
  },

  /** Own N completed structures of a type. Teaches the build menu. */
  build(world, o) {
    const built = playerEntities(world, o.player ?? 0, 'building').filter(
      (b) => b.defId === o.defId && !b.constructing
    ).length;
    return { done: built >= o.count, progress: Math.min(built, o.count), total: o.count };
  },

  /** Own N units of a type at once. */
  field(world, o) {
    const count = playerEntities(world, o.player ?? 0, 'unit').filter(
      (u) => u.defId === o.defId
    ).length;
    return { done: count >= o.count, progress: Math.min(count, o.count), total: o.count };
  },

  /**
   * Walk a machine into a gateway — the way off the map.
   *
   * Two steps, and the tracker counts both, because they are two different
   * jobs: knock the headquarters down and the shaft is *there*, but a shaft
   * nobody has walked into has not been taken. Reading the state off
   * `world.gateways` rather than re-deriving it keeps one answer to "is the
   * way open", shared by the objective, the HUD and the debrief.
   */
  enter(world, o) {
    const gateway = (world.gateways || []).find((g) => g.id === o.gateway);
    if (!gateway) return { done: false, progress: 0, total: 2 };
    return {
      done: gateway.entered,
      progress: (gateway.open ? 1 : 0) + (gateway.entered ? 1 : 0),
      total: 2,
    };
  },

  /** Get any unit within radius of a point. */
  reach(world, o) {
    const arrived = playerEntities(world, o.player ?? 0, 'unit').some(
      (u) => len(u.x - o.x, u.y - o.y) <= (o.radius || 3)
    );
    return { done: arrived, progress: arrived ? 1 : 0, total: 1 };
  },

  /**
   * Keep something alive. Inverted: this objective *fails* rather than
   * completes, and is what makes a mission losable for a reason other than
   * annihilation.
   */
  protect(world, o) {
    if (o.pilot) {
      const alive = [...world.entities.values()].some((e) => !e.dead && e.pilotId === o.pilot);
      return { done: false, failed: !alive, progress: alive ? 1 : 0, total: 1, standing: true };
    }
    const alive = playerEntities(world, o.player ?? 0, 'building').filter(
      (b) => !o.defId || b.defId === o.defId
    ).length;
    return {
      done: false,
      failed: alive < (o.atLeast === undefined ? 1 : o.atLeast),
      progress: alive,
      total: Math.max(1, o.atLeast === undefined ? 1 : o.atLeast),
      standing: true,
    };
  },
};

/* ---------------------------------------------------------- evaluation -- */

/** Normalise a mission's objective records into evaluable, latchable state. */
export function prepareObjectives(mission) {
  const build = (o, index, optional) => ({
    ...o,
    key: o.key || `${o.kind}-${optional ? 'b' : 'a'}${index}`,
    optional,
    complete: false,
    failed: false,
    progress: 0,
    total: 1,
  });

  return [
    ...(mission.objectives || []).map((o, i) => build(o, i, false)),
    ...(mission.bonusObjectives || []).map((o, i) => build(o, i, true)),
  ];
}

/**
 * Advance every objective one evaluation step.
 *
 * @returns {{changed: Array, won: boolean, lost: boolean}}
 */
export function evaluateObjectives(world, objectives) {
  const changed = [];

  for (const o of objectives) {
    if (o.complete || o.failed) continue;

    const kind = KINDS[o.kind];
    if (!kind) continue;
    const result = kind(world, o);

    o.progress = result.progress;
    o.total = result.total;
    o.isTimer = !!result.isTimer;
    o.standing = !!result.standing;

    if (result.failed) {
      o.failed = true;
      changed.push(o);
      continue;
    }
    if (result.done) {
      o.complete = true;
      changed.push(o);
    }
  }

  // `won` and `lost` both describe the current *state* rather than what changed
  // on this pass. Deriving `lost` from the transition instead would make a
  // second evaluation of an already-failed mission report "not lost", which is
  // true of nothing and a trap for every future caller.
  //
  // Objectives that can only ever fail (protect) are excluded from victory, or
  // a mission whose only other objective is "survive" would win instantly.
  const required = objectives.filter((o) => !o.optional && !o.standing);
  const won = required.length > 0 && required.every((o) => o.complete);
  const lost = objectives.some((o) => !o.optional && o.failed);

  return { changed, won, lost };
}

/** A short line for the HUD tracker. */
export function describeObjective(o) {
  if (o.text) return o.text;

  switch (o.kind) {
    case 'destroyAll':
      return 'Destroy all enemy forces';
    case 'destroyStructures':
      return 'Destroy every enemy structure';
    case 'destroyCount':
      return `Destroy ${o.count || 'the'} enemy ${o.defId}`;
    case 'survive':
      return `Hold for ${Math.round(o.ticks / TICKS_PER_SECOND)}s`;
    case 'accumulate':
      return `Mine ${o.amount.toLocaleString()} scrap`;
    case 'build':
      return `Build ${o.count} ${o.defId}`;
    case 'field':
      return `Field ${o.count} ${o.defId}`;
    case 'enter':
      return 'Find the way through and take it';
    case 'reach':
      return 'Reach the marker';
    case 'protect':
      return o.pilot ? 'Keep your pilot alive' : 'Protect your base';
    default:
      return o.kind;
  }
}

/** Progress as a display string, or null when a checkbox says it better. */
export function objectiveProgressText(o) {
  if (o.total <= 1) return null;
  if (o.isTimer) {
    const left = Math.max(0, Math.ceil((o.total - o.progress) / TICKS_PER_SECOND));
    return `${left}s`;
  }
  return `${Math.floor(o.progress).toLocaleString()} / ${Math.floor(o.total).toLocaleString()}`;
}
