/**
 * Economy: power, construction, production queues and scrap harvesting.
 *
 * Power is the Red Alert inheritance and it is deliberately punishing. Draw
 * more than you generate and every factory slows down *and* every turret goes
 * quiet — so a raid that kills two reactors has disabled the defences it is
 * about to walk past. Reactors being the cheapest structure in the game is the
 * counterweight; forgetting to build them is a choice, not a trap.
 */

import {
  BUILDINGS,
  UNITS,
  TICKS_PER_SECOND,
  SELL_REFUND,
  REPAIR,
  REGROWTH,
} from './content.js';
import {
  spawnUnit,
  onBuildingComplete,
  exitPoint,
  playerEntities,
  defsFor,
  killEntity,
} from './entities.js';
import { setPath } from './movement.js';
import { inBounds } from './grid.js';
import { len } from './numeric.js';

/** A brownout never stops production dead — it grinds. */
const MIN_PRODUCTION_RATE = 0.25;

/**
 * How close a Collector must get to count as "at the field" / "at the depot".
 *
 * These must stay comfortably larger than the `goalRadius` the corresponding
 * A* call uses. If the pathfinder is satisfied at a distance the arrival check
 * still rejects, the collector arrives, decides it has not arrived, re-paths,
 * is told it is already there — and mines nothing, forever.
 */
const FIELD_REACH = 2.0;
const FIELD_GOAL_RADIUS = 1.0;
const DEPOT_REACH = 1.8;

/* ---------------------------------------------------------------- power -- */

export function recomputePower(world, player) {
  let made = 0;
  let used = 0;

  for (const e of world.entities.values()) {
    if (e.dead || e.player !== player.id || e.kind !== 'building') continue;
    // Sites under construction neither generate nor draw.
    if (e.constructing) continue;
    const p = e.def.power || 0;
    if (p > 0) made += p;
    else used += -p;
  }

  player.powerMade = made;
  player.powerUsed = used;
  player.powerRatio = used === 0 ? 1 : Math.min(1, made / used);

  const brownout = used > made;
  for (const e of world.entities.values()) {
    if (e.dead || e.player !== player.id || e.kind !== 'building') continue;
    e.powered = !(brownout && e.def.needsPower);
  }
}

/** Speed multiplier applied to every build and production timer. */
export function productionRate(player) {
  return Math.max(MIN_PRODUCTION_RATE, player.powerRatio);
}

/* --------------------------------------------------------- affordability -- */

export function canAfford(player, cost) {
  return player.scrap >= cost;
}

export function spend(player, cost) {
  player.scrap -= cost;
  player.scrapSpent += cost;
}

export function refund(player, cost) {
  player.scrap += cost;
  player.scrapSpent -= cost;
}

/**
 * Tech gate. A definition is buildable when the player owns every structure in
 * its `requires` list and has the tier unlocked.
 */
export function techAllows(world, playerId, defId) {
  const player = world.players[playerId];
  const defs = defsFor(world, playerId);
  const def = defs.buildings[defId] || defs.units[defId];
  if (!def) return false;

  // A mission may forbid part of the tree outright — a tutorial that hands you
  // three mechs should not also offer a Hangar.
  if (player.locked && player.locked.has(defId)) return false;

  if (def.requires) {
    for (const req of def.requires) if (!player.tech.has(req)) return false;
  }

  if (def.tier && def.tier > 1) {
    let unlocked = 1;
    for (const id of player.tech) {
      const b = defs.buildings[id];
      if (b && b.unlocksTier) unlocked = Math.max(unlocked, b.unlocksTier);
    }
    if (def.tier > unlocked) return false;
  }

  // A unit also needs somewhere to be built.
  if (def.builtAt && !player.tech.has(def.builtAt)) return false;

  // Faction rosters are exclusive; the collector is the shared exception.
  if (def.faction && def.faction !== player.faction) return false;

  return true;
}

/** Everything this player could legally start building right now. */
export function availableBuildings(world, playerId) {
  return Object.keys(defsFor(world, playerId).buildings).filter(
    (id) => id !== 'command' && techAllows(world, playerId, id)
  );
}

/* --------------------------------------------------------- construction -- */

export function updateConstruction(world, e) {
  if (!e.constructing) return;

  const player = world.players[e.player];
  e.buildProgress += productionRate(player);

  const t = Math.min(1, e.buildProgress / e.buildTime);
  // Hull rises with progress, so a site killed at 90% still cost the attacker
  // more than one killed at 10%.
  e.hp = Math.max(e.hp, Math.round(e.maxHp * (0.1 + 0.9 * t)));

  if (e.buildProgress >= e.buildTime) {
    e.constructing = false;
    e.hp = e.maxHp;
    e.buildProgress = e.buildTime;
    onBuildingComplete(world, e);
    recomputePower(world, player);
  }
}

/* ----------------------------------------------------------- production -- */

/**
 * Queue a unit. Scrap is taken up front and refunded in full on cancel —
 * partial refunds punish the player for reacting to new information, which is
 * exactly the behaviour an RTS wants to encourage.
 */
export function enqueueUnit(world, building, defId) {
  const def = defsFor(world, building.player).units[defId];
  const player = world.players[building.player];
  if (!def || !building.def.builds || building.constructing) return false;
  if (def.builtAt !== building.defId) return false;
  if (!techAllows(world, building.player, defId)) return false;
  if (!canAfford(player, def.cost)) return false;
  if (building.queue.length >= 8) return false;

  spend(player, def.cost);
  building.queue.push({ defId, remaining: def.buildTime, total: def.buildTime });
  return true;
}

export function cancelQueued(world, building, index) {
  const item = building.queue[index];
  if (!item) return false;
  building.queue.splice(index, 1);
  refund(world.players[building.player], defsFor(world, building.player).units[item.defId].cost);
  return true;
}

export function updateProduction(world, e) {
  if (e.constructing || e.queue.length === 0) return;

  const player = world.players[e.player];
  const item = e.queue[0];
  item.remaining -= productionRate(player);
  if (item.remaining > 0) return;

  e.queue.shift();
  const spot = exitPoint(world, e);
  const unit = spawnUnit(world, item.defId, e.player, spot.x, spot.y);

  if (e.rally) {
    setPath(world, unit, e.rally.x, e.rally.y);
    unit.order = { type: 'move', x: e.rally.x, y: e.rally.y };
  }
  world.events.push({ type: 'produced', id: unit.id, defId: item.defId, player: e.player });
}

/* ------------------------------------------------------------ harvesting -- */

/** Scrap remaining in a cell. */
export function resourceAt(map, cx, cy) {
  if (!inBounds(map, cx, cy)) return 0;
  return map.resource[cy * map.width + cx];
}

function drainResource(map, cx, cy, amount) {
  const i = cy * map.width + cx;
  const took = Math.min(map.resource[i], amount);
  map.resource[i] -= took;
  return took;
}

/** Nearest cell with scrap left, searched outward from a point. */
export function nearestResourceCell(map, x, y, maxRadius = 30) {
  const ox = Math.floor(x);
  const oy = Math.floor(y);
  let best = null;
  let bestD = Infinity;

  for (const field of map.fields) {
    for (const c of field.cells) {
      if (resourceAt(map, c.x, c.y) <= 0) continue;
      const d = len(c.x - ox, c.y - oy);
      if (d < bestD && d <= maxRadius) {
        bestD = d;
        best = c;
      }
    }
  }
  return best;
}

/** Nearest completed structure that accepts scrap. */
export function nearestDropOff(world, unit) {
  let best = null;
  let bestD = Infinity;
  for (const b of playerEntities(world, unit.player, 'building')) {
    if (!b.def.dropOff || b.constructing) continue;
    const d = len(b.x - unit.x, b.y - unit.y);
    if (d < bestD) {
      bestD = d;
      best = b;
    }
  }
  return best;
}

/**
 * Collector state machine: find scrap → walk to it → drain → walk home → repay.
 *
 * Collectors run themselves unless the player has said otherwise. Manual
 * micromanagement of harvesters is a chore, not a skill.
 */
export function updateHarvester(world, e) {
  if (!e.harvest || e.disabledUntil > world.tick) return;
  const h = e.harvest;

  switch (h.state) {
    case 'idle': {
      const cell = h.cell && resourceAt(world.map, h.cell.x, h.cell.y) > 0
        ? h.cell
        : nearestResourceCell(world.map, e.x, e.y);
      if (!cell) return;
      h.cell = cell;
      h.state = 'toField';
      h.attempts = 0;
      routeToField(world, e, cell);
      return;
    }

    case 'toField': {
      const d = len(e.x - (h.cell.x + 0.5), e.y - (h.cell.y + 0.5));
      if (d <= FIELD_REACH) {
        h.state = 'harvesting';
        e.path = [];
        return;
      }
      if (e.path.length > 0) return;

      // Out of path but not in reach: the route was blocked, or a structure
      // went up across it. Try once more, then write this cell off and let the
      // idle state pick a different one.
      if ((h.attempts = (h.attempts || 0) + 1) <= 2) {
        routeToField(world, e, h.cell);
        if (e.path.length > 0) return;
      }
      h.state = 'idle';
      h.cell = null;
      return;
    }

    case 'harvesting': {
      const perTick = e.def.harvestRate / TICKS_PER_SECOND;
      const got = drainResource(world.map, h.cell.x, h.cell.y, Math.min(perTick, e.def.capacity - e.cargo));
      e.cargo += got;

      if (got <= 0) {
        const next = nearestResourceCell(world.map, e.x, e.y);
        if (!next) {
          // Nothing left anywhere in reach; go bank what we have.
          h.state = e.cargo > 0 ? 'returning' : 'idle';
          h.cell = null;
          if (h.state === 'returning') routeHome(world, e);
          return;
        }
        h.cell = next;
        h.state = 'toField';
        h.attempts = 0;
        routeToField(world, e, next);
        return;
      }

      if (e.cargo >= e.def.capacity) {
        h.state = 'returning';
        routeHome(world, e);
      }
      return;
    }

    case 'returning': {
      let target = world.entities.get(h.homeId);
      if (!target || target.dead) {
        routeHome(world, e);
        target = world.entities.get(h.homeId);
      }
      // No depot standing anywhere: hold the cargo rather than spinning. It is
      // banked the moment the player rebuilds.
      if (!target) return;

      const d = Math.max(0, len(e.x - target.x, e.y - target.y) - target.radius);
      if (d <= DEPOT_REACH) {
        const player = world.players[e.player];
        player.scrap += Math.round(e.cargo);
        player.scrapMined += Math.round(e.cargo);
        world.events.push({ type: 'deposit', id: e.id, amount: Math.round(e.cargo) });
        e.cargo = 0;
        h.state = 'idle';
        e.path = [];
      } else if (e.path.length === 0) {
        routeHome(world, e);
      }
      return;
    }

    default:
      h.state = 'idle';
  }
}

/* --------------------------------------------- sell, repair, regrowth -- */

/**
 * Sell a structure for half its cost, scaled by how much of it is left.
 *
 * Red Alert refunds a flat half; scaling by remaining hull closes the obvious
 * exploit — letting a building get shot to bits and then cashing it out for
 * the same refund as an untouched one.
 */
export function sellBuilding(world, building) {
  if (!building || building.dead || building.kind !== 'building') return 0;
  const def = defsFor(world, building.player).buildings[building.defId];
  const standing = building.constructing
    ? building.buildProgress / building.buildTime
    : building.hp / building.maxHp;

  const refund = Math.round(def.cost * SELL_REFUND * standing);
  const player = world.players[building.player];
  player.scrap += refund;
  player.scrapSpent -= refund;

  world.events.push({
    type: 'sold',
    id: building.id,
    player: building.player,
    refund,
    x: building.x,
    y: building.y,
  });
  killEntity(world, building);
  return refund;
}

/**
 * Patch a structure up, paying as it goes. Repairing stops the moment the
 * player runs out of scrap rather than going into debt, and cancels itself at
 * full hull so the toggle never quietly drains an economy.
 */
export function updateRepair(world, e) {
  if (!e.repairing || e.constructing) return;
  if (e.hp >= e.maxHp) {
    e.repairing = false;
    return;
  }

  const def = defsFor(world, e.player).buildings[e.defId];
  const player = world.players[e.player];

  const perTick = (e.maxHp * REPAIR.RATE) / TICKS_PER_SECOND;
  const heal = Math.min(perTick, e.maxHp - e.hp);
  const price = (def.cost / e.maxHp) * heal * REPAIR.COST_RATIO;

  if (player.scrap < price) {
    e.repairing = false;
    world.events.push({ type: 'repairStalled', id: e.id, player: e.player });
    return;
  }

  player.scrap -= price;
  player.scrapSpent += price;
  e.hp = Math.min(e.maxHp, e.hp + heal);
}

/**
 * Charge a superweapon. Unpowered means unarmed, so the counter to a Lance is
 * the same as the counter to everything else in this game: kill the reactors.
 */
export function updateSuperweapon(world, e) {
  const weapon = e.def.superweapon;
  if (!weapon || e.constructing) return;
  if (e.def.needsPower && !e.powered) return;
  if (e.charge >= weapon.charge) return;

  e.charge = Math.min(weapon.charge, (e.charge || 0) + 1);
  if (e.charge >= weapon.charge) {
    world.events.push({ type: 'superweaponReady', id: e.id, player: e.player });
  }
}

export function superweaponReady(e) {
  const weapon = e.def && e.def.superweapon;
  return !!weapon && !e.constructing && e.charge >= weapon.charge && (!e.def.needsPower || e.powered);
}

/**
 * Wreck fields recover slowly, the way Red Alert's ore does.
 *
 * A depleted cell only regrows if a neighbour still has something in it, so a
 * field that is completely stripped stays dead and expanding remains the right
 * move. Iteration is in index order with no randomness, so this is as
 * deterministic as everything else in the engine.
 */
export function updateRegrowth(world) {
  const { map } = world;

  for (const field of map.fields) {
    for (const cell of field.cells) {
      const i = cell.y * map.width + cell.x;
      const cap = map.resourceMax[i];
      if (cap === 0) continue;

      const current = map.resource[i];
      if (current >= cap) continue;

      if (current > 0) {
        map.resource[i] = Math.min(cap, current + REGROWTH.AMOUNT);
        continue;
      }

      // Empty: only comes back if something next to it survived.
      let seeded = false;
      for (let dy = -1; dy <= 1 && !seeded; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue;
          const nx = cell.x + dx;
          const ny = cell.y + dy;
          if (nx < 0 || ny < 0 || nx >= map.width || ny >= map.height) continue;
          if (map.resource[ny * map.width + nx] > 0) {
            seeded = true;
            break;
          }
        }
      }
      if (seeded) map.resource[i] = Math.min(cap, REGROWTH.SEED_AMOUNT);
    }
  }
}

function routeToField(world, e, cell) {
  setPath(world, e, cell.x + 0.5, cell.y + 0.5, { goalRadius: FIELD_GOAL_RADIUS });
}

function routeHome(world, e) {
  const home = nearestDropOff(world, e);
  if (!home) {
    e.harvest.homeId = null;
    return;
  }
  e.harvest.homeId = home.id;
  // Stop short of the footprint — the depot's centre is inside a solid
  // building and no ground unit can path onto it.
  setPath(world, e, home.x, home.y, { goalRadius: home.radius + 0.8 });
}
