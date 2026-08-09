/**
 * Gateways — the ways off a map.
 *
 * Two of them exist, and they are the same idea twice:
 *
 *   Knock down the **headquarters** and the shaft it was built over is
 *   uncovered. Walk into it and you are in the Undercroft.
 *
 *   Kill the **Robot Marine** standing in front of the castle and the great
 *   door grinds open. Walk through it and you are in the Iron Keep.
 *
 * Both are one record: *something anchors it, something else has to die, and
 * then it is a way out*. Writing it once means the second one cost a mission
 * file rather than a system, and a third — a sealed hangar, a lift shaft, a
 * bridge with a bridgekeeper — costs the same.
 *
 * ## Why this is not scripting
 *
 * The campaign's rule is that missions are data: a new mission is written in
 * `campaign.js` and nowhere else. A per-mission hook that ran "when the HQ
 * dies, do this" would break that rule on its first use, and the second
 * challenge would have bought a second hook.
 *
 * So a gateway is a small tagged record evaluated against world state, exactly
 * like an objective. It binds to entities once, watches a single id, and the
 * only thing it can do is open and be entered. It cannot spawn arbitrary
 * things, cannot end the mission by itself, and cannot run code — the mission
 * ends because an `enter` objective completed, through the same path as every
 * other victory in the game.
 *
 * ## Determinism
 *
 * Binding happens once, at world creation, in mission order. Opening is a
 * comparison against a dead entity id. Entry is a radius test resolved to the
 * lowest entity id in range, so two engines that disagree about bucket order
 * still agree about who went through the door. Nothing here calls the RNG.
 */

import { GATEWAY_KINDS } from './content.js';
import { spawnGateway, spawnUnit } from './entities.js';
import { nearestWalkable } from './grid.js';
import { len } from './numeric.js';

/** How often entry is checked. Five ticks is a quarter-second, as objectives. */
export const GATEWAY_INTERVAL = 5;

/**
 * Every landmark a mission's gateways need, in declaration order.
 *
 * The map generator is told what to place from this rather than from a
 * separate list on the mission, so a gateway anchored to a castle can never
 * be written on a map that has no castle.
 */
export function gatewayLandmarks(mission) {
  const out = [];
  for (const g of (mission && mission.gateways) || []) {
    if (g.landmark && !out.includes(g.landmark)) out.push(g.landmark);
  }
  return out;
}

/** Normalise a mission's gateway records into watchable state. */
export function prepareGateways(mission) {
  return ((mission && mission.gateways) || []).map((g, i) => ({
    ...g,
    id: g.id || `gateway-${i}`,
    kind: GATEWAY_KINDS[g.kind] ? g.kind : 'shaft',
    /** Whose machines may go through. The player, in every mission so far. */
    player: g.player === undefined ? 0 : g.player,
    /** Entity whose death opens this. Zero until `initGateways` binds it. */
    keyId: 0,
    /** The landmark's own entity, kept so the renderer can dim it once open. */
    landmarkId: 0,
    open: false,
    entered: false,
    /** The marker entity, once there is one. */
    entityId: 0,
    x: 0,
    y: 0,
  }));
}

/**
 * Bind every gateway to the world it was written for, and place its guard.
 *
 * Called once, after the map's scenery exists — a gateway anchored to a
 * landmark cannot find that landmark until the landmark is an entity.
 */
export function initGateways(world) {
  for (const gateway of world.gateways) {
    const site = siteOf(world, gateway);
    if (!site) continue;

    gateway.x = site.x;
    gateway.y = site.y;
    gateway.landmarkId = site.landmarkId;

    // The guard, if this gateway has one. It stands in the doorway rather
    // than at the landmark's centre, because a door guard that spawned inside
    // the wall it is guarding is a door guard nobody can shoot.
    if (gateway.guard) {
      const guard = placeGuard(world, gateway, site);
      if (guard) gateway.keyId = guard.id;
    }

    // What has to die. A gateway with a guard defaults to the guard; one
    // without defaults to the landmark itself, which is the headquarters case
    // — the way down is *under* the building, so the building has to go.
    if (!gateway.keyId) gateway.keyId = site.landmarkId;
  }
}

/**
 * Where a gateway sits, and what it is anchored to.
 *
 * A door uses the landmark's own `door` offset, so the wall the renderer
 * draws the door in and the cell the gateway opens on are the same fact read
 * twice rather than two numbers that can drift apart.
 */
function siteOf(world, gateway) {
  const placement = world.map.landmarks[gateway.landmark];
  if (!placement) return null;

  const [w, h] = placement.size;
  let landmarkId = 0;
  for (const e of world.entities.values()) {
    if (e.kind === 'prop' && e.defId === gateway.landmark && e.cx === placement.cx) {
      landmarkId = e.id;
      break;
    }
  }

  const def = landmarkId ? world.entities.get(landmarkId).def : null;
  const door = gateway.door || (def && def.door);
  if (door) {
    return { x: placement.cx + door[0] + 0.5, y: placement.cy + door[1] + 0.5, landmarkId };
  }
  return { x: placement.cx + w / 2, y: placement.cy + h / 2, landmarkId };
}

/** Stand the guard in front of the door, on ground it can actually occupy. */
function placeGuard(world, gateway, site) {
  const player = world.players[gateway.guard.player === undefined ? 1 : gateway.guard.player];
  if (!player) return null;

  const spot = nearestWalkable(world.map, Math.floor(site.x), Math.floor(site.y), 10);
  if (!spot) return null;
  return spawnUnit(world, gateway.guard.defId, player.id, spot.x + 0.5, spot.y + 0.5);
}

/**
 * One evaluation step: open what has been unlocked, and notice who walks in.
 *
 * Both halves latch. A gateway that has opened stays open even if the enemy
 * rebuilds over it, and a gateway that has been entered is entered — the
 * mission is already ending, and a second entry event would pay the debrief
 * twice.
 */
export function updateGateways(world) {
  for (const gateway of world.gateways) {
    if (!gateway.open) {
      if (!gateway.keyId) continue;
      const key = world.entities.get(gateway.keyId);
      // Gone from the map entirely, or dead and not yet reaped. Both mean the
      // player did the thing the challenge asked for.
      if (key && !key.dead) continue;

      gateway.open = true;
      const marker = spawnGateway(world, gateway, gateway.x, gateway.y);
      gateway.entityId = marker.id;
      continue;
    }

    if (gateway.entered) continue;
    const arrival = firstArrival(world, gateway);
    if (!arrival) continue;

    gateway.entered = true;
    // Where the mission is going, for the debrief screen. The simulation does
    // nothing with it — the `enter` objective is what ends the mission.
    world.exit = {
      gateway: gateway.id,
      to: gateway.to || null,
      name: gateway.name || GATEWAY_KINDS[gateway.kind].name,
      kind: gateway.kind,
    };
    world.events.push({
      type: 'gatewayEntered',
      gateway: gateway.id,
      to: gateway.to || null,
      name: world.exit.name,
      id: arrival.id,
      x: gateway.x,
      y: gateway.y,
    });
  }
}

/**
 * The lowest-id machine of the owning player standing in the gateway.
 *
 * Lowest id rather than "the first one the spatial index hands back": the
 * index buckets by position, so the order it returns two units standing on
 * the same cell is an implementation detail, and a replay that disagreed
 * about which machine went through would disagree about the event stream.
 */
function firstArrival(world, gateway) {
  const kind = GATEWAY_KINDS[gateway.kind];
  const reach = kind.radius;
  let found = null;

  const nearby = world.index
    ? world.index.query(gateway.x, gateway.y, reach + 1)
    : [...world.entities.values()];

  for (const e of nearby) {
    if (e.dead || e.kind !== 'unit' || e.player !== gateway.player) continue;
    if (len(e.x - gateway.x, e.y - gateway.y) > reach) continue;
    if (!found || e.id < found.id) found = e;
  }
  return found;
}

/** Look a gateway up by id — for objectives, the HUD and the debrief. */
export function gatewayById(world, id) {
  return world.gateways.find((g) => g.id === id) || null;
}

/** Gateways the viewing player can currently see a marker for. */
export function openGateways(world) {
  return world.gateways.filter((g) => g.open);
}
