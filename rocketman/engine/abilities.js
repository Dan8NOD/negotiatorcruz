/**
 * Active abilities — the War Robots layer.
 *
 * Every combat chassis carries at most one, on a long cooldown, fired by hand.
 * They are deliberately swingy: a well-timed Aegis field or EMP burst should
 * decide a fight, because that is the difference between an army you command
 * and an army you point.
 */

import { TICKS_PER_SECOND } from './content.js';
import { applyDamage, disable, rangeTo, isCombatant } from './entities.js';
import { beginLeap } from './movement.js';
import { nearestWalkable } from './grid.js';
import { len } from './numeric.js';

/**
 * Which slot an ability call means.
 *
 * `ability` is the chassis ability; `heroAbility` is the crew ability a named
 * pilot carries on top of it. Everything below is parameterised by slot rather
 * than duplicated, so a third slot would be one more constant.
 */
export const CHASSIS_SLOT = 'ability';
export const HERO_SLOT = 'heroAbility';

/** Why an ability cannot fire right now, or null if it can. */
export function abilityBlocker(world, e, slot = CHASSIS_SLOT) {
  if (!e[slot]) return 'none';
  if (e.dead) return 'dead';
  if (e.disabledUntil > world.tick) return 'disabled';
  if (e[slot].cooldown > 0) return 'cooling';
  return null;
}

export function abilityReady(world, e, slot = CHASSIS_SLOT) {
  return abilityBlocker(world, e, slot) === null;
}

/**
 * Fire an ability. `x`/`y` are only read by targeted abilities and are
 * clamped to the ability's range rather than refused — an out-of-range click
 * should leap as far as it can, not do nothing.
 *
 * @returns {boolean} whether the ability actually went off.
 */
export function activateAbility(world, e, x, y, slot = CHASSIS_SLOT) {
  if (!abilityReady(world, e, slot)) return false;

  const a = e[slot];
  const def = a.def;

  switch (def.kind) {
    case 'leap': {
      const dx = x - e.x;
      const dy = y - e.y;
      const dist = len(dx, dy) || 1;
      const reach = Math.min(dist, def.distance);
      let tx = e.x + (dx / dist) * reach;
      let ty = e.y + (dy / dist) * reach;

      // Land somewhere the machine can stand. A leap is allowed to *reach* a
      // cell it could never have walked to — that is the tactical point — but
      // it must not end up buried inside one. Cheap to ignore at six cells,
      // not at thirty-six, where the target is often under fog.
      if (e.layer !== 'air') {
        const cell = nearestWalkable(world.map, Math.floor(tx), Math.floor(ty), 6);
        if (cell) {
          tx = cell.x + 0.5;
          ty = cell.y + 0.5;
        }
      }
      beginLeap(world, e, tx, ty, def.duration);
      break;
    }

    case 'speed': {
      e.speedMul = def.multiplier;
      e.speedMulUntil = world.tick + def.duration;
      break;
    }

    case 'shield': {
      e.tempShield = def.amount;
      e.tempShieldUntil = world.tick + def.duration;
      break;
    }

    case 'toggle': {
      // Deploying and undeploying both cost the same vulnerable window.
      e.deployTimer = def.duration;
      e.deployPending = !e.deployed;
      e.path = [];
      e.pathGoal = null;
      break;
    }

    case 'heal': {
      e.healUntil = world.tick + def.duration;
      break;
    }

    case 'emp': {
      const index = world.index;
      const targets = index ? index.query(x, y, def.radius + 1) : [];
      for (const other of targets) {
        if (other.dead || other.player === e.player || !isCombatant(other)) continue;
        if (len(other.x - x, other.y - y) > def.radius) continue;
        disable(world, other, def.disable);
      }
      world.effects.push({
        type: 'empBurst',
        x,
        y,
        radius: def.radius,
        until: world.tick + 12,
      });
      break;
    }

    default:
      return false;
  }

  a.cooldown = def.cooldown;
  a.activeUntil = world.tick + (def.duration || 0);
  world.events.push({ type: 'ability', id: e.id, ability: def.id, slot, x, y });
  return true;
}

/** Per-tick upkeep: cooldowns, expiries, deploy transitions, repair fields. */
export function updateAbilities(world, e, index) {
  if (e.ability && e.ability.cooldown > 0) e.ability.cooldown--;
  if (e.heroAbility && e.heroAbility.cooldown > 0) e.heroAbility.cooldown--;

  if (e.tempShieldUntil && world.tick >= e.tempShieldUntil) {
    e.tempShield = 0;
    e.tempShieldUntil = 0;
  }
  if (e.speedMulUntil && world.tick >= e.speedMulUntil) {
    e.speedMul = 1;
    e.speedMulUntil = 0;
  }

  if (e.deployTimer > 0) {
    if (--e.deployTimer === 0) {
      e.deployed = e.deployPending;
      world.events.push({ type: 'deploy', id: e.id, deployed: e.deployed });
    }
  }

  if (e.healUntil && world.tick < e.healUntil && e.ability) {
    const def = e.ability.def;
    const perTick = def.rate / TICKS_PER_SECOND;
    for (const other of index.query(e.x, e.y, def.radius)) {
      if (other.dead || other.player !== e.player || other.kind !== 'unit') continue;
      if (other.hp >= other.maxHp) continue;
      other.hp = Math.min(other.maxHp, other.hp + perTick);
    }
    if (world.tick % 5 === 0) {
      world.effects.push({
        type: 'healField',
        x: e.x,
        y: e.y,
        radius: def.radius,
        until: world.tick + 6,
      });
    }
  }
}

/**
 * Shield regeneration. Separate from abilities in concept but identical in
 * shape — a per-tick recovery gated on a timer — so it lives here rather than
 * earning its own module.
 */
export function updateShield(world, e) {
  if (e.maxShield <= 0) return;
  if (e.shieldTimer > 0) {
    e.shieldTimer--;
    return;
  }
  if (e.shield < e.maxShield) {
    e.shield = Math.min(e.maxShield, e.shield + e.def.shieldRegen / TICKS_PER_SECOND);
  }
}

/**
 * Should the AI or an auto-cast fire this ability right now?
 *
 * Kept in the engine rather than in ai.js so that a future "auto-cast" toggle
 * in the UI and the AI opponent agree about what a good moment looks like.
 */
export function suggestAbility(world, e, index) {
  if (!abilityReady(world, e)) return null;
  const def = e.ability.def;

  const enemies = index
    .query(e.x, e.y, 9)
    .filter((o) => !o.dead && o.player !== e.player && o.kind === 'unit');

  switch (def.kind) {
    case 'shield':
      // Panic button: cast once the hull is actually being chewed on.
      return e.hp < e.maxHp * 0.7 && enemies.length > 0 ? { x: e.x, y: e.y } : null;

    case 'speed':
      return enemies.length > 0 ? { x: e.x, y: e.y } : null;

    case 'heal': {
      const hurt = index
        .query(e.x, e.y, def.radius)
        .filter((o) => !o.dead && o.player === e.player && o.kind === 'unit' && o.hp < o.maxHp * 0.6);
      return hurt.length >= 2 ? { x: e.x, y: e.y } : null;
    }

    case 'emp': {
      // Find the densest enemy cluster within reach and drop the burst on it.
      let best = null;
      let bestCount = 2;
      for (const candidate of enemies) {
        const count = enemies.filter(
          (o) => len(o.x - candidate.x, o.y - candidate.y) <= def.radius
        ).length;
        if (count > bestCount) {
          bestCount = count;
          best = candidate;
        }
      }
      return best ? { x: best.x, y: best.y } : null;
    }

    case 'leap': {
      // Close on the nearest target that is outside weapon range but inside
      // leap range — the gap-closer use, not the escape use.
      const target = enemies
        .filter((o) => {
          const d = rangeTo(e, o);
          return d > 4 && d <= def.distance;
        })
        .sort((a, b) => rangeTo(e, a) - rangeTo(e, b))[0];
      return target ? { x: target.x, y: target.y } : null;
    }

    case 'toggle': {
      // Deploy when something is in deployed range; pack up when nothing is.
      const inSiegeRange = index
        .query(e.x, e.y, 15)
        .some((o) => !o.dead && isCombatant(o) && o.player !== e.player && rangeTo(e, o) > 4);
      if (inSiegeRange !== e.deployed) return { x: e.x, y: e.y };
      return null;
    }

    default:
      return null;
  }
}

export { applyDamage };
