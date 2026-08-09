/**
 * Targeting, weapon fire, projectiles and impact.
 *
 * Weapons are per-hardpoint state machines: cool down, pick a target, commit
 * a salvo, spend the salvo one round at a time. Committing the salvo up front
 * is what makes a rocket mech read as a rocket mech — once the pod opens, all
 * four rockets are going somewhere, even if the target dies to the first.
 *
 * Terrain is the other half of a shot, and this file is where it is paid for:
 * what the round has to cross, and what the thing being shot at is standing
 * next to. See "what blocked means" below.
 */

import {
  applyDamage,
  disable,
  rangeTo,
  buildSpatialIndex,
  vetBonus,
  isCombatant,
  traceShot,
  coverAgainst,
  COVER_DAMAGE,
  ELEVATION,
  BLOCKED,
} from './entities.js';
import { len, facingTo } from './numeric.js';

/** Idle units engage what wanders into range but do not chase it. */
const LEASH = 1.05;

/* --------------------------------------------- what "blocked" means here -- */

/**
 * Two kinds of obstacle, and deliberately two different mechanics.
 *
 * **A cliff or a building is a hard block: the weapon does not fire at all.**
 * The honest alternative was an accuracy penalty everywhere, and it is the
 * wrong answer for one reason — a penalty is invisible. "My rockets did 40%
 * less because there is a tower block in the way" is a fact the player can
 * only learn from a wiki; "my Kestrel has stopped shooting" is a fact they
 * learn in half a second and fix by walking six cells. The whole point of
 * putting a skyline on the map is that a player routes around it on purpose,
 * and only a rule they can *see* teaches that. It also gives breaking line of
 * sight a real use: a raid that ducks behind the housing block is genuinely
 * out of the fight, which is exactly the disengage the shield model already
 * wants to reward.
 *
 * **Canopy is a penalty, not a block.** A wood that could not be shot into
 * would be the strongest position on the map and every fight would be decided
 * by who reached the trees first. So a firing line through canopy is *taxed*:
 * shots lose their lock and fly wide. Depth still matters — four cells of it
 * and the line is gone (`SOFT_OPAQUE`) — so shooting into the edge of a wood
 * works and shooting the length of one does not.
 *
 * The penalty is paid in accuracy rather than damage because the game already
 * has `spread` and already argues, at the launch site below, that a miss
 * should be visible in the projectile's flight rather than appear as an
 * unexplained damage roll on arrival. A shot that misses through the trees
 * looks like a shot that missed through the trees.
 *
 * Beams are the exception, and they have to be: a hitscan weapon cannot miss —
 * that is what it is paying for in range — so scattering it is a no-op and
 * energy would be the one warhead that ignores terrain entirely. It pays in
 * damage instead, which is the same tax on a different axis.
 *
 * **Indirect fire goes over the top.** A mortar lobs, so a cliff or a roof is
 * not in its way, and a shell arrives through the canopy rather than through
 * it. This is not a special case bolted on to rescue the rule — it is the
 * counterplay the rule needs. Without it, a machine tucked behind a rock that
 * nothing can find an angle on is simply invulnerable, and a match with three
 * of those left on the map never ends; with it, the answer to a dug-in enemy
 * is the siege chassis the game already builds its Bulwark identity out of.
 * "Bring artillery" is a much better answer than "the wall is only 40% of a
 * wall", and it is the one a player can act on.
 *
 * **Cover is the defender's half of the same idea**, and it is the half that
 * rewards standing somewhere on purpose: a machine tucked against a wall takes
 * less from anything shooting round it (`coverAgainst`). It is applied to
 * direct hits only. Splash goes over the hedge and round the corner, which is
 * both obviously true and the piece of design that matters most here — it
 * gives a player facing a dug-in enemy an answer that already exists in the
 * counter triangle instead of a new system to teach.
 */

/**
 * Chance a round is thrown off, per cell of canopy it has to thread.
 *
 * A fifth per cell: one ironwood is a tax you fight through, three is most of
 * your fire gone, and the fourth is a wall (`SOFT_OPAQUE`). That curve is what
 * makes the edge of a wood worth contesting and the middle of one worth
 * walking round, and it is steep enough that a player notices without ever
 * being told the number.
 */
const SOFT_MISS = 0.2;

/** Damage a beam loses per cell of canopy. Beams cannot miss; they dim. */
const SOFT_BEAM_LOSS = 0.15;

/** How wide a thrown-off round goes, as a fraction of the range it flew. */
const SOFT_SCATTER = 0.16;

/* ------------------------------------------------------------ targeting -- */

/** Layer this entity presents to a weapon's `targets` list. */
export function targetLayer(e) {
  return e.kind === 'building' ? 'ground' : e.layer;
}

export function weaponCanHit(weapon, target) {
  return weapon.def.targets.includes(targetLayer(target));
}

/**
 * A weapon's reach right now, accounting for the siege deploy bonus and for
 * standing on high ground.
 *
 * The elevation bonus is a multiplier rather than a flat bonus on purpose: it
 * is worth a fraction of a cell to a scattergun and two and a half cells to a
 * deployed Longbow, which makes "get on top of them" a siege doctrine rather
 * than a universal free upgrade. `elevated` is stamped onto the entity once a
 * tick with the spatial index, so this stays a field read — `maxRange` runs it
 * over every hardpoint of every armed machine, every tick.
 */
export function weaponRange(owner, weapon) {
  const base =
    owner.deployed && weapon.def.deployedRange ? weapon.def.deployedRange : weapon.def.range;
  return owner.elevated ? base * ELEVATION.RANGE : base;
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

/** Does this machine carry anything that can shoot over a wall? */
export function hasIndirectFire(e) {
  for (const weapon of e.weapons) if (weapon.def.arcing) return true;
  return false;
}

/**
 * Is this machine under orders to go and fight, as opposed to holding ground?
 *
 * Attack-move and an ordered attack both mean "close on the enemy", and that
 * is the one state in which acquiring something it cannot yet shoot is the
 * right answer — the order layer will path it round the obstruction, which is
 * what a player does by hand and the only reason the AI ever comes round the
 * back of a ridge. An idle machine does the opposite: it engages what wanders
 * into range and does not chase, so a target it cannot hit is not its problem.
 */
function isAdvancing(e) {
  return !!e.order && (e.order.type === 'attackMove' || e.order.type === 'attack');
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
  const overTheTop = hasIndirectFire(e);
  const advancing = isAdvancing(e);
  const reach = maxRange(e);
  let best = null;
  let bestScore = Infinity;
  /** The nearest thing it cannot shoot from here — a destination, not a target. */
  let walled = null;
  let walledScore = Infinity;

  for (const other of candidates) {
    if (!isHostileTo(world, e, other)) continue;
    // Scenery is shootable but never *chosen*. Auto-acquisition that counts
    // trees would have every unit in the game stop to demolish the landscape
    // on its way to the fight. A player-ordered attack still works, because
    // that path sets the target directly rather than going through here.
    //
    // Routed through `isCombatant` rather than testing for a prop, because
    // everything owned by nobody has this problem: a gateway is neutral too,
    // and an army that stopped to shoot the way out would never take it.
    if (!isCombatant(other)) continue;
    if (!e.weapons.some((w) => weaponCanHit(w, other))) continue;
    // Under construction is still a valid target, but not a priority one.
    const dist = rangeTo(e, other);
    if (dist > radius) continue;

    const armed = other.weapons && other.weapons.length > 0 && !other.constructing;
    const score = dist + (armed ? 0 : 6) + (other.kind === 'building' ? 4 : 0);
    // The trace is the most expensive test here, so it runs last and only on a
    // candidate that could still win one of the two slots — a dozen enemies in
    // range cost one or two walks, not a dozen.
    if (score >= bestScore && score >= walledScore) continue;

    if (!overTheTop && traceShot(world, e, other) === BLOCKED) {
      // Held aside rather than chosen, and only as somewhere to walk. A
      // machine that locked onto something behind a tower block *inside* its
      // own firing range would close no further — `pursue` stops at four
      // fifths of reach — and would then stand there facing a wall for the
      // rest of the match. So this is offered only to a machine that has been
      // told to advance, only when there is nothing it can actually shoot, and
      // only for a target far enough away that walking at it changes the
      // angle. Everything else keeps marching and finds a real one.
      if (dist > reach && score < walledScore) {
        walledScore = score;
        walled = other;
      }
      continue;
    }

    if (score < bestScore) {
      bestScore = score;
      best = other;
    }
  }

  return best || (advancing ? walled : null);
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
  // The rest of the pod is committed, but each round is traced as it leaves:
  // a target that ducks behind a wall mid-salvo stops taking the remainder,
  // which is the same fact as "breaking line of sight breaks off the fight".
  for (const weapon of e.weapons) {
    if (weapon.salvoLeft > 0 && weapon.salvoTimer <= 0) {
      const target = world.entities.get(weapon.salvoTargetId);
      if (target && !target.dead) {
        const through = traceShot(world, e, target);
        if (through !== BLOCKED) fireOnce(world, e, weapon, target, through);
        else if (weapon.def.arcing) fireOnce(world, e, weapon, target, 0);
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

  // One trace per machine per tick, shared by every hardpoint on it. A Kestrel
  // firing two weapons at one target is one walk down the line, not two.
  const through = traceShot(world, e, target);
  const walled = through === BLOCKED;
  // Keep walking at it only while walking can still open an angle; see the
  // same rule in `acquireTarget`.
  const closing = isAdvancing(e) && rangeTo(e, target) > maxRange(e);
  if (walled && !hasIndirectFire(e) && !closing) {
    // Drop it unless the player said so. An auto-acquired target that has gone
    // behind a wall is no longer this machine's business, and holding it would
    // stop the order layer ever looking for one it can actually shoot. A
    // *forced* target is kept: the player pointed at that thing, and quietly
    // retargeting is how an ordered attack turns into a mystery — and a
    // machine still closing keeps it too, because closing on it is the order
    // it was given.
    if (!e.targetForced) e.targetId = null;
    return;
  }

  for (const weapon of e.weapons) {
    if (weapon.cooldown > 0 || weapon.salvoLeft > 0) continue;
    if (!weaponCanHit(weapon, target)) continue;
    // Only the mortars can shoot over it; everything else waits for an angle.
    if (walled && !weapon.def.arcing) continue;

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
      // A lobbed shell comes down *through* the canopy rather than across it,
      // so the branches it would have had to thread are not its problem.
      fireOnce(world, e, weapon, target, walled ? 0 : through);
    }
  }
}

/**
 * @param {number} soft Cells of canopy this round has to thread, from
 *   `traceShot`. Zero is the open-ground path and is deliberately identical to
 *   what this function did before terrain existed — including which rolls it
 *   takes off the RNG, so a match fought in the open replays as it always did.
 */
function fireOnce(world, owner, weapon, target, soft = 0) {
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
    // Hitscan. Beams never miss, which is what they are paying for in range —
    // so canopy and cover are both taken out of the damage instead. The
    // disable still lands in full: an EMP that arcs through a hedge has still
    // arrived, and halving a duration is a much less legible nerf than a
    // smaller number on the hull.
    const shielding = COVER_DAMAGE[coverAgainst(world, target, owner.x, owner.y)];
    const dimmed = damage * (1 - soft * SOFT_BEAM_LOSS) * shielding;
    applyDamage(world, target, dimmed, def.type, owner.id);
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
    // A beam connects instantly, so nothing later in the frame will announce
    // that it landed. Say so here, or energy and EMP weapons are the only
    // things in the game that hit in silence.
    world.events.push({
      type: 'impact',
      x: target.x,
      y: target.y,
      damageType: def.type,
      weapon: def.id,
    });
    return;
  }

  // Spread is applied at launch so the miss is visible in the projectile's
  // flight rather than appearing as an unexplained damage roll on impact.
  const scatter = def.spread || 0;
  const reach = Math.max(1, rangeTo(owner, target));
  let jitterX = scatter ? world.rng.range(-scatter, scatter) * reach : 0;
  let jitterY = scatter ? world.rng.range(-scatter, scatter) * reach : 0;

  /**
   * Guided rounds re-aim at a live target every tick, so the launch jitter
   * above is cosmetic for them — the round steers back onto the mech. That is
   * right in the open and wrong through a wood, so canopy is paid for by
   * *breaking the lock*: the round commits to a point in the trees and flies
   * on past. A splash weapon still detonates where it landed, which is why a
   * rocket salvo through canopy grazes rather than whiffs, and a tracer that
   * lost its lock simply misses.
   *
   * The roll is only taken when there is something in the way, so a shot in
   * the open consumes exactly the RNG it always did.
   */
  let lock = def.arcing ? null : target.id;
  if (soft > 0 && world.rng.chance(soft * SOFT_MISS)) {
    lock = null;
    jitterX += world.rng.range(-SOFT_SCATTER, SOFT_SCATTER) * reach;
    jitterY += world.rng.range(-SOFT_SCATTER, SOFT_SCATTER) * reach;
  }

  world.projectiles.push({
    id: world.nextId++,
    kind: def.projectile,
    /** Carried purely so the impact event can name what landed. Presentation
     *  reads it; nothing in the simulation branches on it. */
    weapon: def.id,
    x: owner.x,
    y: owner.y,
    tx: target.x + jitterX,
    ty: target.y + jitterY,
    /** Rockets and tracers steer; shells commit to a spot on the ground. */
    targetId: lock,
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
    // Splash deliberately ignores cover. Blast goes over a hedge and round a
    // corner, and a rule that let a mech hide from a propane depot behind a
    // fence would read as broken — but the real argument is the counter
    // triangle: explosive is already the siege warhead, and "explosives dig
    // you out of cover" gives the player the answer to a dug-in enemy without
    // adding a system to teach it.
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
    world.events.push({
      type: 'explosion',
      x: p.x,
      y: p.y,
      radius,
      damageType: p.damageType,
      weapon: p.weapon,
    });
    return;
  }

  const target = p.targetId ? world.entities.get(p.targetId) : null;
  if (target && !target.dead) {
    // Cover is measured from where the round was fired from, not from where it
    // is now: what matters is the angle it came in at. `startX` is already on
    // every projectile for the renderer's trail, so this costs two array reads
    // and no extra state.
    const shielding = COVER_DAMAGE[coverAgainst(world, target, p.startX ?? p.x, p.startY ?? p.y)];
    applyDamage(world, target, p.damage * shielding, p.damageType, p.owner);
    if (p.disableTicks) disable(world, target, p.disableTicks);
  }
  // The warhead travels with the event. A ricochet, a sizzle and an arc are
  // three different sounds and three different colours of spark, and without
  // this the presentation layer cannot tell them apart at the point of impact.
  world.events.push({ type: 'impact', x: p.x, y: p.y, damageType: p.damageType, weapon: p.weapon });
}
