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
import { playerEntities, defsFor, isCombatant } from './entities.js';
import { techAllows, superweaponReady } from './economy.js';
import { suggestAbility, abilityReady } from './abilities.js';
import { visibleEnemies } from './vision.js';
import { withinBuildRadius, BUILD_RADIUS } from './sim.js';
import { len } from './numeric.js';

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
  commands.push(...armyCommands(world, player, buildings, army, economyReserve(world, player, buildings, collectors)));
  commands.push(...militaryCommands(world, player, army));
  commands.push(...upkeepCommands(world, player, buildings));

  return commands;
}

/**
 * Repair what is worth repairing, and fire the superweapon when it is charged.
 *
 * Both are cheap to get wrong in the other direction: an AI that never repairs
 * bleeds its base away one raid at a time, and a charged superweapon that is
 * never fired is decoration.
 */
function upkeepCommands(world, player, buildings) {
  const out = [];

  // Repair below two-thirds hull, and only with scrap to spare — patching a
  // Sensor Mast while the Foundry queue starves is a bad trade.
  if (player.scrap > 1500) {
    const hurt = buildings.filter(
      (b) => !b.constructing && !b.repairing && b.hp < b.maxHp * 0.66
    );
    if (hurt.length) {
      out.push({ type: 'repair', player: player.id, ids: hurt.map((b) => b.id), on: true });
    }
  }

  for (const b of buildings) {
    if (!superweaponReady(b)) continue;
    const target = superweaponTarget(world, player);
    if (target) {
      out.push({
        type: 'superweapon',
        player: player.id,
        buildingId: b.id,
        x: target.x,
        y: target.y,
      });
    }
  }

  return out;
}

/**
 * Where to put a superweapon strike: the point covering the most enemy value
 * it can currently see. Falls back to their base, because a strike on a known
 * structure always beats holding the charge indefinitely.
 */
function superweaponTarget(world, player) {
  const seen = visibleEnemies(world, player.id);
  const radius = 5.5;

  let best = null;
  let bestValue = 0;
  for (const candidate of seen) {
    let value = 0;
    for (const other of seen) {
      if (len(other.x - candidate.x, other.y - candidate.y) > radius) continue;
      value += other.def.cost || 200;
    }
    if (value > bestValue) {
      bestValue = value;
      best = candidate;
    }
  }

  if (best && bestValue >= 1500) return { x: best.x, y: best.y };
  const base = enemyBase(world, player);
  return base ? { x: base.x, y: base.y } : null;
}

/**
 * Scrap the army is not allowed to touch.
 *
 * Without this the AI can lose its economy permanently: a Vireo costs 300 and
 * a Collector 450, so an AI hovering near zero can always afford another scout
 * and can never afford the harvester that would pay for it. It ends up with a
 * large army, an intact Refinery, and no income at all — which is exactly the
 * mistake a new human player makes, and not one an opponent should model.
 */
function economyReserve(world, player, buildings, collectors) {
  const profile = player.ai.profile;
  const refineries = buildings.filter((b) => b.defId === 'refinery' && !b.constructing);
  if (refineries.length === 0) return 0;

  const queued = refineries.reduce((n, b) => n + b.queue.length, 0);
  const target = Math.min(profile.maxCollectors, profile.collectorTarget * refineries.length);
  if (collectors.length + queued >= target) return 0;

  return defsFor(world, player.id).units.collector.cost;
}

/* -------------------------------------------------------------- economy -- */

function economyCommands(world, player, buildings, collectors) {
  const out = [];
  const profile = player.ai.profile;
  const refineries = buildings.filter((b) => b.defId === 'refinery' && !b.constructing);
  if (refineries.length === 0) return out;

  const queued = refineries.reduce((n, b) => n + b.queue.length, 0);
  const target = Math.min(profile.maxCollectors, profile.collectorTarget * refineries.length);

  if (collectors.length + queued < target && player.scrap > defsFor(world, player.id).units.collector.cost) {
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

  const def = defsFor(world, player.id).buildings[want];
  if (!def || player.scrap < def.cost) return out;

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
  // The Lance is a late-game luxury: only once the economy can carry both its
  // cost and its enormous power draw.
  if (
    counted('lance') < 1 &&
    techAllows(world, player.id, 'lance') &&
    player.powerMade - player.powerUsed > 70
  ) {
    return 'lance';
  }
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
    const d = len(field.x - hq.x, field.y - hq.y);
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

function armyCommands(world, player, buildings, army, reserve = 0) {
  const out = [];
  const producers = buildings.filter((b) => b.def.builds === 'units' && !b.constructing);
  if (producers.length === 0) return out;

  const spendable = player.scrap - reserve;
  if (spendable <= 0) return out;

  const units = defsFor(world, player.id).units;
  const roster = FACTIONS[player.faction].units.filter((id) => techAllows(world, player.id, id));
  if (roster.length === 0) return out;

  const counts = {};
  for (const u of army) counts[u.def.role] = (counts[u.def.role] || 0) + 1;
  const total = Math.max(1, army.length);

  for (const producer of producers) {
    if (producer.queue.length >= 2) continue;

    const buildable = roster.filter(
      (id) => units[id].builtAt === producer.defId && spendable >= units[id].cost
    );
    if (buildable.length === 0) continue;

    // Furthest below its quota wins.
    let pick = null;
    let worstDeficit = -Infinity;
    for (const id of buildable) {
      const role = units[id].role;
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
  const buildings = playerEntities(world, player.id, 'building');

  /**
   * Can this army still grow? Waiting to reach a value threshold only makes
   * sense if something is producing. With no factory and no income the
   * threshold is never met and the army mills around at home forever — which
   * is both a lost skirmish and an unwinnable campaign mission. If this is all
   * we are ever going to have, attack with it.
   */
  const canReinforce = buildings.some(
    (b) => (b.def.builds === 'units' || b.def.dropOff) && !b.constructing
  );
  const pushValue = canReinforce ? profile.pushValue : 1;

  // Defence overrides everything: something is in the base right now.
  const hq = buildings.find((b) => b.defId === 'command');
  if (hq) {
    const intruders = seen.filter((e) => len(e.x - hq.x, e.y - hq.y) < 16);
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
    if (armyValue >= pushValue) {
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
    if (survivors.length === 0 || armyValue < pushValue * profile.reinforceRatio * 0.5) {
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

    // Feed newly built units into the push, and re-task anyone already in it
    // who has run out of orders — a unit that finished its march and is now
    // standing in an empty field is a unit not participating in the attack.
    const idle = army.filter((u) => !u.order && !u.harvest);
    if (idle.length && ai.attackTarget) {
      for (const u of idle) ai.squad.add(u.id);
      out.push({
        type: 'attackMove',
        player: player.id,
        ids: idle.map((u) => u.id),
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
    if (e.dead || e.player === player.id || !isCombatant(e)) continue;
    if (len(e.x - point.x, e.y - point.y) <= radius) return true;
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
