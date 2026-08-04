/**
 * Movement: path following, local avoidance, and jump-jet leaps.
 *
 * Ground units get A* waypoints plus cheap steering. Air units get a straight
 * line and no opinions about terrain. Leaping units are briefly neither —
 * they are interpolating along an arc with collision switched off, which is
 * the entire reason jump jets feel good.
 */

import { TICKS_PER_SECOND } from './content.js';
import { findPath, smoothPath, isWalkable, nearestWalkable, moveCost } from './grid.js';
import { len, facingTo, arcHeight } from './numeric.js';

/** How close to a waypoint counts as arriving. */
const WAYPOINT_EPS = 0.45;
/** How close to the final destination counts as done. */
const ARRIVE_EPS = 0.35;
/** Ticks of no progress before a unit gives up and asks A* again. */
const STUCK_LIMIT = 14;

/**
 * Plan a route. Ground units path on the grid; air units store the goal and
 * fly at it. Returns false when no route exists at all.
 */
export function setPath(world, e, gx, gy, { goalRadius = 0 } = {}) {
  e.pathGoal = { x: gx, y: gy, goalRadius };
  e.stuckTicks = 0;

  if (e.layer === 'air') {
    e.path = [{ x: Math.floor(gx), y: Math.floor(gy) }];
    return true;
  }

  let tx = Math.floor(gx);
  let ty = Math.floor(gy);

  // Snap onto something standable, but only when we need an exact arrival —
  // a goalRadius order is already allowed to stop short.
  if (goalRadius <= 0 && !isWalkable(world.map, tx, ty)) {
    const near = nearestWalkable(world.map, tx, ty, 10);
    if (!near) {
      e.path = [];
      return false;
    }
    tx = near.x;
    ty = near.y;
    e.pathGoal = { x: tx + 0.5, y: ty + 0.5, goalRadius };
  }

  const raw = findPath(world.map, Math.floor(e.x), Math.floor(e.y), tx, ty, { goalRadius });
  if (!raw) {
    e.path = [];
    return false;
  }
  e.path = smoothPath(world.map, Math.floor(e.x), Math.floor(e.y), raw);
  return true;
}

export function clearPath(e) {
  e.path = [];
  e.pathGoal = null;
  e.stuckTicks = 0;
  e.vx = 0;
  e.vy = 0;
}

/** Effective speed in cells per tick, after buffs, deploy state and EMP. */
export function currentSpeed(world, e) {
  if (e.disabledUntil > world.tick) return 0;
  if (e.deployed || e.deployTimer > 0) return 0;
  const mul = e.speedMulUntil > world.tick ? e.speedMul : 1;
  return (e.def.speed * mul) / TICKS_PER_SECOND;
}

/** True once the unit has nothing left to walk toward. */
export function hasArrived(e) {
  return e.path.length === 0;
}

/**
 * Advance one unit by one tick. Returns true if it reached its destination
 * this tick, so the order layer can retire the order.
 */
export function stepMovement(world, e, index) {
  if (e.leap) return stepLeap(world, e);
  if (e.path.length === 0) return false;

  const speed = currentSpeed(world, e);
  if (speed <= 0) return false;

  const wp = e.path[0];
  const last = e.path.length === 1;
  // Aim at cell centres. On an exact-arrival order the final waypoint aims at
  // the true goal instead, so units do not visibly snap to a grid at the end
  // of every move — but a goalRadius order must NOT do that, because its goal
  // is deliberately somewhere the unit cannot stand (a building, a wreck
  // field). Walking at it would just grind against the obstacle.
  const exact = last && e.pathGoal && !(e.pathGoal.goalRadius > 0);
  const tx = exact ? e.pathGoal.x : wp.x + 0.5;
  const ty = exact ? e.pathGoal.y : wp.y + 0.5;

  let dx = tx - e.x;
  let dy = ty - e.y;
  const dist = len(dx, dy);

  const eps = last ? ARRIVE_EPS : WAYPOINT_EPS;
  if (dist <= eps) {
    e.path.shift();
    if (e.path.length === 0) {
      e.vx = 0;
      e.vy = 0;
      return true;
    }
    return false;
  }

  dx /= dist;
  dy /= dist;

  // Local avoidance. Without it, twenty mechs ordered to one point become one
  // mech-shaped pile; with it they spread into something like a formation.
  const push = separation(world, e, index);
  let mx = dx + push.x;
  let my = dy + push.y;
  const mlen = len(mx, my) || 1;
  mx = (mx / mlen) * speed;
  my = (my / mlen) * speed;

  const before = { x: e.x, y: e.y };
  moveWithSlide(world, e, mx, my);

  e.facing = facingTo(mx, my);
  e.vx = e.x - before.x;
  e.vy = e.y - before.y;

  // Progress check: hemmed in by other units or a structure built across the
  // route. Re-plan rather than grinding against the obstacle forever.
  if (len(e.vx, e.vy) < speed * 0.25) {
    if (++e.stuckTicks > STUCK_LIMIT) {
      e.stuckTicks = 0;
      if (e.pathGoal) {
        const ok = setPath(world, e, e.pathGoal.x, e.pathGoal.y, {
          goalRadius: e.pathGoal.goalRadius,
        });
        if (!ok) {
          clearPath(e);
          return true;
        }
      }
    }
  } else {
    e.stuckTicks = 0;
  }

  return false;
}

/**
 * Steering push away from neighbours. Air and ground do not collide with each
 * other, so an air unit hovering over a mech is fine.
 */
function separation(world, e, index) {
  let px = 0;
  let py = 0;
  const neighbours = index.query(e.x, e.y, 1.6);

  for (const other of neighbours) {
    if (other === e || other.dead || other.kind === 'building') continue;
    if (other.layer !== e.layer) continue;
    const dx = e.x - other.x;
    const dy = e.y - other.y;
    const d = len(dx, dy);
    const minDist = e.radius + other.radius;
    if (d >= minDist || d === 0) continue;
    const strength = (minDist - d) / minDist;
    px += (dx / d) * strength;
    py += (dy / d) * strength;
  }

  // Capped so avoidance nudges a unit sideways rather than reversing it.
  const push = len(px, py);
  const max = 0.85;
  if (push > max) {
    px = (px / push) * max;
    py = (py / push) * max;
  }
  return { x: px, y: py };
}

/**
 * Move, sliding along whichever axis is still clear. Air ignores terrain.
 */
function moveWithSlide(world, e, mx, my) {
  if (e.layer === 'air') {
    e.x += mx;
    e.y += my;
    return;
  }

  // Escape hatch. A unit can end up inside a solid cell — a structure went up
  // on top of it, or a jump landed badly. From in there every candidate step
  // is rejected and it is entombed forever, so while it is already illegally
  // placed, let it move unconditionally until it is out.
  if (!canStand(world, e.x, e.y)) {
    e.x += mx;
    e.y += my;
    return;
  }

  if (canStand(world, e.x + mx, e.y + my)) {
    e.x += mx;
    e.y += my;
    return;
  }
  if (canStand(world, e.x + mx, e.y)) {
    e.x += mx;
    return;
  }
  if (canStand(world, e.x, e.y + my)) {
    e.y += my;
  }
}

function canStand(world, x, y) {
  return isFinite(moveCost(world.map, Math.floor(x), Math.floor(y)));
}

/* ----------------------------------------------------------------- leap -- */

/**
 * Jump jets. The unit follows a parabola to a fixed landing point with
 * terrain and unit collision disabled, then lands — even on a cell it could
 * never have walked to, which is the whole tactical point.
 */
export function beginLeap(world, e, tx, ty, duration) {
  e.leap = {
    fromX: e.x,
    fromY: e.y,
    toX: tx,
    toY: ty,
    started: world.tick,
    duration,
  };
  e.path = [];
  e.pathGoal = null;
  e.facing = facingTo(tx - e.x, ty - e.y);
  world.events.push({ type: 'leapStart', id: e.id, x: e.x, y: e.y, tx, ty });
}

function stepLeap(world, e) {
  const leap = e.leap;
  const t = (world.tick - leap.started) / leap.duration;

  if (t >= 1) {
    e.x = leap.toX;
    e.y = leap.toY;
    e.leap = null;
    // Landing inside a structure would trap the unit; nudge it clear.
    if (e.layer === 'ground' && !canStand(world, e.x, e.y)) {
      const near = nearestWalkable(world.map, Math.floor(e.x), Math.floor(e.y), 8);
      if (near) {
        e.x = near.x + 0.5;
        e.y = near.y + 0.5;
      }
    }
    world.events.push({ type: 'leapEnd', id: e.id, x: e.x, y: e.y });
    return true;
  }

  e.x = leap.fromX + (leap.toX - leap.fromX) * t;
  e.y = leap.fromY + (leap.toY - leap.fromY) * t;
  /** Purely cosmetic; the renderer lifts the sprite by this much. */
  e.leapHeight = arcHeight(t);
  return false;
}
