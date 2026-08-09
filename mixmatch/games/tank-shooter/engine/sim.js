/**
 * NOD Tank Shooter — the simulation.
 *
 * No DOM, no canvas, no audio, no `Math.random`. The whole game runs here at a
 * fixed 60 Hz off a seed and a stream of inputs, which means the suite can play
 * a hundred waves in a few milliseconds and assert things no amount of manual
 * play would catch — that wave 12 is survivable, that a warden cannot be killed
 * from the front, that a run reproduces exactly from its seed.
 *
 * ## Why the input is a value rather than a callback
 *
 * `step(world, input)` takes the player's intent as a plain object: a movement
 * vector, an aim angle, and two booleans. Nothing in here reaches out for the
 * keyboard. That is what lets a test drive the tank, and it is also what would
 * let a replay be stored as a list of these — the same trick `rocketman` uses,
 * and the reason a disputed arcade run is answerable rather than arguable.
 *
 * ## Events
 *
 * The world narrates itself into `world.events`, cleared each step. The
 * renderer and (later) the sound layer are listeners on that stream and never
 * read state directly for anything transient. A hit that produces no event is a
 * hit the player cannot be told about.
 */

import { createRng } from './rng.js';
import {
  ARENA,
  TICKS_PER_SECOND,
  COVER,
  TANK,
  GUNS,
  STARTING_GUN,
  HOSTILES,
  WAVES,
  PICKUPS,
  unlockedAt,
  damageAgainst,
} from './content.js';

const DT = 1 / TICKS_PER_SECOND;
const TAU = Math.PI * 2;

/* ================================================================== geometry */

function wrapAngle(a) {
  while (a > Math.PI) a -= TAU;
  while (a < -Math.PI) a += TAU;
  return a;
}

/** Turn `from` toward `to`, at most `rate` radians. */
function turnToward(from, to, rate) {
  const delta = wrapAngle(to - from);
  if (Math.abs(delta) <= rate) return wrapAngle(to);
  return wrapAngle(from + Math.sign(delta) * rate);
}

function dist(ax, ay, bx, by) {
  const dx = ax - bx;
  const dy = ay - by;
  // sqrt of the sum, not Math.hypot: ECMA-262 leaves hypot
  // implementation-approximated, and this game's determinism claim is only
  // worth as much as its least specified operation. Same reasoning as
  // rocketman/engine/numeric.js, which found the two disagree 37.9% of the
  // time by one ulp.
  return Math.sqrt(dx * dx + dy * dy);
}

/** Does a segment from (x1,y1) to (x2,y2) cross any cover block? */
function blocked(world, x1, y1, x2, y2) {
  for (const c of world.cover) {
    if (segmentHitsRect(x1, y1, x2, y2, c)) return true;
  }
  return false;
}

/**
 * Segment/rectangle intersection, slab method.
 *
 * Used for the gunhead's line of sight, so it must be *cheap* — it runs once
 * per gunhead per shot opportunity — and it must agree with the renderer's idea
 * of where the walls are, which is why cover is axis-aligned rectangles and not
 * anything prettier.
 */
function segmentHitsRect(x1, y1, x2, y2, r) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  let t0 = 0;
  let t1 = 1;
  const p = [-dx, dx, -dy, dy];
  const q = [x1 - r.x, r.x + r.w - x1, y1 - r.y, r.y + r.h - y1];

  for (let i = 0; i < 4; i++) {
    if (p[i] === 0) {
      if (q[i] < 0) return false;
      continue;
    }
    const t = q[i] / p[i];
    if (p[i] < 0) {
      if (t > t1) return false;
      if (t > t0) t0 = t;
    } else {
      if (t < t0) return false;
      if (t < t1) t1 = t;
    }
  }
  return true;
}

/** Push a circle out of any cover it has entered. */
function resolveCover(world, body) {
  for (const c of world.cover) {
    const nx = Math.max(c.x, Math.min(body.x, c.x + c.w));
    const ny = Math.max(c.y, Math.min(body.y, c.y + c.h));
    const dx = body.x - nx;
    const dy = body.y - ny;
    const d = Math.sqrt(dx * dx + dy * dy);
    if (d >= body.radius) continue;
    if (d === 0) {
      // Dead centre of a block. Cannot normalise a zero vector, so eject along
      // whichever axis is the shorter way out — this happens when something
      // spawns badly, and silently teleporting it is better than dividing by
      // zero and putting a NaN into the world.
      const left = body.x - c.x;
      const right = c.x + c.w - body.x;
      const up = body.y - c.y;
      const down = c.y + c.h - body.y;
      const min = Math.min(left, right, up, down);
      if (min === left) body.x = c.x - body.radius;
      else if (min === right) body.x = c.x + c.w + body.radius;
      else if (min === up) body.y = c.y - body.radius;
      else body.y = c.y + c.h + body.radius;
      continue;
    }
    const push = (body.radius - d) / d;
    body.x += dx * push;
    body.y += dy * push;
  }
}

function clampToArena(body) {
  body.x = Math.max(body.radius, Math.min(ARENA.width - body.radius, body.x));
  body.y = Math.max(body.radius, Math.min(ARENA.height - body.radius, body.y));
}

/* ==================================================================== the map */

/**
 * Scatter cover, rejecting placements that overlap or crowd the spawn.
 *
 * Rejection sampling with a bounded attempt count rather than a clever packing:
 * it is a dozen rectangles, it runs once, and a generator that can loop forever
 * on an unlucky seed is a generator that will eventually hang a paid run.
 */
function generateCover(rng) {
  const blocks = [];
  const want = COVER.min + rng.int(COVER.max - COVER.min + 1);
  const cx = ARENA.width / 2;
  const cy = ARENA.height / 2;

  for (let attempt = 0; attempt < want * 40 && blocks.length < want; attempt++) {
    const w = Math.round(rng.range(COVER.size[0], COVER.size[1]));
    const h = Math.round(rng.range(COVER.size[0], COVER.size[1]));
    const x = Math.round(rng.range(COVER.edgeMargin, ARENA.width - COVER.edgeMargin - w));
    const y = Math.round(rng.range(COVER.edgeMargin, ARENA.height - COVER.edgeMargin - h));
    const block = { x, y, w, h };

    // Never on top of the player's spawn: opening a paid run already stuck
    // inside a wall is the worst first second the game could offer.
    if (x - 90 < cx && cx < x + w + 90 && y - 90 < cy && cy < y + h + 90) continue;

    const clash = blocks.some(
      (b) => x < b.x + b.w + 60 && b.x < x + w + 60 && y < b.y + b.h + 60 && b.y < y + h + 60
    );
    if (!clash) blocks.push(block);
  }
  return blocks;
}

/* ================================================================== the world */

/**
 * A fresh run.
 *
 * @param {{seed?: number}} [options]
 */
export function createWorld({ seed = 1 } = {}) {
  const rng = createRng(seed);
  const cover = generateCover(rng);

  const world = {
    seed,
    rng,
    tick: 0,
    over: false,
    /** 'playing' | 'dead'. Kept separate from `over` so the UI can hold a beat. */
    result: null,
    cover,

    tank: {
      x: ARENA.width / 2,
      y: ARENA.height / 2,
      vx: 0,
      vy: 0,
      hull: 0,
      turret: 0,
      radius: TANK.radius,
      health: TANK.maxHealth,
      gun: STARTING_GUN,
      cooldown: 0,
      invulnerable: 0,
      boostLeft: 0,
      boostCooldown: 0,
    },

    hostiles: [],
    shots: [],
    pickups: [],
    events: [],

    wave: 0,
    /** Seconds until the next wave. Starts short so a run opens quickly. */
    waveTimer: 1.2,
    /** Set while hostiles from the current wave remain. */
    waveActive: false,
    /** Seconds the current wave has been active. Drives the stall-breaker. */
    waveElapsed: 0,

    score: 0,
    kills: 0,
    shotsFired: 0,
    shotsHit: 0,
    nextId: 1,
  };

  return world;
}

/** The shape `step` expects. Every field optional; this is the zero input. */
export function noInput() {
  return { moveX: 0, moveY: 0, aim: 0, fire: false, boost: false };
}

/**
 * Advance one tick.
 *
 * @param {object} world
 * @param {{moveX: number, moveY: number, aim: number, fire: boolean, boost: boolean}} input
 */
export function step(world, input = noInput()) {
  world.events.length = 0;
  if (world.over) return world;

  world.tick++;
  stepTank(world, input);
  stepShots(world);
  stepHostiles(world);
  stepPickups(world);
  stepWaves(world);

  if (world.tank.health <= 0 && !world.over) {
    world.over = true;
    world.result = 'dead';
    world.events.push({ type: 'gameOver', score: world.score, wave: world.wave });
  }
  return world;
}

/* =================================================================== the tank */

function stepTank(world, input) {
  const t = world.tank;

  if (t.invulnerable > 0) t.invulnerable = Math.max(0, t.invulnerable - DT);
  if (t.cooldown > 0) t.cooldown = Math.max(0, t.cooldown - DT);
  if (t.boostCooldown > 0) t.boostCooldown = Math.max(0, t.boostCooldown - DT);

  // Normalise the stick, so a diagonal is not faster than a cardinal. On a
  // keyboard that is the difference between "hold two keys" being a strategy
  // and being a bug.
  let mx = input.moveX || 0;
  let my = input.moveY || 0;
  const mag = Math.sqrt(mx * mx + my * my);
  if (mag > 1) {
    mx /= mag;
    my /= mag;
  }

  if (input.boost && t.boostCooldown === 0 && (mx || my)) {
    t.boostLeft = TANK.boost.seconds;
    t.boostCooldown = TANK.boost.cooldown;
    t.invulnerable = Math.max(t.invulnerable, TANK.boost.invulnerable);
    world.events.push({ type: 'boost', x: t.x, y: t.y });
  }

  if (t.boostLeft > 0) {
    t.boostLeft = Math.max(0, t.boostLeft - DT);
    // A boost is a velocity, not an acceleration. Making it an acceleration
    // meant a tank already at speed got almost nothing from it, which is
    // exactly backwards — the burst has to be worth spending when you are
    // already committed to a direction.
    const heading = mx || my ? Math.atan2(my, mx) : t.hull;
    t.vx = Math.cos(heading) * TANK.boost.speed;
    t.vy = Math.sin(heading) * TANK.boost.speed;
  } else {
    t.vx += mx * TANK.accel * DT;
    t.vy += my * TANK.accel * DT;
    const drag = Math.max(0, 1 - TANK.friction * DT);
    t.vx *= drag;
    t.vy *= drag;
    const speed = Math.sqrt(t.vx * t.vx + t.vy * t.vy);
    if (speed > TANK.maxSpeed) {
      t.vx = (t.vx / speed) * TANK.maxSpeed;
      t.vy = (t.vy / speed) * TANK.maxSpeed;
    }
  }

  t.x += t.vx * DT;
  t.y += t.vy * DT;
  clampToArena(t);
  resolveCover(world, t);

  if (t.vx || t.vy) t.hull = turnToward(t.hull, Math.atan2(t.vy, t.vx), TANK.hullTurn * DT);
  t.turret = turnToward(t.turret, input.aim || 0, TANK.turretTurn * DT);

  if (input.fire && t.cooldown === 0) fire(world);
}

function fire(world) {
  const t = world.tank;
  const gun = GUNS[t.gun];
  t.cooldown = gun.cooldown;
  world.shotsFired += gun.pellets;

  for (let i = 0; i < gun.pellets; i++) {
    // Spread is seeded, so a scattergun pattern is part of the reproducible
    // run rather than a per-machine accident.
    const jitter = gun.spread ? world.rng.range(-gun.spread / 2, gun.spread / 2) : 0;
    const angle = t.turret + jitter;
    world.shots.push({
      id: world.nextId++,
      friendly: true,
      x: t.x + Math.cos(angle) * (t.radius + 4),
      y: t.y + Math.sin(angle) * (t.radius + 4),
      vx: Math.cos(angle) * gun.speed,
      vy: Math.sin(angle) * gun.speed,
      life: gun.life,
      radius: gun.radius,
      gun: t.gun,
      pierce: gun.pierce,
      // Allocated up front for piercing guns only, so the presence of the set
      // is what marks a round as "remembers what it has hit".
      hitIds: gun.pierce > 0 ? new Set() : null,
    });
  }
  world.events.push({ type: 'fire', gun: t.gun, x: t.x, y: t.y, angle: t.turret });
}

function hurtTank(world, amount, source) {
  const t = world.tank;
  if (t.invulnerable > 0 || t.health <= 0) return false;
  t.health = Math.max(0, t.health - amount);
  t.invulnerable = TANK.invulnerable;
  world.events.push({ type: 'tankHit', amount, health: t.health, source, x: t.x, y: t.y });
  return true;
}

/* ================================================================== the shots */

function stepShots(world) {
  const t = world.tank;

  for (let i = world.shots.length - 1; i >= 0; i--) {
    const s = world.shots[i];
    const px = s.x;
    const py = s.y;
    s.x += s.vx * DT;
    s.y += s.vy * DT;
    s.life -= DT;

    let dead = s.life <= 0;

    if (!dead && (s.x < 0 || s.y < 0 || s.x > ARENA.width || s.y > ARENA.height)) dead = true;
    // Against cover, test the segment travelled rather than the new point. A
    // 1150 px/s lance covers 19 px a tick and would otherwise tunnel through a
    // thin wall entirely.
    if (!dead && blocked(world, px, py, s.x, s.y)) {
      dead = true;
      world.events.push({ type: 'shotSpark', x: s.x, y: s.y });
    }

    if (!dead && s.friendly) dead = friendlyShotHits(world, s);
    else if (!dead && dist(s.x, s.y, t.x, t.y) < s.radius + t.radius) {
      if (hurtTank(world, s.damage, s.from)) dead = true;
      else dead = true;
    }

    if (dead) world.shots.splice(i, 1);
  }
}

function friendlyShotHits(world, s) {
  const gun = GUNS[s.gun];
  for (const h of world.hostiles) {
    if (h.health <= 0) continue;
    if (dist(s.x, s.y, h.x, h.y) > s.radius + h.radius) continue;
    // A piercing round must not hit the same hostile twice as it passes
    // through, and the guard has to survive the round running out of pierce.
    //
    // The bug this replaces keyed the check on `s.pierce > 0`, so the shot
    // that spent its last pierce stopped recording hits — then overlapped the
    // same hostile on the following tick, found no record of it, and hit it
    // again for double damage. Only the final target in a line was affected,
    // which is exactly the sort of thing that never gets noticed by playing.
    if (s.hitIds) {
      if (s.hitIds.has(h.id)) continue;
      s.hitIds.add(h.id);
    }

    const def = HOSTILES[h.type];
    const fromAngle = Math.atan2(s.y - h.y, s.x - h.x);
    const damage = damageAgainst(def, h.facing, fromAngle, gun);
    const shielded = damage < gun.damage;

    h.health -= damage;
    world.shotsHit++;

    if (gun.knockback) {
      const a = Math.atan2(h.y - s.y, h.x - s.x);
      h.vx += Math.cos(a) * gun.knockback;
      h.vy += Math.sin(a) * gun.knockback;
    }

    world.events.push({ type: 'hit', x: s.x, y: s.y, hostile: h.type, shielded, damage });

    if (h.health <= 0) killHostile(world, h);
    if (s.pierce > 0) {
      s.pierce--;
      continue;
    }
    return true;
  }
  return false;
}

function killHostile(world, h) {
  const def = HOSTILES[h.type];
  world.score += def.score;
  world.kills++;
  world.events.push({ type: 'kill', x: h.x, y: h.y, hostile: h.type, score: def.score });
}

/* ============================================================== the hostiles */

/**
 * How impatient the current wave has become, 0 to 1.
 *
 * See `WAVES.stallSeconds`. Zero for the whole of any wave that is going
 * normally, which is why this can afford to be as blunt as it is.
 */
function urgencyOf(world) {
  if (!world.waveActive) return 0;
  const over = world.waveElapsed - WAVES.stallSeconds;
  if (over <= 0) return 0;
  return Math.min(1, over / WAVES.stallRamp);
}

/** A hostile's movement, with urgency applied. */
function motionFor(def, urgency) {
  if (urgency === 0) return def;
  const scale = 1 + (WAVES.stallSpeedup - 1) * urgency;
  return { speed: def.speed * scale, accel: def.accel * scale };
}

function stepHostiles(world) {
  const t = world.tank;
  const urgency = urgencyOf(world);

  for (let i = world.hostiles.length - 1; i >= 0; i--) {
    const h = world.hostiles[i];
    if (h.health <= 0) {
      world.hostiles.splice(i, 1);
      continue;
    }
    const def = HOSTILES[h.type];
    if (h.cooldown > 0) h.cooldown -= DT;
    if (h.telegraph > 0) {
      h.telegraph -= DT;
      if (h.telegraph <= 0) releaseHostileShot(world, h, def);
    }

    const toTank = Math.atan2(t.y - h.y, t.x - h.x);
    const range = dist(h.x, h.y, t.x, t.y);

    switch (def.behaviour) {
      case 'charge':
      case 'advance':
        driveToward(world, h, def, toTank, motionFor(def, urgency));
        break;
      case 'turret': {
        // Stationary while it has a shot, crawling when it does not. See
        // `redeploy` in content.js for why an immobile version deadlocks.
        h.facing = turnToward(h.facing, toTank, 2.4 * DT);
        const canSee = range < def.range && !blocked(world, h.x, h.y, t.x, t.y);
        if (canSee) {
          h.idle = 0;
          if (h.cooldown <= 0 && h.telegraph <= 0) beginTelegraph(world, h, def);
        } else if (h.telegraph <= 0) {
          // Not while a shot is already in the pipe: a telegraph that moves is
          // a telegraph the player cannot read.
          h.idle += DT;
          // Urgency collapses the patience as well as raising the speed: a
          // stalled wave should not also wait out the redeploy delay.
          if (h.idle >= def.redeploy.after * (1 - urgency)) {
            driveToward(world, h, def, toTank, motionFor(def.redeploy, urgency));
          }
        }
        break;
      }
      case 'artillery': {
        h.facing = turnToward(h.facing, toTank, 2.0 * DT);
        const clear = !blocked(world, h.x, h.y, t.x, t.y);
        // Backs off if crowded, closes if too far. The standoff band is what
        // makes it a ranged problem you have to walk to rather than outrun.
        //
        // `!clear` closing is not a refinement — without it a lobber parks at
        // the far edge of its own band with a wall in the way and neither side
        // can reach the other for the rest of the run. Found by a bot that sat
        // at wave 3 for three minutes against a full-health lobber 754 units
        // away, both of them firing into the same block of cover.
        // Urgency shrinks the standoff to nothing, so a lobber that has been
        // holding the player at arm's length eventually has to come in.
        const standoff = def.standoff * (1 - urgency);
        if (range < standoff) driveToward(world, h, def, toTank + Math.PI, motionFor(def, urgency));
        else if (range > def.range || !clear) driveToward(world, h, def, toTank, motionFor(def, urgency));
        else decelerate(h, def);
        // Line of sight is required to fire, the same as the gunhead. Shots
        // are straight-line bodies that collide with cover, so a lobber
        // shooting through a wall only ever produces a shell that dies on the
        // near face of it — which reads as broken rather than as artillery.
        if (clear && range < def.range && h.cooldown <= 0 && h.telegraph <= 0) {
          beginTelegraph(world, h, def);
        }
        break;
      }
      case 'hive':
        // Drifts toward the middle rather than the player: a hive that closes
        // is a hive that dies to the same shots as its spawn, which removes
        // the target-priority question it exists to ask.
        // Under urgency a hive stops drifting to the middle and comes at the
        // player, because "shoot the right thing" stops being a fair question
        // once the wave has outstayed its welcome.
        driveToward(
          world, h, def,
          urgency > 0 ? toTank : Math.atan2(ARENA.height / 2 - h.y, ARENA.width / 2 - h.x),
          motionFor(def, urgency)
        );
        h.facing = toTank;
        h.spawnTimer -= DT;
        if (h.spawnTimer <= 0) {
          h.spawnTimer = def.spawn.every;
          const brood = world.hostiles.filter((o) => o.broodOf === h.id && o.health > 0).length;
          if (brood < def.spawn.cap && world.hostiles.length < WAVES.maxAlive) {
            const spawned = spawnHostile(world, def.spawn.of, h.x, h.y, world.rng.range(0, TAU));
            spawned.broodOf = h.id;
            world.events.push({ type: 'spawned', x: h.x, y: h.y, hostile: def.spawn.of });
          }
        }
        break;
      default:
        break;
    }

    h.x += h.vx * DT;
    h.y += h.vy * DT;
    const drag = Math.max(0, 1 - 5.5 * DT);
    h.vx *= drag;
    h.vy *= drag;
    clampToArena(h);
    resolveCover(world, h);

    if (def.contact && range < h.radius + t.radius) {
      if (hurtTank(world, def.damage, h.type)) {
        // A scuttler is a one-shot delivery mechanism and dies on impact. A
        // warden shoves and keeps walking, which is what makes it a wall.
        if (def.behaviour === 'charge') {
          h.health = 0;
          world.events.push({ type: 'kill', x: h.x, y: h.y, hostile: h.type, score: 0 });
        } else {
          const a = Math.atan2(t.y - h.y, t.x - h.x);
          world.tank.vx += Math.cos(a) * 260;
          world.tank.vy += Math.sin(a) * 260;
        }
      }
    }
  }
}

/**
 * The direction to actually drive, given the direction you want.
 *
 * Nothing in here pathfinds. Hostiles drove at the player in a straight line,
 * and a straight line into a block of cover is a hostile that pushes against a
 * wall until the run ends — except the run does not end, because the wave will
 * not advance while anything is alive. A 30-seed sweep found five runs that
 * never terminated at all, one of them stuck on wave 1 behind a single wall.
 *
 * So: probe the way ahead, and if it is blocked, take the nearest angle that
 * is not. Seven fixed probes in a fixed order, which is cheap enough to run
 * per hostile per tick and — being fixed — keeps the simulation deterministic.
 *
 * This is obstacle avoidance, not navigation. It rounds corners and follows
 * walls; it cannot solve a spiral. The arena has convex blocks with gaps
 * between them, so that is enough, and `COVER` keeps it that way by refusing
 * to place blocks closer than 60 units apart.
 */
const WHISKERS = [0, 0.45, -0.45, 0.9, -0.9, 1.4, -1.4];

function steerAngle(world, h, angle) {
  const reach = h.radius + 95;
  for (const offset of WHISKERS) {
    const a = angle + offset;
    if (!blocked(world, h.x, h.y, h.x + Math.cos(a) * reach, h.y + Math.sin(a) * reach)) return a;
  }
  // Boxed in on every probe. Keep the original heading rather than freezing:
  // resolveCover will slide it along the surface, which beats standing still.
  return angle;
}

/**
 * Accelerate toward `angle`, capped at a top speed, steering around cover.
 *
 * `motion` overrides the hostile's own speed and acceleration, which is how a
 * gunhead crawls while redeploying without becoming a different enemy.
 */
function driveToward(world, h, def, angle, motion = def) {
  angle = steerAngle(world, h, angle);
  h.vx += Math.cos(angle) * motion.accel * DT;
  h.vy += Math.sin(angle) * motion.accel * DT;
  const speed = Math.sqrt(h.vx * h.vx + h.vy * h.vy);
  if (speed > motion.speed) {
    h.vx = (h.vx / speed) * motion.speed;
    h.vy = (h.vy / speed) * motion.speed;
  }
  if (def.behaviour !== 'hive') h.facing = turnToward(h.facing, angle, 4.0 * DT);
}

function decelerate(h, def) {
  h.vx *= 0.86;
  h.vy *= 0.86;
}

function beginTelegraph(world, h, def) {
  h.telegraph = def.gun.telegraph;
  h.cooldown = def.gun.cooldown;
  world.events.push({ type: 'telegraph', x: h.x, y: h.y, hostile: h.type, seconds: h.telegraph });
}

/**
 * The telegraphed shot actually leaves.
 *
 * Aim is locked in *here*, at release, not when the telegraph began. Locking it
 * at the start would make the telegraph a free dodge for anyone who simply
 * walked sideways; locking it at release means the telegraph is a warning about
 * a shot that is still being aimed, which is the thing the player has to react
 * to rather than wait out.
 */
function releaseHostileShot(world, h, def) {
  const t = world.tank;
  let aim = Math.atan2(t.y - h.y, t.x - h.x);

  if (def.lead) {
    const flight = dist(h.x, h.y, t.x, t.y) / def.gun.speed;
    const px = t.x + t.vx * flight * def.lead;
    const py = t.y + t.vy * flight * def.lead;
    aim = Math.atan2(py - h.y, px - h.x);
  }

  world.shots.push({
    id: world.nextId++,
    friendly: false,
    from: h.type,
    x: h.x + Math.cos(aim) * (h.radius + 4),
    y: h.y + Math.sin(aim) * (h.radius + 4),
    vx: Math.cos(aim) * def.gun.speed,
    vy: Math.sin(aim) * def.gun.speed,
    life: def.gun.life,
    radius: def.gun.radius,
    damage: def.damage,
    splash: def.gun.splash || 0,
  });
  world.events.push({ type: 'hostileFire', x: h.x, y: h.y, hostile: h.type, angle: aim });
}

function spawnHostile(world, type, x, y, facing) {
  const def = HOSTILES[type];
  const h = {
    id: world.nextId++,
    type,
    x,
    y,
    vx: 0,
    vy: 0,
    facing,
    radius: def.radius,
    health: def.health,
    cooldown: world.rng.range(0, 0.6),
    telegraph: 0,
    /** Seconds without a firing solution. Only the turret behaviour reads it. */
    idle: 0,
    spawnTimer: def.spawn ? def.spawn.every : 0,
    broodOf: null,
  };
  world.hostiles.push(h);
  return h;
}

/* ================================================================= the pickups */

function stepPickups(world) {
  const t = world.tank;
  for (let i = world.pickups.length - 1; i >= 0; i--) {
    const p = world.pickups[i];
    p.life -= DT;
    if (p.life <= 0) {
      world.pickups.splice(i, 1);
      continue;
    }
    if (dist(p.x, p.y, t.x, t.y) > p.radius + t.radius) continue;

    if (p.kind === 'repair') {
      t.health = Math.min(TANK.maxHealth, t.health + PICKUPS.repairAmount);
      world.events.push({ type: 'repaired', x: p.x, y: p.y, health: t.health });
    } else {
      t.gun = p.gun;
      world.events.push({ type: 'gunTaken', x: p.x, y: p.y, gun: p.gun });
    }
    world.pickups.splice(i, 1);
  }
}

/**
 * Somewhere reachable, away from the player and out of a wall.
 *
 * Falls back to the arena centre after a bounded search rather than looping:
 * an unlucky seed must not be able to hang a run, and the centre is always
 * clear because `generateCover` refuses to build there.
 */
function findOpenSpot(world, minFromTank) {
  const t = world.tank;
  for (let i = 0; i < 60; i++) {
    const x = world.rng.range(80, ARENA.width - 80);
    const y = world.rng.range(80, ARENA.height - 80);
    if (dist(x, y, t.x, t.y) < minFromTank) continue;
    const probe = { x, y, radius: 30 };
    const before = `${x},${y}`;
    resolveCover(world, probe);
    if (`${probe.x},${probe.y}` === before) return { x, y };
  }
  return { x: ARENA.width / 2, y: ARENA.height / 2 };
}

/* =================================================================== the waves */

function stepWaves(world) {
  if (world.waveActive) {
    world.waveElapsed += DT;
    if (world.hostiles.some((h) => h.health > 0)) return;
    world.waveActive = false;
    world.waveTimer = WAVES.interval;
    world.events.push({ type: 'waveCleared', wave: world.wave, score: world.score });
    return;
  }

  world.waveTimer -= DT;
  if (world.waveTimer > 0) return;

  world.wave++;
  world.waveActive = true;
  world.waveElapsed = 0;
  spawnWave(world, world.wave);
  dropWavePickup(world, world.wave);
  world.events.push({ type: 'waveStart', wave: world.wave, hostiles: world.hostiles.length });
}

/**
 * Spend the wave's budget on hostiles.
 *
 * Buys from the unlocked set until the budget cannot afford anything, with a
 * per-type share cap so a bad roll cannot produce a wave that is nine wardens.
 * The cap is checked against the *budget spent*, not the head count — nine
 * scuttlers and one warden is a fine wave, and by head count the scuttlers
 * would look like the dominant type when they are a third of the threat.
 */
function spawnWave(world, n) {
  let budget = WAVES.budget(n);
  const available = unlockedAt(n);
  const spent = {};
  const total = budget;

  // Newly unlocked hostiles are guaranteed one appearance, so the wave that
  // introduces a mechanic actually shows it to the player rather than leaving
  // it to a dice roll.
  for (const id of available) {
    if (HOSTILES[id].minWave === n && budget >= WAVES.cost[id]) {
      placeHostile(world, id);
      budget -= WAVES.cost[id];
      spent[id] = (spent[id] || 0) + WAVES.cost[id];
    }
  }

  let guard = 0;
  while (budget > 0 && world.hostiles.length < WAVES.maxAlive && guard++ < 500) {
    const affordable = available.filter((id) => {
      if (WAVES.cost[id] > budget) return false;
      return ((spent[id] || 0) + WAVES.cost[id]) / total <= WAVES.maxShare;
    });
    if (!affordable.length) break;

    // Weighted pick. Cheap and adequate for five entries.
    const weights = affordable.map((id) => HOSTILES[id].weight);
    const sum = weights.reduce((a, b) => a + b, 0);
    let roll = world.rng.next() * sum;
    let chosen = affordable[affordable.length - 1];
    for (let i = 0; i < affordable.length; i++) {
      roll -= weights[i];
      if (roll <= 0) {
        chosen = affordable[i];
        break;
      }
    }

    placeHostile(world, chosen);
    budget -= WAVES.cost[chosen];
    spent[chosen] = (spent[chosen] || 0) + WAVES.cost[chosen];
  }
}

/**
 * Put one hostile on the field, at the edge, away from the player.
 *
 * Edge spawning rather than anywhere-off-screen because the arena is smaller
 * than the view at most zooms — there is no off-screen to hide in, so the
 * honest thing is to arrive at a wall in plain sight.
 */
function placeHostile(world, type) {
  const t = world.tank;
  let best = null;
  let bestRange = -1;

  // Four candidate edge points, keep the furthest from the player. A hostile
  // that materialises on top of the tank is a hit the player could not have
  // avoided, and this game's deaths have to be the player's fault.
  for (let i = 0; i < 4; i++) {
    const edge = world.rng.int(4);
    const along = world.rng.range(0.1, 0.9);
    const p =
      edge === 0
        ? { x: ARENA.width * along, y: 40 }
        : edge === 1
          ? { x: ARENA.width * along, y: ARENA.height - 40 }
          : edge === 2
            ? { x: 40, y: ARENA.height * along }
            : { x: ARENA.width - 40, y: ARENA.height * along };
    const range = dist(p.x, p.y, t.x, t.y);
    if (range > bestRange) {
      bestRange = range;
      best = p;
    }
  }

  const h = spawnHostile(world, type, best.x, best.y, Math.atan2(t.y - best.y, t.x - best.x));
  resolveCover(world, h);
  return h;
}

function dropWavePickup(world, n) {
  const gun = PICKUPS.schedule[n];
  const repair = PICKUPS.repairWaves.includes(n);
  if (!gun && !repair) return;

  const spot = findOpenSpot(world, 260);
  world.pickups.push({
    id: world.nextId++,
    kind: repair ? 'repair' : 'gun',
    gun: gun || null,
    x: spot.x,
    y: spot.y,
    radius: PICKUPS.radius,
    life: PICKUPS.life,
  });
  world.events.push({ type: 'pickupDropped', x: spot.x, y: spot.y, kind: repair ? 'repair' : gun });
}

/* ================================================================== the result */

/**
 * What the arcade records when a run ends.
 *
 * Deliberately small and free of world references, so it can be posted to a
 * balance service, stored, or compared without dragging the simulation along.
 * `seed` is included because it is what makes the rest of it checkable.
 */
export function runResult(world) {
  return {
    seed: world.seed,
    score: world.score,
    wave: world.wave,
    kills: world.kills,
    ticks: world.tick,
    seconds: Math.round((world.tick / TICKS_PER_SECOND) * 10) / 10,
    accuracy: world.shotsFired ? Math.round((world.shotsHit / world.shotsFired) * 100) : 0,
    result: world.result,
  };
}
