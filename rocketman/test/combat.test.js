/**
 * Damage resolution, targeting and projectiles.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { makeBareWorld, run } from './helpers.js';
import { spawnUnit, spawnBuilding, applyDamage, buildSpatialIndex, disable } from '../engine/entities.js';
import { acquireTarget, weaponCanHit, weaponRange, maxRange, updateWeapons } from '../engine/combat.js';
import { DAMAGE, ARMOR, SHIELD, WEAPONS, UNITS, damageMultiplier } from '../engine/content.js';
import { tick } from '../engine/sim.js';

describe('damage resolution', () => {
  test('hull damage is scaled by the warhead/armour table', () => {
    const world = makeBareWorld();
    const target = spawnUnit(world, 'anvil', 1, 30, 30); // heavy armour
    target.shield = 0;

    const dealt = applyDamage(world, target, 100, DAMAGE.KINETIC);
    assert.equal(dealt, 100 * damageMultiplier(DAMAGE.KINETIC, ARMOR.HEAVY));
    assert.equal(target.hp, target.maxHp - dealt);
  });

  test('buildings always take structure damage regardless of chassis armour', () => {
    const world = makeBareWorld();
    const building = spawnBuilding(world, 'reactor', 1, 30, 30, { complete: true });

    applyDamage(world, building, 100, DAMAGE.EXPLOSIVE);
    const expected = 100 * damageMultiplier(DAMAGE.EXPLOSIVE, ARMOR.STRUCTURE);
    assert.equal(building.maxHp - building.hp, expected);
  });

  test('shields absorb first and take no armour multiplier', () => {
    const world = makeBareWorld();
    const target = spawnUnit(world, 'kestrel', 1, 30, 30);
    const startShield = target.shield;
    assert.ok(startShield > 0, 'this test needs a shielded chassis');

    applyDamage(world, target, 50, DAMAGE.KINETIC);
    assert.equal(target.shield, startShield - 50, 'shield should soak the raw number');
    assert.equal(target.hp, target.maxHp, 'hull must be untouched while the shield holds');
  });

  test('overflow past a broken shield still lands on the hull', () => {
    const world = makeBareWorld();
    const target = spawnUnit(world, 'kestrel', 1, 30, 30);
    const shield = target.shield;

    applyDamage(world, target, shield + 100, DAMAGE.ENERGY);
    assert.equal(target.shield, 0);
    const expected = 100 * damageMultiplier(DAMAGE.ENERGY, UNITS.kestrel.armor);
    assert.ok(Math.abs(target.maxHp - target.hp - expected) < 1e-6);
  });

  test('breaking a shield costs more downtime than merely denting it', () => {
    const world = makeBareWorld();
    const dented = spawnUnit(world, 'kestrel', 1, 30, 30);
    const broken = spawnUnit(world, 'kestrel', 1, 34, 30);

    applyDamage(world, dented, 10, DAMAGE.KINETIC);
    applyDamage(world, broken, broken.shield, DAMAGE.KINETIC);

    assert.equal(dented.shieldTimer, SHIELD.REGEN_DELAY);
    assert.equal(broken.shieldTimer, SHIELD.REGEN_DELAY + SHIELD.BREAK_PENALTY);
  });

  test('shields regenerate only after the delay elapses', () => {
    const world = makeBareWorld();
    const target = spawnUnit(world, 'kestrel', 0, 30, 30);
    applyDamage(world, target, 100, DAMAGE.KINETIC);
    const dented = target.shield;

    run(world, SHIELD.REGEN_DELAY - 2);
    assert.equal(target.shield, dented, 'regen started early');

    run(world, 60);
    assert.ok(target.shield > dented, 'regen never started');
    assert.ok(target.shield <= target.maxShield, 'regen overshot the pool');
  });

  test('a unit reduced to zero hull dies and is reaped', () => {
    const world = makeBareWorld();
    const target = spawnUnit(world, 'vireo', 1, 30, 30);
    const id = target.id;

    applyDamage(world, target, 99999, DAMAGE.KINETIC);
    assert.ok(target.dead);

    tick(world, []);
    assert.equal(world.entities.get(id), undefined, 'dead entities must be cleaned up');
  });

  test('kills are attributed to the shooter', () => {
    const world = makeBareWorld();
    const shooter = spawnUnit(world, 'kestrel', 0, 30, 30);
    const victim = spawnUnit(world, 'vireo', 1, 32, 30);

    applyDamage(world, victim, 99999, DAMAGE.KINETIC, shooter.id);
    assert.equal(world.players[0].stats.killed, 1);
    assert.equal(world.players[1].stats.lost, 1);
  });

  test('a dying reactor damages what is next to it', () => {
    const world = makeBareWorld();
    const reactor = spawnBuilding(world, 'reactor', 0, 30, 30, { complete: true });
    const bystander = spawnUnit(world, 'vireo', 0, 31, 32);
    const distant = spawnUnit(world, 'vireo', 0, 45, 45);

    applyDamage(world, reactor, 99999, DAMAGE.KINETIC);

    assert.ok(bystander.hp < bystander.maxHp || bystander.shield < bystander.maxShield);
    assert.equal(distant.hp, distant.maxHp, 'the blast reached too far');
  });

  test('damage below zero is ignored rather than healing the target', () => {
    const world = makeBareWorld();
    const target = spawnUnit(world, 'vireo', 1, 30, 30);
    target.hp = 100;
    applyDamage(world, target, -500, DAMAGE.KINETIC);
    assert.equal(target.hp, 100);
  });
});

describe('targeting', () => {
  test('ground-only weapons cannot engage aircraft', () => {
    const world = makeBareWorld();
    const longbow = spawnUnit(world, 'longbow', 0, 30, 30);
    const harrier = spawnUnit(world, 'harrier', 1, 33, 30);

    assert.ok(!weaponCanHit(longbow.weapons[0], harrier), 'a mortar should not hit an aircraft');
    world.index = buildSpatialIndex(world);
    assert.equal(acquireTarget(world, longbow, world.index, 20), null);
  });

  test('flak engages aircraft and ignores ground', () => {
    const world = makeBareWorld();
    const vulture = spawnUnit(world, 'vulture', 0, 30, 30);
    const flak = vulture.weapons.find((w) => w.id === 'flakburst');
    const anvil = spawnUnit(world, 'anvil', 1, 33, 30);
    const harrier = spawnUnit(world, 'harrier', 1, 33, 32);

    assert.ok(!weaponCanHit(flak, anvil));
    assert.ok(weaponCanHit(flak, harrier));
  });

  test('buildings present as ground targets', () => {
    const world = makeBareWorld();
    const vulture = spawnUnit(world, 'vulture', 0, 30, 30);
    const rocket = vulture.weapons.find((w) => w.id === 'lightrockets');
    const reactor = spawnBuilding(world, 'reactor', 1, 33, 30, { complete: true });
    assert.ok(weaponCanHit(rocket, reactor));
  });

  test('never targets its own side', () => {
    const world = makeBareWorld();
    const a = spawnUnit(world, 'kestrel', 0, 30, 30);
    spawnUnit(world, 'vireo', 0, 32, 30);
    world.index = buildSpatialIndex(world);
    assert.equal(acquireTarget(world, a, world.index, 20), null);
  });

  test('prefers armed threats over harmless targets at similar range', () => {
    const world = makeBareWorld();
    const shooter = spawnUnit(world, 'kestrel', 0, 30, 30);
    const collector = spawnUnit(world, 'collector', 1, 33, 30);
    const armed = spawnUnit(world, 'tick', 1, 33.5, 30);

    world.index = buildSpatialIndex(world);
    const picked = acquireTarget(world, shooter, world.index, 20);
    assert.equal(picked.id, armed.id, 'should shoot the thing that shoots back');
    assert.notEqual(picked.id, collector.id);
  });

  test('deploying extends a siege unit’s reach', () => {
    const world = makeBareWorld();
    const longbow = spawnUnit(world, 'longbow', 0, 30, 30);
    const weapon = longbow.weapons[0];

    const packed = weaponRange(longbow, weapon);
    longbow.deployed = true;
    const deployed = weaponRange(longbow, weapon);

    assert.ok(deployed > packed, 'deploy must actually buy range');
    assert.equal(deployed, WEAPONS.siegemortar.deployedRange);
  });

  test('maxRange reports the longest hardpoint', () => {
    const world = makeBareWorld();
    const kestrel = spawnUnit(world, 'kestrel', 0, 30, 30);
    assert.equal(maxRange(kestrel), Math.max(WEAPONS.rocketpod.range, WEAPONS.autocannon.range));
  });
});

describe('weapon fire', () => {
  test('a mech in range damages its target', () => {
    const world = makeBareWorld();
    const shooter = spawnUnit(world, 'ember', 0, 30, 30); // hitscan beams
    const victim = spawnUnit(world, 'anvil', 1, 33, 30);
    shooter.targetId = victim.id;

    const before = victim.shield + victim.hp;
    run(world, 40);
    assert.ok(victim.shield + victim.hp < before, 'nothing was damaged in 2 seconds of fire');
  });

  test('a mech out of range does not', () => {
    const world = makeBareWorld();
    const shooter = spawnUnit(world, 'ember', 0, 10, 10);
    const victim = spawnUnit(world, 'anvil', 1, 40, 40);
    shooter.targetId = victim.id;

    run(world, 40);
    assert.equal(victim.hp, victim.maxHp);
    assert.equal(victim.shield, victim.maxShield);
  });

  test('a salvo commits every round once the pod opens', () => {
    const world = makeBareWorld();
    const kestrel = spawnUnit(world, 'kestrel', 0, 30, 30);
    const victim = spawnUnit(world, 'anvil', 1, 33, 30);
    kestrel.targetId = victim.id;
    world.index = buildSpatialIndex(world);

    updateWeapons(world, kestrel, world.index);
    const pod = kestrel.weapons.find((w) => w.id === 'rocketpod');
    assert.equal(pod.salvoLeft, WEAPONS.rocketpod.salvo.count);
    assert.equal(pod.salvoTargetId, victim.id);
  });

  test('siege mortars cannot hit something standing on top of them', () => {
    const world = makeBareWorld();
    const longbow = spawnUnit(world, 'longbow', 0, 30, 30);
    const brawler = spawnUnit(world, 'anvil', 1, 30.5, 30); // inside minimum range
    longbow.targetId = brawler.id;

    run(world, 100);
    assert.equal(brawler.hp, brawler.maxHp, 'mortar fired inside its minimum range');
  });

  test('disabled units hold their fire', () => {
    const world = makeBareWorld();
    const shooter = spawnUnit(world, 'ember', 0, 30, 30);
    const victim = spawnUnit(world, 'anvil', 1, 33, 30);
    shooter.targetId = victim.id;
    disable(world, shooter, 60);

    run(world, 50);
    assert.equal(victim.hp, victim.maxHp);
    assert.equal(victim.shield, victim.maxShield);
  });

  test('unpowered turrets are silent', () => {
    const world = makeBareWorld();
    const turret = spawnBuilding(world, 'turret', 0, 30, 30, { complete: true });
    const victim = spawnUnit(world, 'tick', 1, 33, 31);
    turret.powered = false;

    // Deny the player any generation so the brownout survives recomputePower.
    run(world, 60);
    assert.equal(victim.hp, victim.maxHp, 'an unpowered turret fired');
  });

  test('a structure under construction cannot defend itself', () => {
    const world = makeBareWorld();
    const turret = spawnBuilding(world, 'turret', 0, 30, 30);
    const victim = spawnUnit(world, 'tick', 1, 33, 31);
    assert.ok(turret.constructing);

    run(world, 20);
    assert.equal(victim.hp, victim.maxHp);
  });
});

describe('projectiles', () => {
  test('splash damages everything in the blast, hardest at the centre', () => {
    const world = makeBareWorld();
    world.index = buildSpatialIndex(world);

    const near = spawnUnit(world, 'anvil', 1, 30, 30);
    const far = spawnUnit(world, 'anvil', 1, 31.6, 30);
    near.shield = 0;
    far.shield = 0;
    world.index = buildSpatialIndex(world);

    world.projectiles.push({
      id: 1,
      kind: 'shell',
      x: 30,
      y: 30,
      tx: 30,
      ty: 30,
      targetId: null,
      speed: 1,
      damage: 100,
      damageType: DAMAGE.EXPLOSIVE,
      splash: { radius: 2, falloff: 0.5 },
      disableTicks: 0,
      owner: 0,
      player: 0,
      life: 10,
    });

    tick(world, []);
    const nearLost = near.maxHp - near.hp;
    const farLost = far.maxHp - far.hp;
    assert.ok(nearLost > 0 && farLost > 0, 'the blast missed someone inside it');
    assert.ok(nearLost > farLost, 'falloff is not being applied');
  });

  test('an unguided shell still lands when its target dies mid-flight', () => {
    const world = makeBareWorld();
    const bystander = spawnUnit(world, 'anvil', 1, 40, 40);
    bystander.shield = 0;

    world.projectiles.push({
      id: 1,
      kind: 'shell',
      x: 36,
      y: 40,
      tx: 40,
      ty: 40,
      targetId: null,
      speed: 0.5,
      damage: 80,
      damageType: DAMAGE.EXPLOSIVE,
      splash: { radius: 2, falloff: 0.5 },
      disableTicks: 0,
      owner: 0,
      player: 0,
      life: 100,
    });

    run(world, 40);
    assert.ok(bystander.hp < bystander.maxHp, 'the shell evaporated instead of landing');
    assert.equal(world.projectiles.length, 0);
  });

  test('projectiles expire rather than accumulating forever', () => {
    const world = makeBareWorld();
    world.projectiles.push({
      id: 1,
      kind: 'tracer',
      x: 5,
      y: 5,
      tx: 5,
      ty: 5,
      targetId: 99999,
      speed: 0,
      damage: 10,
      damageType: DAMAGE.KINETIC,
      splash: null,
      disableTicks: 0,
      owner: 0,
      player: 0,
      life: 3,
    });
    run(world, 10);
    assert.equal(world.projectiles.length, 0);
  });
});
