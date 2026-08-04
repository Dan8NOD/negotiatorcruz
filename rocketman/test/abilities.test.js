/**
 * Active abilities and the movement rules they bend.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { makeBareWorld, run, findEntity } from './helpers.js';
import { spawnUnit, spawnBuilding, applyDamage, buildSpatialIndex, disable } from '../engine/entities.js';
import { activateAbility, abilityReady, updateAbilities, suggestAbility } from '../engine/abilities.js';
import { setPath, currentSpeed } from '../engine/movement.js';
import { ABILITIES, DAMAGE, TERRAIN, TICKS_PER_SECOND } from '../engine/content.js';
import { tick } from '../engine/sim.js';

/** Wall off a column so only a leap can cross it. */
function partition(world, x, y0, y1) {
  for (let y = y0; y <= y1; y++) world.map.terrain[y * world.map.width + x] = TERRAIN.CLIFF;
}

describe('jump jets', () => {
  test('carry the Rocketman over terrain it could never walk across', () => {
    const world = makeBareWorld();
    const kestrel = spawnUnit(world, 'kestrel', 0, 20.5, 30.5);
    partition(world, 23, 20, 40);

    assert.ok(activateAbility(world, kestrel, 26.5, 30.5), 'the leap did not fire');
    run(world, ABILITIES.jumpjet.duration + 4);

    assert.ok(kestrel.x > 23, 'the Kestrel never crossed the wall');
    assert.equal(kestrel.leap, null, 'the leap never finished');
  });

  test('are clamped to the ability’s range rather than refused', () => {
    const world = makeBareWorld();
    const kestrel = spawnUnit(world, 'kestrel', 0, 20.5, 30.5);

    // A click far beyond range should leap as far as it can, not do nothing.
    assert.ok(activateAbility(world, kestrel, 90, 30.5));
    run(world, ABILITIES.jumpjet.duration + 4);

    const travelled = kestrel.x - 20.5;
    assert.ok(travelled > 1, 'the leap went nowhere');
    assert.ok(travelled <= ABILITIES.jumpjet.distance + 0.5, 'the leap exceeded its range');
  });

  test('never leave a unit stranded inside solid terrain', () => {
    const world = makeBareWorld();
    const kestrel = spawnUnit(world, 'kestrel', 0, 20.5, 30.5);
    // Aim the landing squarely into a cliff.
    for (let y = 24; y <= 28; y++) {
      for (let x = 24; x <= 28; x++) world.map.terrain[y * world.map.width + x] = TERRAIN.CLIFF;
    }

    activateAbility(world, kestrel, 26.5, 26.5);
    run(world, ABILITIES.jumpjet.duration + 6);

    const cell = world.map.terrain[Math.floor(kestrel.y) * world.map.width + Math.floor(kestrel.x)];
    assert.notEqual(cell, TERRAIN.CLIFF, 'the Kestrel landed inside a cliff');
  });

  test('go on cooldown and cannot be spammed', () => {
    const world = makeBareWorld();
    const kestrel = spawnUnit(world, 'kestrel', 0, 20.5, 30.5);

    assert.ok(activateAbility(world, kestrel, 24, 30.5));
    assert.equal(abilityReady(world, kestrel), false);
    assert.equal(activateAbility(world, kestrel, 26, 30.5), false, 'fired twice back to back');

    run(world, ABILITIES.jumpjet.cooldown + 2);
    assert.equal(abilityReady(world, kestrel), true, 'the cooldown never expired');
  });
});

describe('Afterburn', () => {
  test('temporarily raises movement speed and then wears off', () => {
    const world = makeBareWorld();
    const vireo = spawnUnit(world, 'vireo', 0, 20.5, 30.5);
    const base = currentSpeed(world, vireo);

    activateAbility(world, vireo, vireo.x, vireo.y);
    assert.ok(currentSpeed(world, vireo) > base, 'Afterburn did not speed the unit up');

    run(world, ABILITIES.dash.duration + 4);
    assert.equal(currentSpeed(world, vireo), base, 'the speed boost never expired');
  });

  test('actually covers more ground', () => {
    const world = makeBareWorld();
    const plain = spawnUnit(world, 'vireo', 0, 20.5, 30.5);
    const boosted = spawnUnit(world, 'vireo', 0, 20.5, 40.5);

    setPath(world, plain, 45, 30.5);
    setPath(world, boosted, 45, 40.5);
    activateAbility(world, boosted, boosted.x, boosted.y);

    run(world, ABILITIES.dash.duration);
    assert.ok(boosted.x > plain.x, 'the boosted unit did not outpace the plain one');
  });
});

describe('Aegis field', () => {
  test('soaks damage before the native shield does', () => {
    const world = makeBareWorld();
    const anvil = spawnUnit(world, 'anvil', 0, 20.5, 30.5);
    activateAbility(world, anvil, anvil.x, anvil.y);

    const nativeShield = anvil.shield;
    applyDamage(world, anvil, 100, DAMAGE.KINETIC);

    assert.equal(anvil.shield, nativeShield, 'the native shield was spent first');
    assert.equal(anvil.tempShield, ABILITIES.overshield.amount - 100);
    assert.equal(anvil.hp, anvil.maxHp);
  });

  test('expires on schedule', () => {
    const world = makeBareWorld();
    const anvil = spawnUnit(world, 'anvil', 0, 20.5, 30.5);
    activateAbility(world, anvil, anvil.x, anvil.y);
    assert.ok(anvil.tempShield > 0);

    run(world, ABILITIES.overshield.duration + 4);
    assert.equal(anvil.tempShield, 0, 'the temporary shield never expired');
  });
});

describe('Deploy', () => {
  test('takes time to anchor, and pins the unit once anchored', () => {
    const world = makeBareWorld();
    const longbow = spawnUnit(world, 'longbow', 0, 20.5, 30.5);

    activateAbility(world, longbow, longbow.x, longbow.y);
    assert.equal(longbow.deployed, false, 'deploy should not be instant');
    assert.equal(currentSpeed(world, longbow), 0, 'the unit should be pinned while deploying');

    run(world, ABILITIES.siege.duration + 2);
    assert.equal(longbow.deployed, true);
    assert.equal(currentSpeed(world, longbow), 0, 'a deployed siege unit must not move');
  });

  test('can be reversed', () => {
    const world = makeBareWorld();
    const longbow = spawnUnit(world, 'longbow', 0, 20.5, 30.5);

    activateAbility(world, longbow, longbow.x, longbow.y);
    run(world, ABILITIES.siege.duration + ABILITIES.siege.cooldown + 4);
    assert.equal(longbow.deployed, true);

    activateAbility(world, longbow, longbow.x, longbow.y);
    run(world, ABILITIES.siege.duration + 2);
    assert.equal(longbow.deployed, false, 'the unit could not pack up again');
    assert.ok(currentSpeed(world, longbow) > 0);
  });
});

describe('Field Repair', () => {
  test('heals nearby friendly mechs and not enemies', () => {
    const world = makeBareWorld();
    const ward = spawnUnit(world, 'ward', 0, 20.5, 30.5);
    const friend = spawnUnit(world, 'anvil', 0, 22, 30.5);
    const foe = spawnUnit(world, 'kestrel', 1, 22, 32);

    friend.hp = 400;
    foe.hp = 400;

    // Disarm everyone. Repair radius is smaller than autocannon range, so an
    // enemy standing inside the field is also standing inside three weapons —
    // and "the enemy's hull went down" would prove nothing about healing.
    for (const e of [ward, friend, foe]) e.weapons = [];

    activateAbility(world, ward, ward.x, ward.y);
    run(world, ABILITIES.repairfield.duration);

    assert.ok(friend.hp > 400, 'the friendly mech was not repaired');
    assert.equal(foe.hp, 400, 'the enemy was repaired');
  });

  test('never heals past full', () => {
    const world = makeBareWorld();
    const ward = spawnUnit(world, 'ward', 0, 20.5, 30.5);
    const friend = spawnUnit(world, 'anvil', 0, 22, 30.5);
    friend.hp = friend.maxHp - 5;

    activateAbility(world, ward, ward.x, ward.y);
    run(world, ABILITIES.repairfield.duration + 4);
    assert.equal(friend.hp, friend.maxHp);
  });

  test('does not repair structures', () => {
    const world = makeBareWorld();
    const ward = spawnUnit(world, 'ward', 0, 20.5, 30.5);
    const reactor = spawnBuilding(world, 'reactor', 0, 22, 30, { complete: true });
    reactor.hp = 300;

    activateAbility(world, ward, ward.x, ward.y);
    run(world, ABILITIES.repairfield.duration);
    assert.equal(reactor.hp, 300, 'field repair is for mechs, not buildings');
  });
});

describe('EMP burst', () => {
  test('disables enemies in the blast and spares friendlies', () => {
    const world = makeBareWorld();
    const gale = spawnUnit(world, 'gale', 0, 20.5, 30.5);
    const foe = spawnUnit(world, 'anvil', 1, 24, 30.5);
    const friend = spawnUnit(world, 'vireo', 0, 24, 31);
    world.index = buildSpatialIndex(world);

    activateAbility(world, gale, 24, 30.5);

    assert.ok(foe.disabledUntil > world.tick, 'the enemy was not disabled');
    assert.equal(friend.disabledUntil, 0, 'friendly fire from an EMP burst');
  });

  test('a disabled unit cannot move', () => {
    const world = makeBareWorld();
    const anvil = spawnUnit(world, 'anvil', 0, 20.5, 30.5);
    disable(world, anvil, 40);
    assert.equal(currentSpeed(world, anvil), 0);

    run(world, 45);
    assert.ok(currentSpeed(world, anvil) > 0, 'the disable never wore off');
  });

  test('a disabled unit cannot fire its abilities either', () => {
    const world = makeBareWorld();
    const kestrel = spawnUnit(world, 'kestrel', 0, 20.5, 30.5);
    disable(world, kestrel, 40);
    assert.equal(activateAbility(world, kestrel, 24, 30.5), false);
  });
});

describe('ability suggestions', () => {
  test('the panic shield is suggested only when a unit is actually hurt', () => {
    const world = makeBareWorld();
    const anvil = spawnUnit(world, 'anvil', 0, 20.5, 30.5);
    spawnUnit(world, 'kestrel', 1, 23, 30.5);
    world.index = buildSpatialIndex(world);

    assert.equal(suggestAbility(world, anvil, world.index), null, 'cast at full health');

    anvil.hp = anvil.maxHp * 0.5;
    assert.ok(suggestAbility(world, anvil, world.index), 'never cast under fire');
  });

  test('nothing is suggested for a unit on cooldown', () => {
    const world = makeBareWorld();
    const anvil = spawnUnit(world, 'anvil', 0, 20.5, 30.5);
    spawnUnit(world, 'kestrel', 1, 23, 30.5);
    anvil.hp = anvil.maxHp * 0.4;
    world.index = buildSpatialIndex(world);

    activateAbility(world, anvil, anvil.x, anvil.y);
    assert.equal(suggestAbility(world, anvil, world.index), null);
  });

  test('units with no ability are handled without throwing', () => {
    const world = makeBareWorld();
    const collector = spawnUnit(world, 'collector', 0, 20.5, 30.5);
    world.index = buildSpatialIndex(world);

    assert.equal(collector.ability, null);
    assert.equal(activateAbility(world, collector, 24, 30), false);
    updateAbilities(world, collector, world.index);
    assert.ok(true);
  });
});
