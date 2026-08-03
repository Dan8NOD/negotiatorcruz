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

import { BUILDINGS, UNITS, FACTIONS, START, TICKS_PER_SECOND, TERRAIN } from './content.js';
import { createRng } from './rng.js';
import { createMap, canPlace, nearestWalkable } from './grid.js';
import {
  spawnUnit,
  spawnBuilding,
  buildSpatialIndex,
  rangeTo,
  playerEntities,
} from './entities.js';
import { setPath, clearPath, stepMovement } from './movement.js';
import { updateWeapons, updateProjectiles, maxRange, acquireTarget } from './combat.js';
import { updateAbilities, updateShield, activateAbility } from './abilities.js';
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
} from './economy.js';
import { createVision, updateVision, VISION_INTERVAL, isVisible } from './vision.js';

export { TICKS_PER_SECOND };

/* ---------------------------------------------------------------- setup -- */

/**
 * @param {object} options
 * @param {number} options.seed
 * @param {Array<{faction: string, name?: string, isAI?: boolean, difficulty?: string}>} options.players
 */
export function createWorld({ seed = 1, players: playerConfigs, mapSize = 72 } = {}) {
  const map = createMap(seed, { width: mapSize, height: mapSize });

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
  };

  playerConfigs.forEach((cfg, i) => {
    world.players.push({
      id: i,
      name: cfg.name || FACTIONS[cfg.faction].name,
      faction: cfg.faction,
      isAI: !!cfg.isAI,
      difficulty: cfg.difficulty || 'normal',
      scrap: START.scrap,
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
    });
  });

  world.players.forEach((player, i) => {
    const start = map.starts[i % map.starts.length];
    seedBase(world, player, start);
  });

  world.players.forEach((p) => recomputePower(world, p));
  world.players.forEach((p) => updateVision(world, p));
  return world;
}

/** Command Rig, starting collectors, and the faction's opening escort. */
function seedBase(world, player, start) {
  const cx = start.x - 1;
  const cy = start.y - 1;
  spawnBuilding(world, 'command', player.id, cx, cy, { complete: true });

  const faction = FACTIONS[player.faction];
  let angle = 0;
  const ring = (radius) => {
    angle += 1.1;
    return { x: start.x + Math.cos(angle) * radius, y: start.y + Math.sin(angle) * radius };
  };

  for (let i = 0; i < START.collectors; i++) {
    const p = ring(3.2);
    spawnUnit(world, 'collector', player.id, p.x, p.y);
  }
  for (const defId of faction.startingUnits) {
    const p = ring(4.4);
    spawnUnit(world, defId, player.id, p.x, p.y);
  }
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
        clearPath(e);
        if (e.harvest) e.harvest.state = 'idle';
      }
      break;
    }

    case 'hold': {
      for (const e of owned(cmd.ids)) {
        if (e.kind !== 'unit') continue;
        e.orderQueue.length = 0;
        clearPath(e);
        e.order = { type: 'hold' };
      }
      break;
    }

    case 'ability': {
      for (const e of owned(cmd.ids)) {
        if (!e.ability) continue;
        activateAbility(world, e, cmd.x ?? e.x, cmd.y ?? e.y);
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
  const def = BUILDINGS[defId];
  const player = world.players[playerId];
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
    if (Math.hypot(b.x - px, b.y - py) <= reach) return true;
  }
  return false;
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

  // Structures: construction, then production.
  for (const e of world.entities.values()) {
    if (e.dead || e.kind !== 'building') continue;
    updateConstruction(world, e);
    updateProduction(world, e);
  }

  // Units: abilities and shields before orders, so a leap ordered this tick
  // starts moving this tick.
  for (const e of world.entities.values()) {
    if (e.dead || e.kind !== 'unit') continue;
    updateAbilities(world, e, world.index);
    updateShield(world, e);
    updateOrder(world, e);
  }

  for (const e of world.entities.values()) {
    if (e.dead || !e.weapons || e.weapons.length === 0) continue;
    updateWeapons(world, e, world.index);
  }

  updateProjectiles(world);
  reap(world);

  if (world.tick % VISION_INTERVAL === 0) {
    for (const player of world.players) updateVision(world, player);
  }

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

  if (e.harvest && (!order || order.type === 'harvest')) {
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
      } else {
        if (e.path.length === 0 && e.pathGoal) {
          const d = Math.hypot(e.x - order.x, e.y - order.y);
          if (d < 1.5) {
            nextOrder(world, e);
            break;
          }
          setPath(world, e, order.x, order.y);
        }
        if (stepMovement(world, e, world.index) || e.path.length === 0) nextOrder(world, e);
      }
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
    e.facing = Math.atan2(target.y - e.y, target.x - e.x);
    return;
  }

  // Deployed siege has to pack up before it can chase anything.
  if (e.deployed) return;

  if (e.path.length === 0 || !e.pursuitAnchor || Math.hypot(target.x - e.pursuitAnchor.x, target.y - e.pursuitAnchor.y) > 1.5) {
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
