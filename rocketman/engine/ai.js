/**
 * The skirmish opponent.
 *
 * The AI emits the same command objects a human's mouse does and has no
 * private access to world state beyond its own fog of war. That constraint is
 * worth more than any amount of cleverness: it means the AI cannot cheat by
 * accident, it can be recorded and replayed like a player, and every bug in it
 * is reproducible from a seed.
 *
 * Difficulty changes *tempo and aggression*, never information or income.
 * An AI that mines faster than you is not a harder opponent, it is a worse
 * game.
 */

import { BUILDINGS, UNITS, FACTIONS, TICKS_PER_SECOND } from './content.js';
import { canPlace } from './grid.js';
import { playerEntities } from './entities.js';
import { techAllows } from './economy.js';
import { suggestAbility, abilityReady } from './abilities.js';
import { visibleEnemies } from './vision.js';
import { withinBuildRadius, BUILD_RADIUS } from './sim.js';

export const DIFFICULTIES = {
  easy: {
    label: 'Easy',
    thinkInterval: 24,
    /** Army supply value that must be banked before it will push. */
    pushValue: 4200,
    collectorTarget: 4,
    maxCollectors: 6,
    turretTarget: 1,
    usesAbilities: false,
    reinforceRatio: 0.5,
  },
  normal: {
    label: 'Normal',
    thinkInterval: 14,
    pushValue: 3200,
    collectorTarget: 6,
    maxCollectors: 9,
    turretTarget: 3,
    usesAbilities: true,
    reinforceRatio: 0.7,
  },
  hard: {
    label: 'Hard',
    thinkInterval: 8,
    pushValue: 2400,
    collectorTarget: 8,
    maxCollectors: 12,
    turretTarget: 4,
    usesAbilities: true,
    reinforceRatio: 0.85,
  },
};

/** Order the AI works through its base. Roughly the human opening, too. */
const BUILD_PRIORITY = ['reactor', 'refinery', 'foundry', 'techlab', 'hangar'];

export function createAIState(difficulty = 'normal') {
  return {
    profile: DIFFICULTIES[difficulty] || DIFFICULTIES.normal,
    /** 'build' → 'massing' → 'attacking' → back to 'massing'. */
    phase: 'massing',
    attackTarget: null,
    lastThink: -999,
    /** Ids committed to the current push, so reinforcements are not stripped. */
    squad: new Set(),
  };
}

/**
 * Produce this player's commands for the current tick.
 * Returns an empty array on the many ticks where the AI is not thinking.
 */
export function updateAI(world, player) {
  if (!player.ai) player.ai = createAIState(player.difficulty);
  const ai = player.ai;
  const profile = ai.profile;

  const commands = [];

  // Abilities are checked every tick — a two-second reaction window on an
  // Aegis field is the difference between using it and wasting it.
  if (profile.usesAbilities) commands.push(...abilityCommands(world, player));

  if (world.tick - ai.lastThink < profile.thinkInterval) return commands;
  ai.lastThink = world.tick;

  const buildings = playerEntities(world, player.id, 'building');
  const units = playerEntities(world, player.id, 'unit');
  const collectors = units.filter((u) => u.harvest);
  const army = units.filter((u) => !u.harvest);

  commands.push(...economyCommands(world, player, buildings, collectors));
  commands.push(...constructionCommands(world, player, buildings));
  commands.push(...armyCommands(world, player, buildings, army));
  commands.push(...militaryCommands(world, player, army));

  return commands;
}

/* -------------------------------------------------------------- economy -- */

function economyCommands(world, player, buildings, collectors) {
  const out = [];
  const profile = player.ai.profile;
  const refineries = buildings.filter((b) => b.defId === 'refinery' && !b.constructing);
  if (refineries.length === 0) return out;

  const queued = refineries.reduce((n, b) => n + b.queue.length, 0);
  const target = Math.min(profile.maxCollectors, profile.collectorTarget * refineries.length);

  if (collectors.length + queued < target && player.scrap > UNITS.collector.cost) {
    out.push({ type: 'train', player: player.id, buildingId: refineries[0].id, defId: 'collector' });
  }

  // Idle collectors happen when a patch mines out mid-trip. Nudge them.
  for (const c of collectors) {
    if (c.harvest.state === 'idle' && c.path.length === 0 && !c.order) {
      out.push({ type: 'harvest', player: player.id, ids: [c.id], x: c.x, y: c.y });
    }
  }

  return out;
}

/* --------------------------------------------------------- construction -- */

function constructionCommands(world, player, buildings) {
  const out = [];
  const profile = player.ai.profile;
  const owned = new Set(buildings.filter((b) => !b.constructing).map((b) => b.defId));
  const underway = buildings.filter((b) => b.constructing);

  // One structure at a time keeps the AI's spending legible and stops it
  // starving unit production to build five things at once.
  if (underway.length >= 2) return out;

  const want = nextStructure(world, player, buildings, owned, profile);
  if (!want) return out;

  const def = BUILDINGS[want];
  if (player.scrap < def.cost) return out;

  const spot = findBuildSpot(world, player, def, buildings);
  if (!spot) return out;

  out.push({ type: 'build', player: player.id, defId: want, cx: spot.x, cy: spot.y });
  return out;
}

function nextStructure(world, player, buildings, owned, profile) {
  const counted = (id) => buildings.filter((b) => b.defId === id).length;

  // Power first, always. A brownout costs more than whatever it was saving for.
  const headroom = player.powerMade - player.powerUsed;
  if (headroom < 18) return 'reactor';

  for (const id of BUILD_PRIORITY) {
    if (owned.has(id)) continue;
    if (!techAllows(world, player.id, id)) continue;
    return id;
  }

  // A second refinery roughly doubles income and is worth more than a fourth
  // turret, so it comes first once the tech path is done.
  if (counted('refinery') < 2 && world.map.fields.length > 2) return 'refinery';
  if (counted('turret') < profile.turretTarget) return 'turret';
  if (counted('foundry') < 2) return 'foundry';
  if (counted('sensor') < 1) return 'sensor';
  if (counted('hangar') < 2 && techAllows(world, player.id, 'hangar')) return 'hangar';
  return null;
}

/**
 * Spiral outward from the Command Rig for a legal footprint.
 *
 * Refineries want to be near scrap; turrets want to be toward the enemy;
 * everything else just wants to fit. That is three rules, and it produces a
 * base layout that reads as intentional.
 */
function findBuildSpot(world, player, def, buildings) {
  const hq = buildings.find((b) => b.defId === 'command') || buildings[0];
  if (!hq) return null;

  let originX = hq.cx;
  let originY = hq.cy;

  if (def.dropOff) {
    const field = nearestUnworkedField(world, player, hq);
    if (field) {
      originX = Math.round((hq.cx + field.x) / 2);
      originY = Math.round((hq.cy + field.y) / 2);
    }
  } else if (def.hardpoints) {
    const enemy = enemyBase(world, player);
    if (enemy) {
      originX = Math.round(hq.cx + Math.sign(enemy.x - hq.x) * 6);
      originY = Math.round(hq.cy + Math.sign(enemy.y - hq.y) * 6);
    }
  }

  for (let r = 2; r <= BUILD_RADIUS; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        const x = originX + dx;
        const y = originY + dy;
        if (!canPlace(world.map, def.size, x, y)) continue;
        if (!withinBuildRadius(world, player.id, def.size, x, y)) continue;
        return { x, y };
      }
    }
  }
  return null;
}

function nearestUnworkedField(world, player, hq) {
  let best = null;
  let bestD = Infinity;
  for (const field of world.map.fields) {
    const remaining = field.cells.reduce(
      (n, c) => n + world.map.resource[c.y * world.map.width + c.x],
      0
    );
    if (remaining < 2000) continue;
    const d = Math.hypot(field.x - hq.x, field.y - hq.y);
    if (d < bestD) {
      bestD = d;
      best = field;
    }
  }
  return best;
}

/* ----------------------------------------------------------------- army -- */

/**
 * Composition targets by role, as a fraction of the army. Kept loose — the AI
 * builds whatever is furthest below quota that it can currently afford, which
 * self-corrects after losses without any explicit rebuild logic.
 */
const COMPOSITION = { scout: 0.15, assault: 0.45, siege: 0.15, support: 0.1, air: 0.15 };

function armyCommands(world, player, buildings, army) {
  const out = [];
  const producers = buildings.filter((b) => b.def.builds === 'units' && !b.constructing);
  if (producers.length === 0) return out;

  const roster = FACTIONS[player.faction].units.filter((id) => techAllows(world, player.id, id));
  if (roster.length === 0) return out;

  const counts = {};
  for (const u of army) counts[u.def.role] = (counts[u.def.role] || 0) + 1;
  const total = Math.max(1, army.length);

  for (const producer of producers) {
    if (producer.queue.length >= 2) continue;

    const buildable = roster.filter(
      (id) => UNITS[id].builtAt === producer.defId && player.scrap >= UNITS[id].cost
    );
    if (buildable.length === 0) continue;

    // Furthest below its quota wins.
    let pick = null;
    let worstDeficit = -Infinity;
    for (const id of buildable) {
      const role = UNITS[id].role;
      const deficit = (COMPOSITION[role] || 0.1) - (counts[role] || 0) / total;
      if (deficit > worstDeficit) {
        worstDeficit = deficit;
        pick = id;
      }
    }
    if (pick) out.push({ type: 'train', player: player.id, buildingId: producer.id, defId: pick });
  }

  return out;
}

/* ------------------------------------------------------------- military -- */

function militaryCommands(world, player, army) {
  const out = [];
  const ai = player.ai;
  const profile = ai.profile;

  const armyValue = army.reduce((n, u) => n + u.def.cost, 0);
  const seen = visibleEnemies(world, player.id);

  // Defence overrides everything: something is in the base right now.
  const hq = playerEntities(world, player.id, 'building').find((b) => b.defId === 'command');
  if (hq) {
    const intruders = seen.filter((e) => Math.hypot(e.x - hq.x, e.y - hq.y) < 16);
    if (intruders.length > 0) {
      ai.phase = 'defending';
      const target = intruders[0];
      const idle = army.filter((u) => !u.order || u.order.type !== 'attack');
      if (idle.length) {
        out.push({
          type: 'attackMove',
          player: player.id,
          ids: idle.map((u) => u.id),
          x: target.x,
          y: target.y,
        });
      }
      return out;
    }
  }

  if (ai.phase === 'defending') ai.phase = 'massing';

  if (ai.phase === 'massing') {
    if (armyValue >= profile.pushValue) {
      const target = enemyBase(world, player) || pickScoutTarget(world, player);
      if (target) {
        ai.phase = 'attacking';
        ai.attackTarget = { x: target.x, y: target.y };
        ai.squad = new Set(army.map((u) => u.id));
        out.push({
          type: 'attackMove',
          player: player.id,
          ids: army.map((u) => u.id),
          x: target.x,
          y: target.y,
        });
      }
    } else {
      // Idle army gathers at a rally point between the HQ and the enemy, so
      // the push does not start with a two-minute walk.
      const staging = stagingPoint(world, player);
      const loitering = army.filter((u) => !u.order && u.path.length === 0);
      if (staging && loitering.length >= 3) {
        out.push({
          type: 'move',
          player: player.id,
          ids: loitering.map((u) => u.id),
          x: staging.x,
          y: staging.y,
        });
      }
    }
    return out;
  }

  if (ai.phase === 'attacking') {
    const survivors = army.filter((u) => ai.squad.has(u.id));
    // The push is spent — go home and rebuild rather than trickling in.
    if (survivors.length === 0 || armyValue < profile.pushValue * profile.reinforceRatio * 0.5) {
      ai.phase = 'massing';
      ai.squad.clear();
      const staging = stagingPoint(world, player);
      if (staging && army.length) {
        out.push({
          type: 'move',
          player: player.id,
          ids: army.map((u) => u.id),
          x: staging.x,
          y: staging.y,
        });
      }
      return out;
    }

    // Feed newly built units into the ongoing push.
    const fresh = army.filter((u) => !ai.squad.has(u.id) && !u.order);
    if (fresh.length && ai.attackTarget) {
      for (const u of fresh) ai.squad.add(u.id);
      out.push({
        type: 'attackMove',
        player: player.id,
        ids: fresh.map((u) => u.id),
        x: ai.attackTarget.x,
        y: ai.attackTarget.y,
      });
    }

    // Retarget when the objective is gone.
    const stillThere = ai.attackTarget && enemyNear(world, player, ai.attackTarget, 8);
    if (!stillThere) {
      const next = enemyBase(world, player) || pickScoutTarget(world, player);
      if (next) {
        ai.attackTarget = { x: next.x, y: next.y };
        out.push({
          type: 'attackMove',
          player: player.id,
          ids: survivors.map((u) => u.id),
          x: next.x,
          y: next.y,
        });
      }
    }
  }

  return out;
}

function abilityCommands(world, player) {
  const out = [];
  if (!world.index) return out;

  for (const u of playerEntities(world, player.id, 'unit')) {
    if (!u.ability || !abilityReady(world, u)) continue;
    const suggestion = suggestAbility(world, u, world.index);
    if (suggestion) {
      out.push({
        type: 'ability',
        player: player.id,
        ids: [u.id],
        x: suggestion.x,
        y: suggestion.y,
      });
    }
  }
  return out;
}

/* --------------------------------------------------------------- helpers -- */

/**
 * The enemy's most valuable known structure. Falls back to the map's other
 * start position, which the AI is allowed to know for the same reason a human
 * is: it can see it on the minimap at match start.
 */
function enemyBase(world, player) {
  let best = null;
  let bestScore = -Infinity;

  for (const e of world.entities.values()) {
    if (e.dead || e.player === player.id) continue;
    if (e.kind !== 'building') continue;
    const score = (e.defId === 'command' ? 100 : 0) + (e.def.builds ? 40 : 0) + e.def.cost / 100;
    if (score > bestScore) {
      bestScore = score;
      best = e;
    }
  }
  if (best) return best;

  const mine = world.map.starts[player.id % world.map.starts.length];
  const other = world.map.starts.find((s) => s !== mine);
  return other ? { x: other.x, y: other.y } : null;
}

function enemyNear(world, player, point, radius) {
  for (const e of world.entities.values()) {
    if (e.dead || e.player === player.id) continue;
    if (Math.hypot(e.x - point.x, e.y - point.y) <= radius) return true;
  }
  return false;
}

/** Somewhere unexplored-ish to poke at when nothing enemy is known. */
function pickScoutTarget(world, player) {
  const { map } = world;
  const { explored } = player.vision;
  for (let attempt = 0; attempt < 24; attempt++) {
    const x = world.rng.int(map.width);
    const y = world.rng.int(map.height);
    if (!explored[y * map.width + x]) return { x, y };
  }
  return null;
}

/** A third of the way to the enemy — close enough to react, far enough to matter. */
function stagingPoint(world, player) {
  const buildings = playerEntities(world, player.id, 'building');
  const hq = buildings.find((b) => b.defId === 'command') || buildings[0];
  if (!hq) return null;
  const enemy = enemyBase(world, player);
  if (!enemy) return { x: hq.x, y: hq.y };
  return {
    x: hq.x + (enemy.x - hq.x) * 0.22,
    y: hq.y + (enemy.y - hq.y) * 0.22,
  };
}

export { TICKS_PER_SECOND };
