/**
 * Entities: creation, damage resolution, death, and spatial lookup.
 *
 * Units and structures are the same shape with different fields populated,
 * because every system that does not care about the difference — vision,
 * damage, selection, targeting — then does not have to branch. `kind` is the
 * discriminator for the systems that do care.
 */

import {
  ARMOR,
  BUILDINGS,
  UNITS,
  WEAPONS,
  SHIELD,
  ABILITIES,
  VETERANCY,
  TICKS_PER_SECOND,
  damageMultiplier,
} from './content.js';
import { occupy, vacate, footprint, nearestWalkable } from './grid.js';

/* --------------------------------------------------------------- create -- */

/**
 * A player's resolved stat tables.
 *
 * Campaign upgrades and pilot perks are baked into these once, before the
 * world exists (see progression.js), so every read of a unit's stats goes
 * through the owning player rather than the shared content tables. The
 * fallback keeps bare test worlds and any un-upgraded player working.
 */
export function defsFor(world, playerId) {
  const player = world.players[playerId];
  return (player && player.defs) || FALLBACK_DEFS;
}

const FALLBACK_DEFS = {
  units: UNITS,
  buildings: BUILDINGS,
  weapons: WEAPONS,
  abilities: ABILITIES,
};

function makeWeapons(hardpoints = [], weaponTable) {
  return hardpoints.map((id) => ({
    id,
    def: weaponTable[id],
    cooldown: 0,
    /** Rounds left in the current salvo, and the tick countdown between them. */
    salvoLeft: 0,
    salvoTimer: 0,
    salvoTargetId: null,
  }));
}

/**
 * Spawn a mech. `x`/`y` are in cell units with a fractional part — units live
 * in continuous space and only consult the grid for pathing.
 */
export function spawnUnit(world, defId, playerId, x, y) {
  const defs = defsFor(world, playerId);
  const def = defs.units[defId];
  if (!def) throw new Error(`unknown unit: ${defId}`);

  const e = {
    id: world.nextId++,
    kind: 'unit',
    defId,
    def,
    player: playerId,
    x,
    y,
    facing: 0,
    hp: def.hp,
    maxHp: def.hp,
    shield: def.shield || 0,
    maxShield: def.shield || 0,
    shieldTimer: 0,
    layer: def.layer,
    radius: def.radius,

    order: null,
    /** Shift-queued follow-up orders, popped when the current one completes. */
    orderQueue: [],
    path: [],
    pathGoal: null,
    repathCooldown: 0,
    stuckTicks: 0,

    targetId: null,
    /** Set when the player explicitly ordered this attack, so the unit holds it. */
    targetForced: false,
    weapons: makeWeapons(def.hardpoints, defs.weapons),

    ability: def.ability
      ? {
          id: def.ability,
          def: defs.abilities[def.ability],
          cooldown: 0,
          activeUntil: 0,
          active: false,
        }
      : null,
    disabledUntil: 0,
    /** Veterancy rank, and destroyed enemy value banked toward the next one. */
    vet: 0,
    vetValue: 0,
    speedMul: 1,
    speedMulUntil: 0,
    tempShield: 0,
    tempShieldUntil: 0,
    deployed: false,
    deployTimer: 0,
    leap: null,

    cargo: 0,
    harvest: def.capacity ? { cell: null, homeId: null, state: 'idle' } : null,

    vx: 0,
    vy: 0,
    dead: false,
  };

  world.entities.set(e.id, e);
  world.events.push({ type: 'spawn', id: e.id, defId, player: playerId, x, y });
  return e;
}

/**
 * Place a structure. `constructing` structures are alive and targetable but
 * inert — they take the full build time to come online, which is what makes
 * forward-building a real risk rather than a free teleport.
 */
export function spawnBuilding(world, defId, playerId, cx, cy, { complete = false } = {}) {
  const defs = defsFor(world, playerId);
  const def = defs.buildings[defId];
  if (!def) throw new Error(`unknown building: ${defId}`);

  const e = {
    id: world.nextId++,
    kind: 'building',
    defId,
    def,
    player: playerId,
    cx,
    cy,
    size: def.size,
    // Centre point, so range checks treat buildings like everything else.
    x: cx + def.size[0] / 2,
    y: cy + def.size[1] / 2,
    facing: 0,
    layer: 'ground',
    radius: Math.max(def.size[0], def.size[1]) / 2,

    hp: complete ? def.hp : Math.max(1, Math.round(def.hp * 0.1)),
    maxHp: def.hp,
    shield: 0,
    maxShield: 0,
    shieldTimer: 0,

    constructing: !complete,
    buildProgress: complete ? def.buildTime : 0,
    buildTime: def.buildTime,

    queue: [],
    rally: null,
    powered: true,

    weapons: makeWeapons(def.hardpoints, defs.weapons),
    targetId: null,
    targetForced: false,
    disabledUntil: 0,
    // Emplacements earn rank too — a turret that has held a choke point all
    // game should be better at it than one that went up a minute ago.
    vet: 0,
    vetValue: 0,

    /** Set while the player is paying to patch this structure up. */
    repairing: false,
    /** Superweapon charge, in ticks. Only ever non-null on a Lance. */
    charge: def.superweapon ? 0 : null,
    dead: false,
  };

  occupy(world.map, def.size, cx, cy, e.id);
  displaceUnits(world, e);
  world.entities.set(e.id, e);
  world.events.push({ type: 'placed', id: e.id, defId, player: playerId, cx, cy });
  if (complete) onBuildingComplete(world, e);
  return e;
}

/* ----------------------------------------------------------- veterancy -- */

/**
 * Veterancy multipliers for an entity's current rank.
 *
 * Read at the point of use rather than baked into the entity, because the
 * shared definition tables must never be mutated and copying a whole def per
 * promotion would be wasteful. Rank 0 returns all-ones, so the un-promoted
 * path costs one array index and nothing else.
 */
export function vetBonus(e) {
  return VETERANCY[e.vet || 0] || VETERANCY[0];
}

/**
 * Credit a kill toward promotion, C&C style: a unit promotes once it has
 * destroyed enemy value worth a multiple of its own cost. Scaling the
 * threshold to cost is what lets a 300-scrap scout and a 1300-scrap siege
 * mech share one rule without either being trivially or impossibly promoted.
 */
function creditKill(world, killer, victim) {
  if (!killer || killer.dead) return;
  const cost = killer.def.cost || 300;
  killer.vetValue = (killer.vetValue || 0) + (victim.def.cost || 100);

  const current = killer.vet || 0;
  const next = VETERANCY[current + 1];
  if (!next || killer.vetValue < next.killValue * cost) return;

  promote(world, killer, current + 1);
}

function promote(world, e, rank) {
  const previous = vetBonus(e);
  e.vet = rank;
  const now = vetBonus(e);

  // Hull scales with rank, and promotion heals by the amount gained — a
  // promotion mid-fight should feel like a reprieve, which is exactly what it
  // is in every C&C game.
  const base = e.maxHp / previous.hull;
  const gained = Math.round(base * now.hull) - e.maxHp;
  e.maxHp += gained;
  e.hp = Math.min(e.maxHp, e.hp + gained);

  world.events.push({ type: 'promoted', id: e.id, rank, x: e.x, y: e.y });
}

/** Elite machines patch themselves between engagements. */
export function updateSelfRepair(world, e) {
  const bonus = vetBonus(e);
  if (bonus.selfRepair <= 0 || e.hp >= e.maxHp) return;
  e.hp = Math.min(e.maxHp, e.hp + bonus.selfRepair / TICKS_PER_SECOND);
}

/**
 * Shove any ground unit standing where a new structure just went up.
 *
 * The alternative — refusing placement whenever a unit is in the way — reads
 * as the game ignoring your click, and with collectors wandering through the
 * base it would happen constantly. Displacing is the friendlier rule and the
 * one every shipped RTS eventually converges on.
 */
function displaceUnits(world, building) {
  for (const other of world.entities.values()) {
    if (other.dead || other.kind !== 'unit' || other.layer !== 'ground') continue;
    const cx = Math.floor(other.x);
    const cy = Math.floor(other.y);
    if (cx < building.cx || cy < building.cy) continue;
    if (cx >= building.cx + building.size[0] || cy >= building.cy + building.size[1]) continue;

    const spot = nearestWalkable(world.map, cx, cy, 10);
    if (spot) {
      other.x = spot.x + 0.5;
      other.y = spot.y + 0.5;
      other.path = [];
      other.stuckTicks = 0;
    }
  }
}

/** Called once a structure finishes: tech unlocks, freebies, power recompute. */
export function onBuildingComplete(world, e) {
  const player = world.players[e.player];
  player.tech.add(e.defId);
  world.events.push({ type: 'built', id: e.id, defId: e.defId, player: e.player });

  if (e.def.freeUnit) {
    const spot = exitPoint(world, e);
    spawnUnit(world, e.def.freeUnit, e.player, spot.x, spot.y);
  }
}

/** A clear-ish tile just outside a structure's footprint, for unit exits. */
export function exitPoint(world, building) {
  const [w, h] = building.size;
  return { x: building.cx + w / 2, y: building.cy + h + 0.6 };
}

/* --------------------------------------------------------------- damage -- */

/**
 * Apply damage through the shield/armour model.
 *
 * Shields absorb first and take no armour multiplier — a War Robots shield
 * does not care what calibre broke it. Hull takes the Red Alert warhead ×
 * armour multiplier. Both halves of the design, in eight lines.
 *
 * @returns {number} hull damage actually dealt, for kill attribution.
 */
export function applyDamage(world, target, amount, damageType, sourceId = 0) {
  if (!target || target.dead || amount <= 0) return 0;

  let remaining = amount;

  // Ability-granted temporary shield is consumed before the native pool.
  if (target.tempShield > 0) {
    const soaked = Math.min(target.tempShield, remaining);
    target.tempShield -= soaked;
    remaining -= soaked;
  }

  if (remaining > 0 && target.shield > 0) {
    const soaked = Math.min(target.shield, remaining);
    const broke = soaked >= target.shield;
    target.shield -= soaked;
    remaining -= soaked;
    target.shieldTimer = SHIELD.REGEN_DELAY + (broke ? SHIELD.BREAK_PENALTY : 0);
    if (broke) world.events.push({ type: 'shieldBreak', id: target.id, x: target.x, y: target.y });
  } else if (remaining > 0) {
    target.shieldTimer = SHIELD.REGEN_DELAY;
  }

  if (remaining <= 0) return 0;

  const armorClass = target.kind === 'building' ? ARMOR.STRUCTURE : target.def.armor;
  const hullDamage = remaining * damageMultiplier(damageType, armorClass);
  target.hp -= hullDamage;

  world.events.push({
    type: 'hit',
    id: target.id,
    x: target.x,
    y: target.y,
    damageType,
    amount: hullDamage,
  });

  if (target.hp <= 0) killEntity(world, target, sourceId);
  return hullDamage;
}

/** Disable a target's weapons and movement for `ticks`. EMP's whole point. */
export function disable(world, target, ticks) {
  if (!target || target.dead) return;
  target.disabledUntil = Math.max(target.disabledUntil, world.tick + ticks);
  world.events.push({ type: 'emp', id: target.id, x: target.x, y: target.y });
}

export function killEntity(world, e, sourceId = 0) {
  if (e.dead) return;
  e.dead = true;
  e.hp = 0;

  const owner = world.players[e.player];
  if (owner) owner.stats.lost++;
  const killer = world.entities.get(sourceId);
  if (killer && world.players[killer.player] && killer.player !== e.player) {
    world.players[killer.player].stats.killed++;
    creditKill(world, killer, e);

    // Campaign bookkeeping: a named pilot's kills are worth XP, scaled by what
    // they killed, so a Collector is not worth the same as an Anvil.
    if (killer.pilotId && world.pilotKills) {
      const record = (world.pilotKills[killer.pilotId] ||= { kills: 0, value: 0 });
      record.kills++;
      record.value += e.def.cost || 100;
    }
  }

  // Losing a pilot is a mission fact the debrief has to be able to report.
  if (e.pilotId && world.pilotsLost) world.pilotsLost.add(e.pilotId);

  if (e.kind === 'building') {
    vacate(world.map, e.size, e.cx, e.cy);

    // A dying reactor takes its neighbours with it. Base layout is a decision.
    const boom = e.def.deathExplosion;
    if (boom && !e.constructing) {
      for (const other of world.entities.values()) {
        if (other.dead || other.id === e.id) continue;
        if (Math.hypot(other.x - e.x, other.y - e.y) > boom.radius) continue;
        applyDamage(world, other, boom.damage, boom.type, e.id);
      }
      world.events.push({ type: 'explosion', x: e.x, y: e.y, radius: boom.radius, big: true });
    }
  }

  world.events.push({
    type: 'death',
    id: e.id,
    defId: e.defId,
    kind: e.kind,
    player: e.player,
    x: e.x,
    y: e.y,
  });
}

/* -------------------------------------------------------------- queries -- */

/** Rebuilt once per tick; every proximity query in the engine reads it. */
export function buildSpatialIndex(world) {
  const cellSize = 4;
  const buckets = new Map();
  const key = (x, y) => ((y / cellSize) | 0) * 4096 + ((x / cellSize) | 0);

  for (const e of world.entities.values()) {
    if (e.dead) continue;
    const k = key(e.x, e.y);
    let bucket = buckets.get(k);
    if (!bucket) buckets.set(k, (bucket = []));
    bucket.push(e);
  }

  return {
    cellSize,
    /** Every live entity whose centre is within `radius` cells of (x, y). */
    query(x, y, radius) {
      const out = [];
      const r = Math.ceil(radius / cellSize);
      const bx = (x / cellSize) | 0;
      const by = (y / cellSize) | 0;
      for (let gy = by - r; gy <= by + r; gy++) {
        for (let gx = bx - r; gx <= bx + r; gx++) {
          const bucket = buckets.get(gy * 4096 + gx);
          if (!bucket) continue;
          for (const e of bucket) {
            if (Math.hypot(e.x - x, e.y - y) <= radius) out.push(e);
          }
        }
      }
      return out;
    },
  };
}

export function distance(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/**
 * Edge-to-edge distance. Weapon range against a 3×3 Command Rig has to mean
 * "range to the building", not "range to a point in its middle", or siege
 * units mysteriously refuse to shoot things they are standing on.
 */
export function rangeTo(a, b) {
  return Math.max(0, distance(a, b) - (b.radius || 0));
}

export function isEnemy(world, a, b) {
  return a.player !== b.player;
}

export function livingEntities(world) {
  const out = [];
  for (const e of world.entities.values()) if (!e.dead) out.push(e);
  return out;
}

export function playerEntities(world, playerId, kind = null) {
  const out = [];
  for (const e of world.entities.values()) {
    if (e.dead || e.player !== playerId) continue;
    if (kind && e.kind !== kind) continue;
    out.push(e);
  }
  return out;
}

/** Cells a structure covers — used by placement previews and vision. */
export { footprint };
