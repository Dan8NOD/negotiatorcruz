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
  PROPS,
  NEUTRAL_PLAYER,
  UNITS,
  WEAPONS,
  SHIELD,
  ABILITIES,
  VETERANCY,
  TERRAIN,
  TERRAIN_INFO,
  TICKS_PER_SECOND,
  damageMultiplier,
  HERO_ABILITY,
  GATEWAY_KINDS,
} from './content.js';
import { occupy, vacate, footprint, nearestWalkable } from './grid.js';
import { len } from './numeric.js';

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

    /**
     * Direct control vector, or null when the machine is under orders.
     *
     * Set by the `steer` command and honoured by movement.js instead of the
     * path. It persists until changed, so holding a key costs one command,
     * not one per tick — which is what keeps replays small.
     */
    steer: null,

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

    /**
     * Second ability slot, carried by named pilots only and granted by
     * `makeHero` rather than by the chassis. A crew ability has to be a
     * separate slot rather than a replacement, or recruiting a pilot would
     * cost them the chassis ability their perk is written against.
     */
    heroAbility: null,
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

    /**
     * What this machine is standing beside and whether it is standing above,
     * restamped once a tick with the spatial index. Written here so the field
     * exists from the first frame — a renderer that has to distinguish "no
     * cover" from "not measured yet" would be reading simulation internals.
     */
    cover: COVER.NONE,
    elevated: false,

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

    /** Structures never take cover, but they can be built on a shelf. */
    cover: COVER.NONE,
    elevated: false,

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

/* --------------------------------------------------------------- heroes -- */

/**
 * Turn a freshly spawned machine into a named pilot's.
 *
 * The pilot fields are cosmetic — the renderer draws a gold cockpit, the
 * debrief pays XP — but the crew ability is not: it is the reason a hero is
 * worth protecting rather than a differently-coloured Kestrel.
 */
export function makeHero(world, e, { id, name, level }, abilities) {
  e.pilotId = id;
  e.pilotName = name;
  e.pilotLevel = level || 1;
  const def = abilities[HERO_ABILITY];
  if (def) {
    e.heroAbility = { id: HERO_ABILITY, def, cooldown: 0, activeUntil: 0, active: false };
  }
  return e;
}

/* ---------------------------------------------------------------- props -- */

/**
 * Spawn a piece of destructible scenery.
 *
 * A prop is a neutral entity rather than a separate layer, which buys the
 * damage pipeline, the spatial index and splash for nothing. It claims grid
 * cells the way a structure does, so A* routes around it — and `vacate` on
 * death means blowing one up genuinely opens a path.
 */
export function spawnProp(world, defId, cx, cy) {
  const def = PROPS[defId];
  if (!def) throw new Error(`unknown prop: ${defId}`);

  const e = {
    id: world.nextId++,
    kind: 'prop',
    defId,
    def,
    player: NEUTRAL_PLAYER,
    cx,
    cy,
    size: def.size,
    x: cx + def.size[0] / 2,
    y: cy + def.size[1] / 2,
    facing: 0,
    layer: 'ground',
    radius: Math.max(def.size[0], def.size[1]) / 2,

    hp: def.hp,
    maxHp: def.hp,
    shield: 0,
    maxShield: 0,
    shieldTimer: 0,
    tempShield: 0,

    /** Props never act: no weapons, no orders, no vision, no upkeep. */
    weapons: [],
    targetId: null,
    disabledUntil: 0,
    vet: 0,
    vetValue: 0,
    /** A landmark wall the challenge is built around. See PROPS.castle. */
    invulnerable: !!def.indestructible,
    dead: false,
  };

  occupy(world.map, def.size, cx, cy, e.id);
  displaceUnits(world, e);
  world.entities.set(e.id, e);
  // Scenery is the whole reason the shooting grid exists, so it is kept in
  // step here rather than only at the next tick's rebuild. A prop spawned
  // between ticks that nothing can see through until the clock moves is the
  // kind of one-tick lie that only ever shows up in a test.
  sightGridChanged(world, e);
  return e;
}

/* ------------------------------------------------------------- gateways -- */

/**
 * Spawn a way off the map.
 *
 * A gateway is neither scenery nor a structure. It has no hull, claims no
 * cells and cannot be shot — a shaft in the floor is not something you destroy
 * and a door you could demolish would make the guard in front of it optional.
 * Deliberately *not* occupying its cells is the mechanic rather than an
 * oversight: a machine has to be able to stand on it to go through it.
 *
 * It is an entity rather than a field on the map so that vision, the spatial
 * index and the renderer's draw order all handle it for nothing — the same
 * argument that made props entities.
 */
export function spawnGateway(world, gateway, x, y) {
  const kind = GATEWAY_KINDS[gateway.kind] || GATEWAY_KINDS.shaft;

  const e = {
    id: world.nextId++,
    kind: 'gateway',
    defId: gateway.kind,
    def: kind,
    /** Which gateway record in `world.gateways` this is the marker for. */
    gatewayId: gateway.id,
    player: NEUTRAL_PLAYER,
    x,
    y,
    facing: 0,
    layer: 'ground',
    radius: kind.radius,
    size: [1, 1],
    cx: Math.floor(x),
    cy: Math.floor(y),

    hp: 1,
    maxHp: 1,
    shield: 0,
    maxShield: 0,
    shieldTimer: 0,
    tempShield: 0,
    invulnerable: true,

    weapons: [],
    targetId: null,
    disabledUntil: 0,
    vet: 0,
    vetValue: 0,
    dead: false,
  };

  world.entities.set(e.id, e);
  world.events.push({ type: 'gatewayOpened', id: e.id, gateway: gateway.id, x, y });
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

  // Landmark walls and gateways absorb fire without recording it. Returning
  // zero rather than skipping the call is what keeps splash, chain reactions
  // and kill attribution from having to know these exist.
  if (target.invulnerable) return 0;

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
  // Scenery is not a kill. Crediting it would hand out veterancy for shooting
  // trees, and "flattened a housing estate" would read as a battlefield
  // record on the debrief.
  if (e.kind !== 'prop' && killer && world.players[killer.player] && killer.player !== e.player) {
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

  if (e.kind === 'building' || e.kind === 'prop') {
    // Freeing the footprint is the mechanic, not the cleanup: a flattened
    // tower block is a new route through the map — and, since props block
    // shots as well as feet, a new firing lane through it as well.
    vacate(world.map, e.size, e.cx, e.cy);
    if (e.kind === 'prop') sightGridChanged(world, e);

    // A dying reactor takes its neighbours with it, and so does a fuel
    // station — splash hits props too, so a forecourt goes up in a chain.
    const boom = e.def.deathExplosion;
    if (boom && !e.constructing) {
      for (const other of world.entities.values()) {
        if (other.dead || other.id === e.id) continue;
        if (len(other.x - e.x, other.y - e.y) > boom.radius) continue;
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
    // Presentation hints so the renderer can scale the collapse without
    // reaching back into the definition tables for a now-dead entity.
    height: e.def.height || 0,
    volatile: !!e.def.volatile,
  });
}

/* -------------------------------------------------------------- queries -- */

/**
 * Rebuilt once per tick; every proximity query in the engine reads it.
 *
 * It is also the tick's one agreed refresh point for the shooting grid below,
 * which is why that lives in this file rather than in vision.js where line of
 * sight would otherwise belong: the grid has exactly the index's lifetime, and
 * anything rebuilding it on its own cadence would be a second, subtly
 * different picture of the same world.
 */
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

  refreshSightGrid(world);
  stampGround(world);

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
            if (len(e.x - x, e.y - y) <= radius) out.push(e);
          }
        }
      }
      return out;
    },
  };
}

export function distance(a, b) {
  return len(a.x - b.x, a.y - b.y);
}

/* ------------------------------------------------ terrain, cover, height -- */

/**
 * What a cell does to a shot crossing it.
 *
 * Read off the prop table rather than declared per prop. `height`, `storeys`,
 * `canopy`, `low` and `shape` were already there to tell the renderer how tall
 * to draw the thing, and they describe exactly the fact the simulation needs:
 * a nine-storey tower is opaque, a waist-high hedgerow is not. A dedicated
 * `blocksLineOfSight` flag would have meant every prop added afterwards was
 * one forgotten edit away from being a pane of glass — and the three nobody
 * remembered to tag would be the three the player is standing behind.
 */
export const BLOCK = {
  NONE: 0,
  /** Waist-high. In the way of legs, not of eyes — but you can lie behind it. */
  LOW: 1,
  /** Breaks a firing line without ending it: canopy, lattice, a wrecked bus. */
  PARTIAL: 2,
  /** Cliff, or anything built taller than the machine shooting at it. */
  SOLID: 3,
};

/** Cover a defender is getting from whatever is at its shoulder. */
export const COVER = { NONE: 0, HALF: 1, FULL: 2 };

/**
 * What each tier is worth. Two tiers and no more, because the player has to be
 * able to look at a mech and predict this — a five-tier model is one nobody
 * can read off the battlefield, and cover the player cannot see is just a
 * damage roll that makes fights feel arbitrary.
 *
 * The ceiling is set against the damage table rather than by feel. Kinetic
 * into medium plate is 0.70 and energy into light is 0.75, so full cover at
 * 0.60 would have made *where you stood* a bigger decision than *what you
 * built* — and army composition is the headline system this game is built
 * around. At 0.70 the best position on the map is worth about as much as
 * getting the counter right, which is the trade that should be close.
 */
export const COVER_DAMAGE = [1, 0.85, 0.7];

/**
 * Taller than the machine shooting at it. A mech stands about one cell high in
 * the same units the prop table uses, so this is the line between "I can see
 * over that" and "that is a wall".
 */
const SOLID_HEIGHT = 1.0;

/**
 * Shapes you can see through, whatever their height says. A relay mast is a
 * lattice, a water tower is four legs under a drum, and a brazier is a basket
 * on a pole: all three clear the height test and none of them would stop a
 * shell. Without this the tallest things on the map would also be the most
 * opaque, which is exactly backwards.
 */
const OPEN_FRAME = new Set(['mast', 'watertower', 'brazier']);

/** How a piece of scenery reads to a shot. */
export function blockingOf(def) {
  if (!def) return BLOCK.NONE;
  if (def.low) return BLOCK.LOW;
  if (def.canopy || OPEN_FRAME.has(def.shape)) return BLOCK.PARTIAL;
  if ((def.storeys || 0) >= 2 || (def.height || 0) >= SOLID_HEIGHT) return BLOCK.SOLID;
  return BLOCK.PARTIAL;
}

/** The cover standing next to a cell of this kind is worth. */
function coverOf(value) {
  if (value >= BLOCK.SOLID) return COVER.FULL;
  if (value >= BLOCK.LOW) return COVER.HALF;
  return COVER.NONE;
}

/**
 * What high ground is worth.
 *
 * Cliffs were walls and nothing else: impassable, and no reason to want the
 * ground beside one. These two numbers are what make "get on top of them" in
 * the Longbow Country briefing a literal instruction rather than flavour text.
 *
 * Reach is a multiplier rather than a flat bonus so the ridge is a *siege*
 * advantage — worth half a cell to a scattergun and two and a half to a
 * deployed mortar — and sight comes with it because holding a ridge you cannot
 * see off is holding a wall. Cover falls out for free: the cliff at your
 * shoulder is full cover by the rule above, so the shelf is simultaneously the
 * longest reach, the widest view and the hardest place to shift. That stack is
 * the point. It is also perfectly symmetrical, and the AI takes it through the
 * same functions the player's machines do.
 */
export const ELEVATION = {
  /** Reach, multiplied. Shooting downhill is the whole point of a ridge. */
  RANGE: 1.15,
  /** Cells of extra sight. Seeing them coming is the other half. */
  SIGHT: 2,
};

/**
 * Is this point on the lip of a cliff?
 *
 * The map carries no elevation data and does not need any: a cliff is already
 * the only thing on it that is *above* the ground rather than on it, so the
 * shelf is a passable cell with a cliff orthogonally beside it. Diagonals
 * deliberately do not count — a cell touching a cliff at one corner is not
 * standing on anything, and counting it smears the shelf into a blob whose
 * edge nobody can see.
 *
 * Five array reads and no cache. A precomputed shelf bitmap was the obvious
 * shape for this and it was wrong twice over: the predicate is *local*, so
 * there is nothing to precompute that a lookup does not already do, and a
 * cached mask silently describes the map as it was generated — which is a lie
 * the moment a test flattens a rectangle to build itself a known arena, and
 * exactly the kind of lie that makes a suite assert nothing while staying
 * green.
 */
export function isElevated(map, x, y) {
  const cx = Math.floor(x);
  const cy = Math.floor(y);
  if (cx < 0 || cy < 0 || cx >= map.width || cy >= map.height) return false;
  const { width, height, terrain } = map;
  const i = cy * width + cx;
  if (!TERRAIN_INFO[terrain[i]].passable) return false;
  return (
    (cy > 0 && terrain[i - width] === TERRAIN.CLIFF) ||
    (cy < height - 1 && terrain[i + width] === TERRAIN.CLIFF) ||
    (cx > 0 && terrain[i - 1] === TERRAIN.CLIFF) ||
    (cx < width - 1 && terrain[i + 1] === TERRAIN.CLIFF)
  );
}

/**
 * Terrain and scenery, flattened into one byte per cell.
 *
 * Everything that asks whether a shot gets through reads this array, and it is
 * rebuilt once per tick: one pass over the terrain, then a stamp of every
 * standing prop. That is a few tens of microseconds on a full 144×144 map with
 * six hundred props on it, and it is paid once however many rounds are fired
 * that tick. The alternative — walking the entity list per shot — is the same
 * work multiplied by every trigger pull in the game, and that is the version
 * that stutters on a tablet.
 */
const SIGHT_GRIDS = new WeakMap();

export function sightGrid(world) {
  let cells = SIGHT_GRIDS.get(world.map);
  if (!cells) {
    cells = new Uint8Array(world.map.width * world.map.height);
    SIGHT_GRIDS.set(world.map, cells);
    refreshSightGrid(world);
  }
  return cells;
}

function refreshSightGrid(world) {
  const cells = SIGHT_GRIDS.get(world.map);
  if (!cells) return;
  // Re-read terrain rather than copying a cached mask of it. It is the same
  // one pass either way, and reading the real thing means a map edited under a
  // live world — which is how most of the suite builds an arena — cannot leave
  // this describing a world that no longer exists.
  const { terrain } = world.map;
  for (let i = 0; i < terrain.length; i++) {
    cells[i] = terrain[i] === TERRAIN.CLIFF ? BLOCK.SOLID : BLOCK.NONE;
  }
  for (const e of world.entities.values()) {
    if (e.dead || e.kind !== 'prop') continue;
    stampProp(world.map, cells, e, blockingOf(e.def));
  }
}

/**
 * A prop went up or came down: patch its footprint rather than rebuilding.
 *
 * Cheap because scenery never overlaps — `propFits` refuses a footprint that
 * is already claimed — so a cell's answer is either this prop or the bare
 * terrain underneath it, and nothing else has to be consulted.
 */
function sightGridChanged(world, prop) {
  const cells = SIGHT_GRIDS.get(world.map);
  if (!cells || !prop.size) return;
  const map = world.map;
  const [w, h] = prop.size;

  for (let y = prop.cy; y < prop.cy + h; y++) {
    for (let x = prop.cx; x < prop.cx + w; x++) {
      if (x < 0 || y < 0 || x >= map.width || y >= map.height) continue;
      const i = y * map.width + x;
      cells[i] = map.terrain[i] === TERRAIN.CLIFF ? BLOCK.SOLID : BLOCK.NONE;
    }
  }
  if (!prop.dead) stampProp(map, cells, prop, blockingOf(prop.def));
}

function stampProp(map, cells, prop, value) {
  const [w, h] = prop.size;
  for (let y = prop.cy; y < prop.cy + h; y++) {
    for (let x = prop.cx; x < prop.cx + w; x++) {
      if (x < 0 || y < 0 || x >= map.width || y >= map.height) continue;
      const i = y * map.width + x;
      if (cells[i] < value) cells[i] = value;
    }
  }
}

/**
 * Write each machine's footing onto it: what it is standing beside, and
 * whether it is standing above.
 *
 * Presentation and the order layer both need these without paying for a query,
 * and stamping them once a tick is what keeps `weaponRange` a lookup rather
 * than a grid walk. Structures get `elevated` but never `cover`: a building
 * cannot move into a doorway, and its answer to being shot at is the hull the
 * armour table already gives it.
 */
function stampGround(world) {
  const map = world.map;
  const cells = sightGrid(world);

  for (const e of world.entities.values()) {
    if (e.dead || (e.kind !== 'unit' && e.kind !== 'building')) continue;
    const cx = Math.floor(e.x);
    const cy = Math.floor(e.y);
    const inside = cx >= 0 && cy >= 0 && cx < map.width && cy < map.height;
    const grounded = inside && e.layer !== 'air';

    e.elevated = grounded && isElevated(map, e.x, e.y);
    e.cover = grounded && e.kind === 'unit' ? bestCover(map, cells, cx, cy) : COVER.NONE;
  }
}

/** The best cover available to a machine standing here, from any direction. */
function bestCover(map, cells, cx, cy) {
  let best = COVER.NONE;
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      if (dx === 0 && dy === 0) continue;
      const x = cx + dx;
      const y = cy + dy;
      if (x < 0 || y < 0 || x >= map.width || y >= map.height) continue;
      const tier = coverOf(cells[y * map.width + x] | 0);
      if (tier > best) best = tier;
    }
  }
  return best;
}

/**
 * The eight cells a machine can be tucked against, with the unit vector from
 * its own cell to each. Baked rather than computed — see numeric.js on why the
 * simulation does not call trig, and these are the only diagonals it needs.
 */
const SHOULDERS = [
  [-1, -1, -0.7071067811865476, -0.7071067811865476],
  [0, -1, 0, -1],
  [1, -1, 0.7071067811865476, -0.7071067811865476],
  [-1, 0, -1, 0],
  [1, 0, 1, 0],
  [-1, 1, -0.7071067811865476, 0.7071067811865476],
  [0, 1, 0, 1],
  [1, 1, 0.7071067811865476, 0.7071067811865476],
];

/**
 * How wide an arc a piece of cover protects — a little over forty-five
 * degrees, which works out as "the cell the round is coming from, and the one
 * at that shoulder". Anything beside or behind the machine is not cover, so
 * being flanked is a real thing that happens and moving round a dug-in enemy
 * is a real answer to one.
 */
const COVER_ARC = 0.6;

/**
 * Cover this defender is getting *from this direction*.
 *
 * The instinct is to ask "is there a wall on the line?", and that is the wrong
 * question — `traceShot` already asked it, and a shot that crossed a wall never
 * arrived. If cover meant the same thing as a block it would be dead content:
 * every shot cover could reduce is a shot that was never fired.
 *
 * So it is an *arc*, not a line. A machine tucked into the corner of a tower
 * block is only half exposed to anything shooting down the street past that
 * corner, and that shot is a real one — it has a clear line, it just has to
 * come in round the building. Checking which of the eight cells at the
 * machine's shoulders lie within `COVER_ARC` of the incoming round is O(1),
 * needs no trace, and answers the same question the player answers by eye:
 * "there is most of a building between us".
 */
export function coverAgainst(world, target, fromX, fromY) {
  if (!target || target.kind !== 'unit' || target.layer === 'air') return COVER.NONE;
  const dx = fromX - target.x;
  const dy = fromY - target.y;
  const d = len(dx, dy);
  if (d < 0.001) return COVER.NONE;

  const map = world.map;
  const cells = sightGrid(world);
  const ux = dx / d;
  const uy = dy / d;
  const ox = Math.floor(target.x);
  const oy = Math.floor(target.y);
  let best = COVER.NONE;

  for (let i = 0; i < SHOULDERS.length; i++) {
    const s = SHOULDERS[i];
    if (s[2] * ux + s[3] * uy < COVER_ARC) continue;
    const x = ox + s[0];
    const y = oy + s[1];
    if (x < 0 || y < 0 || x >= map.width || y >= map.height) continue;
    const tier = coverOf(cells[y * map.width + x] | 0);
    if (tier > best) best = tier;
    if (best === COVER.FULL) break;
  }

  return best;
}

/** A shot that never leaves the barrel. `traceShot` returns this or a count. */
export const BLOCKED = -1;

/**
 * Cells of canopy that add up to a wall.
 *
 * A wood has to tax a firing line without being a fortress: shooting into the
 * edge of one works, shooting the length of one does not. Four is the depth at
 * which a scattered stand of ironwood stops being scenery — and it is reached
 * only inside a park district, which is the one place on the map where "they
 * went into the trees" ought to mean something.
 */
const SOFT_OPAQUE = 4;

/** Scratch for the walk. Module-level: the engine never traces two at once. */
const traced = new Uint8Array(96);

/**
 * Walk the line a shot would take and report what is in the way.
 *
 * @returns {number} BLOCKED, or the number of partial-cover cells crossed.
 *
 * The same Bresenham walk `hasLineOfWalk` uses in grid.js, against the flat
 * byte grid above rather than the terrain array, and with two rules at the
 * ends that matter more than they look:
 *
 * - The shooter's own cell is never in its own way, and neither is the run of
 *   solid cells it is standing *in*. A machine inside a blocker is on top of
 *   it, not behind it — without this a mech that a leap, a displacement or a
 *   test dropped onto a rock would be permanently disarmed, facing outward at
 *   a world it can no longer shoot at.
 * - The target's own footprint is not in the way either, or nothing could ever
 *   shoot the tower block that is blocking it, and an ordered attack on
 *   scenery would silently do nothing.
 */
export function traceShot(world, shooter, target) {
  // Air is the one thing terrain has no answer to, and that is the entire
  // argument for owning any. A gunship over a ridge is over the ridge.
  if (shooter.layer === 'air' || target.layer === 'air') return 0;

  const map = world.map;
  const cells = sightGrid(world);
  const w = map.width;

  const fromX = Math.floor(shooter.x);
  const fromY = Math.floor(shooter.y);
  const toX = Math.floor(target.x);
  const toY = Math.floor(target.y);
  if (fromX === toX && fromY === toY) return 0;

  // Props and structures claim more than a cell, so "the target's own ground"
  // is a rectangle rather than a point.
  const wide = target.size && target.cx !== undefined;
  const rx0 = wide ? target.cx : toX;
  const ry0 = wide ? target.cy : toY;
  const rx1 = wide ? target.cx + target.size[0] - 1 : toX;
  const ry1 = wide ? target.cy + target.size[1] - 1 : toY;

  const dx = Math.abs(toX - fromX);
  const dy = Math.abs(toY - fromY);
  const stepX = fromX < toX ? 1 : -1;
  const stepY = fromY < toY ? 1 : -1;
  let err = dx - dy;
  let x = fromX;
  let y = fromY;
  let n = 0;

  for (;;) {
    const e2 = 2 * err;
    if (e2 > -dy) {
      err -= dy;
      x += stepX;
    }
    if (e2 < dx) {
      err += dx;
      y += stepY;
    }
    if (x === toX && y === toY) break;
    if (x >= rx0 && x <= rx1 && y >= ry0 && y <= ry1) break;
    // Longer than any weapon in the game can reach. Whatever this is, it is
    // not a shot, and the trace is not the place to find out.
    if (n >= traced.length) break;
    traced[n++] = cells[y * w + x] | 0;
  }

  let head = 0;
  let tail = n - 1;
  if ((cells[fromY * w + fromX] | 0) >= BLOCK.SOLID) {
    while (head <= tail && traced[head] >= BLOCK.SOLID) head++;
  }
  if ((cells[toY * w + toX] | 0) >= BLOCK.SOLID) {
    while (tail >= head && traced[tail] >= BLOCK.SOLID) tail--;
  }

  let soft = 0;
  for (let i = head; i <= tail; i++) {
    if (traced[i] >= BLOCK.SOLID) return BLOCKED;
    if (traced[i] === BLOCK.PARTIAL) soft++;
  }
  return soft >= SOFT_OPAQUE ? BLOCKED : soft;
}

/**
 * Edge-to-edge distance. Weapon range against a 3×3 Command Rig has to mean
 * "range to the building", not "range to a point in its middle", or siege
 * units mysteriously refuse to shoot things they are standing on.
 */
export function rangeTo(a, b) {
  return Math.max(0, distance(a, b) - (b.radius || 0));
}

/**
 * Is this entity a participant in the war at all?
 *
 * Scenery is owned by nobody, which means a naive `a.player !== b.player`
 * reads every tree on the map as an enemy. That is not hypothetical: it put
 * "the enemy base is visible at match start" and an AI that never attacked
 * into the suite the moment props landed. Every place that enumerates enemies
 * goes through this.
 */
export function isCombatant(e) {
  return e.kind !== 'prop' && e.kind !== 'gateway';
}

export function isEnemy(world, a, b) {
  return isCombatant(b) && a.player !== b.player;
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
