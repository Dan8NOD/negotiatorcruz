/**
 * Targeting, weapon fire, projectiles and impact.
 *
 * Weapons are per-hardpoint state machines: cool down, pick a target, commit
 * a salvo, spend the salvo one round at a time. Committing the salvo up front
 * is what makes a rocket mech read as a rocket mech — once the pod opens, all
 * four rockets are going somewhere, even if the target dies to the first.
 */

import { applyDamage, disable, rangeTo, buildSpatialIndex, vetBonus } from './entities.js';
import { len, facingTo } from './numeric.js';

/** Idle units engage what wanders into range but do not chase it. */
const LEASH = 1.05;

/* ------------------------------------------------------------ targeting -- */

/** Layer this entity presents to a weapon's `targets` list. */
export function targetLayer(e) {
  return e.kind === 'building' ? 'ground' : e.layer;
}

export function weaponCanHit(weapon, target) {
  return weapon.def.targets.includes(targetLayer(target));
}

/** A weapon's reach right now, accounting for the siege deploy bonus. */
export function weaponRange(owner, weapon) {
  if (owner.deployed && weapon.def.deployedRange) return weapon.def.deployedRange;
  return weapon.def.range;
}

/** The longest reach across all of an entity's hardpoints. */
export function maxRange(e) {
  let r = 0;
  for (const w of e.weapons) r = Math.max(r, weaponRange(e, w));
  return r;
}

export function isHostileTo(world, a, b) {
  return !b.dead && b.player !== a.player;
}

/**
 * Choose something to shoot.
 *
 * Preference order is deliberately simple and readable in play: things that
 * can shoot back, then closeness. Players model "it shoots the nearest threat"
 * accurately; they cannot model a twelve-term scoring function.
 */
export function acquireTarget(world, e, index, radius) {
  const candidates = index.query(e.x, e.y, radius);
  let best = null;
  let bestScore = Infinity;

  for (const other of candidates) {
    if (!isHostileTo(world, e, other)) continue;
    // Scenery is shootable but never *chosen*. Auto-acquisition that counts
    // trees would have every unit in the game stop to demolish the landscape
    // on its way to the fight. A player-ordered attack still works, because
    // that path sets the target directly rather than going through here.
    if (other.kind === 'prop') continue;
    if (!e.weapons.some((w) => weaponCanHit(w, other))) continue;
    // Under construction is still a valid target, but not a priority one.
    const dist = rangeTo(e, other);
    if (dist > radius) continue;

    const armed = other.weapons && other.weapons.length > 0 && !other.constructing;
    const score = dist + (armed ? 0 : 6) + (other.kind === 'building' ? 4 : 0);
    if (score < bestScore) {
      bestScore = score;
      best = other;
    }
  }

  return best;
}

/* ----------------------------------------------------------------- fire -- */

/**
 * Run one entity's weapons for a tick.
 *
 * `chase` reports back that the entity wants to close distance — the order
 * layer owns movement, so combat never moves anything itself.
 */
export function updateWeapons(world, e, index) {
  const disabled = e.disabledUntil > world.tick;
  const inert = e.constructing || (e.def.needsPower && !e.powered);

  for (const weapon of e.weapons) {
    if (weapon.cooldown > 0) weapon.cooldown--;
    if (weapon.salvoTimer > 0) weapon.salvoTimer--;
  }
  if (disabled || inert) return;

  // Finish any salvo already in flight before considering a new trigger pull.
  for (const weapon of e.weapons) {
    if (weapon.salvoLeft > 0 && weapon.salvoTimer <= 0) {
      const target = world.entities.get(weapon.salvoTargetId);
      if (target && !target.dead) {
        fireOnce(world, e, weapon, target);
        weapon.salvoLeft--;
        weapon.salvoTimer = weapon.def.salvo.interval;
      } else {
        weapon.salvoLeft = 0;
      }
    }
  }

  let target = e.targetId ? world.entities.get(e.targetId) : null;
  if (target && (target.dead || target.player === e.player)) {
    target = null;
    e.targetId = null;
    e.targetForced = false;
  }

  if (!target) {
    const found = acquireTarget(world, e, index, maxRange(e) * LEASH);
    if (found) {
      target = found;
      e.targetId = found.id;
      e.targetForced = false;
    }
  }

  if (!target) return;

  for (const weapon of e.weapons) {
    if (weapon.cooldown > 0 || weapon.salvoLeft > 0) continue;
    if (!weaponCanHit(weapon, target)) continue;

    const dist = rangeTo(e, target);
    if (dist > weaponRange(e, weapon)) continue;
    // Siege mortars cannot depress far enough to hit what is on top of them.
    if (weapon.def.minRange && dist < weapon.def.minRange) continue;

    e.facing = facingTo(target.x - e.x, target.y - e.y);
    // Rank raises rate of fire. Applied here rather than baked into the weapon
    // so a promotion takes effect on the very next trigger pull.
    weapon.cooldown = Math.max(1, Math.round(weapon.def.cooldown * vetBonus(e).cooldown));

    if (weapon.def.salvo) {
      weapon.salvoLeft = weapon.def.salvo.count;
      weapon.salvoTargetId = target.id;
      weapon.salvoTimer = 0;
    } else {
      fireOnce(world, e, weapon, target);
    }
  }
}

function fireOnce(world, owner, weapon, target) {
  const def = weapon.def;
  const damage = def.damage * vetBonus(owner).damage;
  world.events.push({
    type: 'fire',
    id: owner.id,
    weapon: def.id,
    x: owner.x,
    y: owner.y,
    tx: target.x,
    ty: target.y,
  });

  if (def.projectile === 'beam') {
    // Hitscan. Beams never miss, which is what they are paying for in range.
    applyDamage(world, target, damage, def.type, owner.id);
    if (def.disable) disable(world, target, def.disable);
    world.effects.push({
      type: 'beam',
      x1: owner.x,
      y1: owner.y,
      x2: target.x,
      y2: target.y,
      until: world.tick + 3,
      damageType: def.type,
    });
    return;
  }

  // Spread is applied at launch so the miss is visible in the projectile's
  // flight rather than appearing as an unexplained damage roll on impact.
  const scatter = def.spread || 0;
  const jitterX = scatter ? world.rng.range(-scatter, scatter) * Math.max(1, rangeTo(owner, target)) : 0;
  const jitterY = scatter ? world.rng.range(-scatter, scatter) * Math.max(1, rangeTo(owner, target)) : 0;

  world.projectiles.push({
    id: world.nextId++,
    kind: def.projectile,
    x: owner.x,
    y: owner.y,
    tx: target.x + jitterX,
    ty: target.y + jitterY,
    /** Rockets and tracers steer; shells commit to a spot on the ground. */
    targetId: def.arcing ? null : target.id,
    speed: def.speed / 20,
    damage,
    damageType: def.type,
    splash: def.splash || null,
    disableTicks: def.disable || 0,
    owner: owner.id,
    player: owner.player,
    arcing: !!def.arcing,
    startX: owner.x,
    startY: owner.y,
    travelled: 0,
    totalDistance: len(target.x + jitterX - owner.x, target.y + jitterY - owner.y),
    life: 200,
  });
}

/* ---------------------------------------------------------- projectiles -- */

export function updateProjectiles(world) {
  const surviving = [];

  for (const p of world.projectiles) {
    if (--p.life <= 0) continue;

    // Homing projectiles re-aim at a live target; otherwise they carry on to
    // the last known point, which is how a dodging scout survives a salvo.
    if (p.targetId) {
      const t = world.entities.get(p.targetId);
      if (t && !t.dead) {
        p.tx = t.x;
        p.ty = t.y;
      } else {
        p.targetId = null;
      }
    }

    const dx = p.tx - p.x;
    const dy = p.ty - p.y;
    const dist = len(dx, dy);

    if (dist <= p.speed) {
      p.x = p.tx;
      p.y = p.ty;
      impact(world, p);
      continue;
    }

    p.x += (dx / dist) * p.speed;
    p.y += (dy / dist) * p.speed;
    p.travelled += p.speed;
    surviving.push(p);
  }

  world.projectiles = surviving;
}

function impact(world, p) {
  if (p.splash) {
    const radius = p.splash.radius;
    const index = world.index || buildSpatialIndex(world);
    for (const e of index.query(p.x, p.y, radius + 1)) {
      if (e.dead) continue;
      const d = Math.max(0, len(e.x - p.x, e.y - p.y) - (e.radius || 0));
      if (d > radius) continue;
      // Linear falloff to `falloff` of full damage at the rim.
      const scale = 1 - (d / radius) * (1 - p.splash.falloff);
      applyDamage(world, e, p.damage * scale, p.damageType, p.owner);
      if (p.disableTicks) disable(world, e, p.disableTicks);
    }
    world.events.push({ type: 'explosion', x: p.x, y: p.y, radius });
    return;
  }

  const target = p.targetId ? world.entities.get(p.targetId) : null;
  if (target && !target.dead) {
    applyDamage(world, target, p.damage, p.damageType, p.owner);
    if (p.disableTicks) disable(world, target, p.disableTicks);
  }
  world.events.push({ type: 'impact', x: p.x, y: p.y });
}
