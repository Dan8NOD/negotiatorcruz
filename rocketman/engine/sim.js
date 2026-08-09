/**
 * The simulation.
 *
 * `createWorld` builds a match; `tick(world, commands)` advances it exactly
 * one step. Nothing here touches the DOM, a canvas, a timer or the network —
 * the renderer reads world state and pushes commands back in, and that is the
 * entire contract. It is also why the whole thing is testable under
 * `node --test` without a browser, and why porting to Swift means porting
 * eight files rather than a game.
 *
 * Commands are applied at the top of a tick rather than the moment a player
 * clicks. That one-frame latency is invisible in play and is the property
 * that makes deterministic lockstep possible later.
 */

import {
  BUILDINGS,
  UNITS,
  FACTIONS,
  START,
  TICKS_PER_SECOND,
  TERRAIN,
  REGROWTH,
} from './content.js';
import { createRng } from './rng.js';
import { createMap, canPlace, nearestWalkable, DEFAULT_MAP_SIZE } from './grid.js';
import {
  spawnUnit,
  spawnBuilding,
  buildSpatialIndex,
  rangeTo,
  playerEntities,
  applyDamage,
  updateSelfRepair,
  makeHero,
  spawnProp,
} from './entities.js';
import { setPath, clearPath, stepMovement, setSteer } from './movement.js';
import { updateWeapons, updateProjectiles, maxRange, acquireTarget } from './combat.js';
import {
  updateAbilities,
  updateShield,
  activateAbility,
  CHASSIS_SLOT,
  HERO_SLOT,
} from './abilities.js';
import {
  recomputePower,
  updateConstruction,
  updateProduction,
  updateHarvester,
  enqueueUnit,
  cancelQueued,
  canAfford,
  spend,
  techAllows,
  sellBuilding,
  updateRepair,
  updateSuperweapon,
  superweaponReady,
  updateRegrowth,
} from './economy.js';
import { createVision, updateVision, VISION_INTERVAL, isVisible } from './vision.js';
import { resolveDefs } from './progression.js';
import { prepareObjectives, evaluateObjectives, OBJECTIVE_INTERVAL } from './objectives.js';
import {
  prepareGateways,
  initGateways,
  updateGateways,
  gatewayLandmarks,
  GATEWAY_INTERVAL,
} from './gateways.js';
import { len, ringOffset, facingTo } from './numeric.js';

export { TICKS_PER_SECOND };

/* ---------------------------------------------------------------- setup -- */

/**
 * Build a match.
 *
 * A skirmish passes two bare player configs. A campaign mission passes the
 * same shape plus a `start` block describing the opening forces, a loadout of
 * `upgrades` and `pilots`, and a `mission` with objectives. Both go through
 * exactly this function, so anything true of a skirmish is true of a mission.
 *
 * @param {object} options
 * @param {number} options.seed
 * @param {Array<object>} options.players
 * @param {object} [options.mission] Objectives and mission metadata.
 * @param {string} [options.biome] Which world this is; see BIOMES.
 * @param {Array<string>} [options.landmarks] Unique props to place. Defaults
 *   to whatever the mission's gateways are anchored to, so the two can never
 *   disagree about whether this map has a castle on it.
 */
export function createWorld({
  seed = 1,
  players: playerConfigs,
  mapSize = DEFAULT_MAP_SIZE,
  mission = null,
  biome = undefined,
  landmarks = undefined,
  /**
   * The map character the player picked, or null for "let the seed decide".
   *
   * Part of the config, which means the recorder writes it into the log and a
   * replay rebuilds the same ground. A chosen map that replayed as a rolled
   * one would desync on the first pathfind.
   */
  character = null,
} = {}) {
  const map = createMap(seed, {
    width: mapSize,
    height: mapSize,
    biome: biome || (mission && mission.biome) || undefined,
    landmarks: landmarks || gatewayLandmarks(mission),
    // Missions author their own ground; only skirmish offers the choice.
    character: mission ? null : character,
  });

  const world = {
    tick: 0,
    seed,
    rng: createRng(seed),
    map,
    entities: new Map(),
    projectiles: [],
    effects: [],
    events: [],
    index: null,
    nextId: 1,
    over: false,
    winner: null,
    players: [],

    /** Campaign state. Null in a skirmish, and every read of it is guarded. */
    mission,
    missionStartTick: 0,
    objectives: mission ? prepareObjectives(mission) : [],
    /** 'won' | 'lost' once decided. */
    result: null,
    /**
     * Ways off this map, and where the crew went if they took one. `exit` is
     * pure bookkeeping for the debrief — the mission ends because an `enter`
     * objective completed, not because this was set.
     */
    gateways: prepareGateways(mission),
    exit: null,
    /** Per-pilot kill tallies, for XP at the debrief. */
    pilotKills: {},
    /** Pilots who did not walk away from this one. */
    pilotsLost: new Set(),
    /** Superweapon strikes in the air, resolved on their landing tick. */
    pendingStrikes: [],
    /** Indices of `mission.reinforcements` already delivered. */
    reinforced: [],
  };

  playerConfigs.forEach((cfg, i) => {
    world.players.push({
      id: i,
      name: cfg.name || FACTIONS[cfg.faction].name,
      faction: cfg.faction,
      isAI: !!cfg.isAI,
      difficulty: cfg.difficulty || 'normal',
      scrap: cfg.start && cfg.start.scrap !== undefined ? cfg.start.scrap : START.scrap,
      scrapMined: 0,
      scrapSpent: 0,
      powerMade: 0,
      powerUsed: 0,
      powerRatio: 1,
      tech: new Set(),
      vision: createVision(map),
      defeated: false,
      stats: { built: 0, lost: 0, killed: 0 },
      ai: null,

      /**
       * Campaign upgrades and pilot perks, resolved once into private stat
       * tables. Everything downstream reads these rather than the shared
       * content tables, so an upgraded Kestrel is just a Kestrel with
       * different numbers and determinism is untouched.
       */
      upgrades: cfg.upgrades || [],
      pilots: cfg.pilots || [],
      defs: resolveDefs({ upgrades: cfg.upgrades, pilots: cfg.pilots }),
      /** Definitions a mission has taken off the table entirely. */
      locked: new Set((cfg.start && cfg.start.locked) || []),
    });
  });

  world.players.forEach((player, i) => {
    const start = map.starts[i % map.starts.length];
    seedForces(world, player, start, playerConfigs[i].start);
  });

  // Scenery, from the placement data the map generator produced. Spawned
  // after the players so their opening forces win any contested cell — a
  // Collector welded inside a tower block is a worse bug than a missing tree.
  for (const p of map.props) spawnProp(world, p.defId, p.cx, p.cy);

  // Gateways bind after the scenery, because a gateway anchored to a landmark
  // cannot find that landmark until the landmark is an entity. This is also
  // what stands the Robot Marine in the castle doorway.
  if (world.gateways.length) initGateways(world);

  world.players.forEach((p) => recomputePower(world, p));
  world.players.forEach((p) => updateVision(world, p));
  return world;
}

/**
 * Place a player's opening forces.
 *
 * Defaults to the standard skirmish opening — Command Rig, collectors, faction
 * escort. A mission overrides any part of it: `base: false` for a mission that
 * starts with no economy at all, an explicit `units` list, extra completed
 * structures, named `heroes`.
 */
function seedForces(world, player, start, setup = {}) {
  const faction = FACTIONS[player.faction];
  const wantsBase = setup.base !== false;

  // Steps around a ring of fixed angular stride. The cos/sin come from a baked
  // table rather than Math, so spawn positions are identical on every engine —
  // see numeric.js. The arithmetic is unchanged, so are the positions.
  let step = 0;
  const ring = (radius) => {
    step += 1;
    const off = ringOffset(step, radius);
    return { x: start.x + off.x, y: start.y + off.y };
  };

  if (wantsBase) {
    spawnBuilding(world, 'command', player.id, start.x - 1, start.y - 1, { complete: true });
  }

  for (const defId of setup.buildings || []) {
    const spot = freeBuildSpot(world, player, defId, start);
    if (spot) spawnBuilding(world, defId, player.id, spot.x, spot.y, { complete: true });
  }

  // Structures placed complete have already granted their tech; anything a
  // mission wants to hand over without a building goes here.
  for (const id of setup.tech || []) player.tech.add(id);

  const collectors = setup.collectors === undefined ? (wantsBase ? START.collectors : 0) : setup.collectors;
  for (let i = 0; i < collectors; i++) {
    const p = ring(3.2);
    spawnUnit(world, 'collector', player.id, p.x, p.y);
  }

  const units = setup.units || faction.startingUnits;
  for (const defId of units) {
    const p = ring(4.4);
    spawnUnit(world, defId, player.id, p.x, p.y);
  }

  // Heroes last, so they sit on the outside of the formation where they are
  // visible and the player can find them.
  for (const pilotId of setup.heroes || []) {
    const record = player.pilots.find((p) => p.id === pilotId);
    if (!record) continue;
    const p = ring(5.6);
    const unit = spawnUnit(world, record.chassis, player.id, p.x, p.y);
    makeHero(world, unit, { id: pilotId, name: record.name, level: record.level }, player.defs.abilities);
  }
}

/** First legal footprint near a start position, spiralling out. */
function freeBuildSpot(world, player, defId, start) {
  const def = player.defs.buildings[defId];
  if (!def) return null;
  for (let r = 3; r <= 10; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        const x = start.x + dx;
        const y = start.y + dy;
        if (canPlace(world.map, def.size, x, y)) return { x, y };
      }
    }
  }
  return null;
}

/* -------------------------------------------------------------- commands -- */

/**
 * Apply one command. Invalid commands are ignored rather than thrown —
 * a command stream arriving over a network is untrusted input, and the
 * simulation must never be crashable by it.
 */
export function applyCommand(world, cmd) {
  const player = world.players[cmd.player];
  if (!player || player.defeated) return;

  const owned = (ids) =>
    (ids || [])
      .map((id) => world.entities.get(id))
      .filter((e) => e && !e.dead && e.player === cmd.player);

  switch (cmd.type) {
    case 'move': {
      for (const e of owned(cmd.ids)) {
        if (e.kind !== 'unit') continue;
        const order = { type: 'move', x: cmd.x, y: cmd.y };
        assignOrder(world, e, order, cmd.queue);
      }
      break;
    }

    case 'attackMove': {
      for (const e of owned(cmd.ids)) {
        if (e.kind !== 'unit') continue;
        assignOrder(world, e, { type: 'attackMove', x: cmd.x, y: cmd.y }, cmd.queue);
      }
      break;
    }

    case 'attack': {
      const target = world.entities.get(cmd.targetId);
      if (!target || target.dead) break;
      for (const e of owned(cmd.ids)) {
        if (e.kind === 'building') {
          // Turrets can be told to prioritise, but never to move.
          e.targetId = target.id;
          e.targetForced = true;
          continue;
        }
        assignOrder(world, e, { type: 'attack', targetId: target.id }, cmd.queue);
      }
      break;
    }

    case 'harvest': {
      for (const e of owned(cmd.ids)) {
        if (!e.harvest) continue;
        const cell = { x: Math.floor(cmd.x), y: Math.floor(cmd.y) };
        e.harvest.cell = world.map.resource[cell.y * world.map.width + cell.x] > 0 ? cell : null;
        e.harvest.state = 'idle';
        assignOrder(world, e, { type: 'harvest' }, false);
      }
      break;
    }

    case 'stop': {
      for (const e of owned(cmd.ids)) {
        e.orderQueue.length = 0;
        e.order = null;
        e.targetId = null;
        e.targetForced = false;
        e.steer = null;
        clearPath(e);
        if (e.harvest) e.harvest.state = 'idle';
      }
      break;
    }

    /**
     * Direct control: drive a machine with the keyboard instead of ordering
     * it somewhere.
     *
     * Taking the sticks cancels the order queue, because a player holding a
     * direction and a unit still walking to a three-minute-old waypoint is
     * the kind of fight nobody wins. Auto-acquisition is left alone, so a
     * driven machine still shoots what wanders into range — which is the
     * whole appeal of piloting one.
     *
     * The vector persists on the entity until another steer command changes
     * it, so holding a key costs one command rather than twenty a second.
     */
    case 'steer': {
      const dx = Math.sign(cmd.dx || 0);
      const dy = Math.sign(cmd.dy || 0);
      for (const e of owned(cmd.ids)) {
        if (e.kind !== 'unit') continue;
        e.orderQueue.length = 0;
        e.order = null;
        e.targetForced = false;
        if (e.harvest) e.harvest.state = 'idle';
        setSteer(e, dx, dy);
      }
      break;
    }

    case 'hold': {
      for (const e of owned(cmd.ids)) {
        if (e.kind !== 'unit') continue;
        e.orderQueue.length = 0;
        e.steer = null;
        clearPath(e);
        e.order = { type: 'hold' };
      }
      break;
    }

    case 'ability': {
      // `slot` picks the chassis ability or the crew ability; an absent slot
      // means the chassis one, so every command recorded before heroes had a
      // second ability still replays correctly.
      const slot = cmd.slot === HERO_SLOT ? HERO_SLOT : CHASSIS_SLOT;
      for (const e of owned(cmd.ids)) {
        if (!e[slot]) continue;
        activateAbility(world, e, cmd.x ?? e.x, cmd.y ?? e.y, slot);
      }
      break;
    }

    case 'build': {
      placeStructure(world, cmd.player, cmd.defId, cmd.cx, cmd.cy);
      break;
    }

    case 'train': {
      const building = world.entities.get(cmd.buildingId);
      if (building && !building.dead && building.player === cmd.player) {
        enqueueUnit(world, building, cmd.defId);
      }
      break;
    }

    case 'cancelTrain': {
      const building = world.entities.get(cmd.buildingId);
      if (building && !building.dead && building.player === cmd.player) {
        cancelQueued(world, building, cmd.index);
      }
      break;
    }

    case 'sell': {
      for (const e of owned(cmd.ids)) {
        if (e.kind !== 'building') continue;
        // The last Command Rig is not sellable. Cashing out your own HQ by
        // accident is not a strategy, it is a misclick that ends the match.
        if (e.defId === 'command' && playerEntities(world, cmd.player, 'building')
          .filter((b) => b.defId === 'command').length <= 1) continue;
        sellBuilding(world, e);
      }
      break;
    }

    case 'repair': {
      for (const e of owned(cmd.ids)) {
        if (e.kind !== 'building' || e.constructing) continue;
        e.repairing = cmd.on === undefined ? !e.repairing : !!cmd.on;
      }
      break;
    }

    case 'superweapon': {
      const emitter = world.entities.get(cmd.buildingId);
      if (!emitter || emitter.dead || emitter.player !== cmd.player) break;
      fireSuperweapon(world, emitter, cmd.x, cmd.y);
      break;
    }

    case 'rally': {
      const building = world.entities.get(cmd.buildingId);
      if (building && !building.dead && building.player === cmd.player && building.def.rally) {
        building.rally = { x: cmd.x, y: cmd.y };
      }
      break;
    }

    default:
      break;
  }
}

/**
 * Start a structure. Returns the new entity, or null with the reason left
 * implicit — the UI checks legality before offering the click, so a rejection
 * here means a race or a hostile command stream.
 */
export function placeStructure(world, playerId, defId, cx, cy) {
  const player = world.players[playerId];
  const def = player && player.defs ? player.defs.buildings[defId] : BUILDINGS[defId];
  if (!def || !player) return null;
  if (!techAllows(world, playerId, defId)) return null;
  if (!canAfford(player, def.cost)) return null;
  if (!canPlace(world.map, def.size, cx, cy)) return null;
  if (!withinBuildRadius(world, playerId, def.size, cx, cy)) return null;

  spend(player, def.cost);
  const e = spawnBuilding(world, defId, playerId, cx, cy);
  player.stats.built++;
  return e;
}

/** Cells you may build in: near a Command Rig, or near anything already built. */
export const BUILD_RADIUS = 12;

export function withinBuildRadius(world, playerId, size, cx, cy) {
  const px = cx + size[0] / 2;
  const py = cy + size[1] / 2;
  for (const b of playerEntities(world, playerId, 'building')) {
    if (b.constructing) continue;
    const reach = b.defId === 'command' ? BUILD_RADIUS : BUILD_RADIUS * 0.7;
    if (len(b.x - px, b.y - py) <= reach) return true;
  }
  return false;
}

/**
 * Call in a superweapon strike.
 *
 * Deliberately not a projectile: it lands where it was aimed, a second later,
 * regardless of what moves in the meantime. A weapon that can be dodged by
 * walking is not a superweapon, and the telegraph is the counterplay — the
 * defender gets a warning and a second to scatter.
 */
export function fireSuperweapon(world, emitter, x, y) {
  const weapon = emitter.def.superweapon;
  if (!weapon || !superweaponReady(emitter)) return false;

  emitter.charge = 0;
  world.pendingStrikes.push({
    at: world.tick + TICKS_PER_SECOND,
    x,
    y,
    radius: weapon.radius,
    damage: weapon.damage,
    damageType: weapon.type,
    falloff: weapon.falloff,
    owner: emitter.id,
    player: emitter.player,
  });

  world.events.push({
    type: 'superweaponFired',
    id: emitter.id,
    player: emitter.player,
    x,
    y,
    radius: weapon.radius,
  });
  return true;
}

function resolveStrikes(world) {
  if (world.pendingStrikes.length === 0) return;
  const remaining = [];

  for (const strike of world.pendingStrikes) {
    if (world.tick < strike.at) {
      remaining.push(strike);
      continue;
    }

    for (const e of world.index.query(strike.x, strike.y, strike.radius + 2)) {
      if (e.dead) continue;
      const d = Math.max(0, len(e.x - strike.x, e.y - strike.y) - (e.radius || 0));
      if (d > strike.radius) continue;
      const scale = 1 - (d / strike.radius) * (1 - strike.falloff);
      applyDamage(world, e, strike.damage * scale, strike.damageType, strike.owner);
    }

    world.events.push({
      type: 'explosion',
      x: strike.x,
      y: strike.y,
      radius: strike.radius,
      big: true,
    });
  }

  world.pendingStrikes = remaining;
}

function assignOrder(world, e, order, queue) {
  if (queue) {
    e.orderQueue.push(order);
    if (e.order) return;
  } else {
    e.orderQueue.length = 0;
  }
  beginOrder(world, e, order);
}

function beginOrder(world, e, order) {
  e.order = order;
  e.targetId = null;
  e.targetForced = false;
  // An order always takes the machine back off direct control: clicking
  // somewhere is an unambiguous statement that you have let go of the sticks.
  e.steer = null;

  switch (order.type) {
    case 'move':
      if (!setPath(world, e, order.x, order.y)) e.order = null;
      break;
    case 'attackMove':
      setPath(world, e, order.x, order.y);
      break;
    case 'attack': {
      const target = world.entities.get(order.targetId);
      if (!target || target.dead) {
        e.order = null;
        break;
      }
      e.targetId = target.id;
      e.targetForced = true;
      break;
    }
    case 'harvest':
      clearPath(e);
      break;
    default:
      clearPath(e);
  }
}

function nextOrder(world, e) {
  e.order = null;
  clearPath(e);
  const next = e.orderQueue.shift();
  if (next) beginOrder(world, e, next);
  else if (e.harvest) e.harvest.state = e.harvest.state || 'idle';
}

/* ------------------------------------------------------------------ tick -- */

export function tick(world, commands = []) {
  if (world.over) return world;

  world.events = [];
  for (const cmd of commands) applyCommand(world, cmd);

  world.index = buildSpatialIndex(world);

  for (const player of world.players) recomputePower(world, player);

  // Structures: construction, then production, then upkeep.
  for (const e of world.entities.values()) {
    if (e.dead || e.kind !== 'building') continue;
    updateConstruction(world, e);
    updateProduction(world, e);
    updateRepair(world, e);
    updateSuperweapon(world, e);
  }

  // Units: abilities and shields before orders, so a leap ordered this tick
  // starts moving this tick.
  for (const e of world.entities.values()) {
    if (e.dead || e.kind !== 'unit') continue;
    updateAbilities(world, e, world.index);
    updateShield(world, e);
    updateSelfRepair(world, e);
    updateOrder(world, e);
  }

  for (const e of world.entities.values()) {
    if (e.dead || !e.weapons || e.weapons.length === 0) continue;
    updateWeapons(world, e, world.index);
  }

  updateProjectiles(world);
  resolveStrikes(world);
  reap(world);

  if (world.mission) deliverReinforcements(world);
  if (world.tick % REGROWTH.INTERVAL === 0) updateRegrowth(world);

  if (world.tick % VISION_INTERVAL === 0) {
    for (const player of world.players) updateVision(world, player);
  }

  // Gateways before objectives, so the tick a shaft is walked into is the tick
  // the mission that asked for it is won.
  if (world.gateways.length && world.tick % GATEWAY_INTERVAL === 0) updateGateways(world);
  if (world.mission && world.tick % OBJECTIVE_INTERVAL === 0) checkObjectives(world);
  if (world.tick % 20 === 0) checkVictory(world);

  world.effects = world.effects.filter((fx) => fx.until > world.tick);
  world.tick++;
  return world;
}

/**
 * Drive one unit's current order. Movement lives in movement.js; this decides
 * *where* and *whether*, never *how*.
 */
function updateOrder(world, e) {
  if (e.disabledUntil > world.tick && !e.leap) return;

  const order = e.order;

  if (e.harvest && !e.steer && (!order || order.type === 'harvest')) {
    updateHarvester(world, e);
    stepMovement(world, e, world.index);
    return;
  }

  if (!order) {
    // Idle: hold position, but keep any auto-acquired target for the weapons
    // pass. Idle units do not chase — that is what attack-move is for.
    stepMovement(world, e, world.index);
    return;
  }

  switch (order.type) {
    case 'move': {
      if (stepMovement(world, e, world.index) || e.path.length === 0) nextOrder(world, e);
      break;
    }

    case 'hold':
      break;

    case 'attack': {
      const target = world.entities.get(order.targetId);
      if (!target || target.dead) {
        nextOrder(world, e);
        break;
      }
      e.targetId = target.id;
      e.targetForced = true;
      pursue(world, e, target);
      break;
    }

    case 'attackMove': {
      // Engage anything seen on the way; resume the march once it is gone.
      let target = e.targetId ? world.entities.get(e.targetId) : null;
      if (!target || target.dead || target.player === e.player) {
        target = acquireTarget(world, e, world.index, e.def.sight);
        e.targetId = target ? target.id : null;
      }

      if (target) {
        pursue(world, e, target);
        break;
      }

      const remaining = len(e.x - order.x, e.y - order.y);
      if (remaining < 1.5) {
        nextOrder(world, e);
        break;
      }

      // Resume the march. This has to re-path unconditionally rather than only
      // when a previous goal survives: pursuing a target clears the path *and*
      // the goal, so a unit that killed something on the way would otherwise
      // find itself with no path, no goal, and no reason to keep walking — and
      // an army a-moved across the map would stop at the first scout it met.
      if (e.path.length === 0 && !setPath(world, e, order.x, order.y)) {
        nextOrder(world, e);
        break;
      }
      if (stepMovement(world, e, world.index)) nextOrder(world, e);
      break;
    }

    default:
      stepMovement(world, e, world.index);
  }
}

/** Close to weapon range and stop; re-path only when the target drifts. */
function pursue(world, e, target) {
  const reach = maxRange(e);
  const dist = rangeTo(e, target);

  if (dist <= reach * 0.85) {
    if (e.path.length) clearPath(e);
    e.facing = facingTo(target.x - e.x, target.y - e.y);
    return;
  }

  // Deployed siege has to pack up before it can chase anything.
  if (e.deployed) return;

  if (e.path.length === 0 || !e.pursuitAnchor || len(target.x - e.pursuitAnchor.x, target.y - e.pursuitAnchor.y) > 1.5) {
    e.pursuitAnchor = { x: target.x, y: target.y };
    setPath(world, e, target.x, target.y, { goalRadius: Math.max(1, reach * 0.8) });
  }
  stepMovement(world, e, world.index);
}

function reap(world) {
  for (const [id, e] of world.entities) {
    if (e.dead) world.entities.delete(id);
  }
}

/**
 * Mid-mission arrivals.
 *
 * A mission can schedule a pilot to turn up at a given tick — someone the
 * briefing never mentioned, walking out of the fog on your side. It is a
 * story beat before it is a mechanic: the campaign is about who is left, and
 * the drop scattered more people than the briefing knows about.
 *
 * Delivered from mission data on a tick comparison and nothing else, so it
 * replays and resumes exactly like the rest of the simulation. Arrivals land
 * near the player's landing zone rather than next to whatever they are
 * fighting; with the crew's Skyfall they can close that gap in one jump.
 */
function deliverReinforcements(world) {
  const scheduled = world.mission.reinforcements;
  if (!scheduled || scheduled.length === 0) return;

  for (let i = 0; i < scheduled.length; i++) {
    const drop = scheduled[i];
    if (world.tick < drop.at || world.reinforced.includes(i)) continue;
    world.reinforced.push(i);

    const player = world.players[drop.player || 0];
    if (!player || player.defeated) continue;
    const start = world.map.starts[player.id % world.map.starts.length];

    const arrivals = [];
    for (let n = 0; n < (drop.units || []).length; n++) {
      const off = ringOffset(n + 1, 3.4);
      const spot = nearestWalkable(world.map, Math.floor(start.x + off.x), Math.floor(start.y + off.y), 8);
      if (!spot) continue;
      arrivals.push(spawnUnit(world, drop.units[n], player.id, spot.x + 0.5, spot.y + 0.5));
    }

    if (drop.pilot) {
      const record = (player.pilots || []).find((p) => p.id === drop.pilot);
      const chassis = drop.chassis || (record && record.chassis);
      if (chassis) {
        const off = ringOffset(1, 5.2);
        const spot = nearestWalkable(world.map, Math.floor(start.x + off.x), Math.floor(start.y + off.y), 8);
        if (spot) {
          const unit = spawnUnit(world, chassis, player.id, spot.x + 0.5, spot.y + 0.5);
          makeHero(
            world,
            unit,
            { id: drop.pilot, name: drop.name || (record && record.name) || drop.pilot, level: (record && record.level) || 1 },
            player.defs.abilities
          );
          arrivals.push(unit);
        }
      }
    }

    if (arrivals.length === 0) continue;
    world.events.push({
      type: 'reinforcement',
      player: player.id,
      pilot: drop.pilot || null,
      name: drop.name || null,
      message: drop.message || null,
      ids: arrivals.map((e) => e.id),
      x: arrivals[0].x,
      y: arrivals[0].y,
    });
  }
}

/**
 * Campaign scoring. Objectives outrank annihilation: a mission is won when its
 * objectives say so, not when the map is clear, and it can be lost with an
 * army still standing.
 */
function checkObjectives(world) {
  const { changed, won, lost } = evaluateObjectives(world, world.objectives);

  for (const o of changed) {
    world.events.push({
      type: o.failed ? 'objectiveFailed' : 'objectiveComplete',
      key: o.key,
      optional: o.optional,
    });
  }

  if (lost && !world.over) endMission(world, 'lost');
  else if (won && !world.over) endMission(world, 'won');
}

function endMission(world, result) {
  world.over = true;
  world.result = result;
  world.winner = result === 'won' ? 0 : 1;
  world.events.push({ type: 'missionEnd', result });
}

function checkVictory(world) {
  let alive = 0;
  let lastAlive = null;

  for (const player of world.players) {
    if (player.defeated) continue;
    const has = playerEntities(world, player.id).length > 0;
    if (!has) {
      player.defeated = true;
      world.events.push({ type: 'defeated', player: player.id });
      continue;
    }
    alive++;
    lastAlive = player;
  }

  if (world.over) return;

  // In a mission, being wiped out is a loss even if an objective is still
  // technically achievable, and surviving alone is not automatically a win —
  // the objective list decides that.
  if (world.mission) {
    if (world.players[0].defeated) endMission(world, 'lost');
    return;
  }

  if (alive <= 1) {
    world.over = true;
    world.winner = lastAlive ? lastAlive.id : null;
    world.events.push({ type: 'gameOver', winner: world.winner });
  }
}

/* --------------------------------------------------------------- helpers -- */

/** Units a player may currently see, for the renderer and the AI alike. */
export function visibleTo(world, playerId) {
  const out = [];
  for (const e of world.entities.values()) {
    if (e.dead) continue;
    if (e.player === playerId || isVisible(world, playerId, e.x, e.y)) out.push(e);
  }
  return out;
}

/** A free tile near a point, for spawning and rally fallbacks. */
export function freeSpotNear(world, x, y) {
  const cell = nearestWalkable(world.map, Math.floor(x), Math.floor(y), 10);
  return cell ? { x: cell.x + 0.5, y: cell.y + 0.5 } : { x, y };
}

export { UNITS, BUILDINGS, FACTIONS, TERRAIN };
