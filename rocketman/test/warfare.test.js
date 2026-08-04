/**
 * The Command & Conquer layer: veterancy, sell, repair, the superweapon, and
 * scrap regrowth.
 *
 * These are the mechanics that turn a working RTS into one that plays like the
 * games it is descended from — a machine that survives gets better, a damaged
 * base is worth patching, a structure you have outgrown is worth cashing out,
 * and a long game has somewhere to go other than a stalemate.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { makeBareWorld, makeEmptyWorld, makeArena, run } from './helpers.js';
import { tick, applyCommand, fireSuperweapon } from '../engine/sim.js';
import { spawnUnit, spawnBuilding, applyDamage, vetBonus } from '../engine/entities.js';
import {
  sellBuilding,
  superweaponReady,
  updateRegrowth,
  resourceAt,
} from '../engine/economy.js';
import {
  DAMAGE,
  VETERANCY,
  SELL_REFUND,
  REGROWTH,
  BUILDINGS,
  UNITS,
  TICKS_PER_SECOND,
} from '../engine/content.js';

/** Feed `killer` enough kills to reach a rank. */
function farmKills(world, killer, defId, count) {
  for (let i = 0; i < count; i++) {
    const victim = spawnUnit(world, defId, 1, killer.x + 2, killer.y);
    applyDamage(world, victim, 99999, DAMAGE.KINETIC, killer.id);
  }
}

describe('veterancy', () => {
  test('the rank table is ordered and monotonically better', () => {
    for (let i = 1; i < VETERANCY.length; i++) {
      const prev = VETERANCY[i - 1];
      const rank = VETERANCY[i];
      assert.equal(rank.rank, i);
      assert.ok(rank.killValue > prev.killValue, 'ranks must get harder to reach');
      assert.ok(rank.damage >= prev.damage, 'a promotion must never reduce damage');
      assert.ok(rank.cooldown <= prev.cooldown, 'a promotion must never slow the gun');
      assert.ok(rank.hull >= prev.hull, 'a promotion must never reduce hull');
      assert.ok(rank.name, 'the HUD needs a rank name');
    }
    assert.equal(VETERANCY[0].damage, 1, 'green units must be unmodified');
  });

  test('a unit promotes after destroying a multiple of its own cost', () => {
    const world = makeArena();
    const kestrel = spawnUnit(world, 'kestrel', 0, 30, 30);
    const need = VETERANCY[1].killValue * UNITS.kestrel.cost;

    // Just under the threshold: no promotion.
    farmKills(world, kestrel, 'tick', Math.floor(need / UNITS.tick.cost) - 1);
    assert.equal(kestrel.vet, 0, 'promoted early');

    farmKills(world, kestrel, 'tick', 2);
    assert.equal(kestrel.vet, 1, 'never promoted');
  });

  test('promotion raises max hull and heals by the amount gained', () => {
    const world = makeArena();
    const kestrel = spawnUnit(world, 'kestrel', 0, 30, 30);
    const baseHp = kestrel.maxHp;
    kestrel.hp = baseHp * 0.5;
    const before = kestrel.hp;

    farmKills(world, kestrel, 'anvil', 4);
    assert.ok(kestrel.vet >= 1);
    assert.equal(kestrel.maxHp, Math.round(baseHp * VETERANCY[kestrel.vet].hull));
    assert.ok(kestrel.hp > before, 'a promotion should be a reprieve');
    assert.ok(kestrel.hp <= kestrel.maxHp);
  });

  test('rank compounds correctly rather than stacking on the previous bonus', () => {
    const world = makeArena();
    const kestrel = spawnUnit(world, 'kestrel', 0, 30, 30);
    const baseHp = kestrel.maxHp;

    farmKills(world, kestrel, 'anvil', 12);
    assert.equal(kestrel.vet, 2, 'expected Elite');
    // The elite multiplier applies to the *base*, not to the veteran total.
    assert.equal(kestrel.maxHp, Math.round(baseHp * VETERANCY[2].hull));
  });

  test('rank stops at the top of the table', () => {
    const world = makeArena();
    const kestrel = spawnUnit(world, 'kestrel', 0, 30, 30);
    farmKills(world, kestrel, 'anvil', 60);
    assert.equal(kestrel.vet, VETERANCY.length - 1);
  });

  test('a veteran fires faster and hits harder than a green unit', () => {
    const world = makeArena();
    const green = spawnUnit(world, 'ember', 0, 20, 20);
    const veteran = spawnUnit(world, 'ember', 0, 20, 40);
    veteran.vet = 2;

    const greenTarget = spawnUnit(world, 'anvil', 1, 23, 20);
    const vetTarget = spawnUnit(world, 'anvil', 1, 23, 40);
    green.targetId = greenTarget.id;
    veteran.targetId = vetTarget.id;

    run(world, 60);

    const greenDealt = greenTarget.maxHp + greenTarget.maxShield - greenTarget.hp - greenTarget.shield;
    const vetDealt = vetTarget.maxHp + vetTarget.maxShield - vetTarget.hp - vetTarget.shield;
    assert.ok(vetDealt > greenDealt, `veteran dealt ${vetDealt}, green dealt ${greenDealt}`);
  });

  test('only elites self-repair', () => {
    const world = makeArena();
    const veteran = spawnUnit(world, 'anvil', 0, 20, 20);
    const elite = spawnUnit(world, 'anvil', 0, 20, 30);
    veteran.vet = 1;
    elite.vet = 2;
    veteran.hp = 300;
    elite.hp = 300;

    run(world, 100);
    assert.equal(veteran.hp, 300, 'a veteran should not self-repair');
    assert.ok(elite.hp > 300, 'an elite should self-repair');
    assert.ok(elite.hp <= elite.maxHp);
  });

  test('kills only count for the unit that made them', () => {
    const world = makeArena();
    const shooter = spawnUnit(world, 'kestrel', 0, 30, 30);
    const bystander = spawnUnit(world, 'kestrel', 0, 34, 30);

    farmKills(world, shooter, 'anvil', 4);
    assert.ok(shooter.vet > 0);
    assert.equal(bystander.vet, 0, 'a bystander was promoted');
  });

  test('emplacements earn rank too', () => {
    const world = makeArena();
    const turret = spawnBuilding(world, 'turret', 0, 30, 30, { complete: true });
    farmKills(world, turret, 'anvil', 6);
    assert.ok(turret.vet > 0, 'a turret that has held a line all game should improve');
  });

  test('vetBonus is safe on an entity that has never fought', () => {
    const world = makeArena();
    const fresh = spawnUnit(world, 'vireo', 0, 30, 30);
    assert.equal(vetBonus(fresh), VETERANCY[0]);
    assert.equal(vetBonus({}), VETERANCY[0]);
  });
});

describe('selling structures', () => {
  test('refunds half the cost of an intact structure', () => {
    const world = makeEmptyWorld();
    const reactor = spawnBuilding(world, 'reactor', 0, 30, 30, { complete: true });
    const before = world.players[0].scrap;

    const refund = sellBuilding(world, reactor);
    assert.equal(refund, Math.round(BUILDINGS.reactor.cost * SELL_REFUND));
    assert.equal(world.players[0].scrap, before + refund);
    assert.ok(reactor.dead);
  });

  test('refunds less for a damaged structure', () => {
    const world = makeEmptyWorld();
    const intact = spawnBuilding(world, 'reactor', 0, 30, 30, { complete: true });
    const wreck = spawnBuilding(world, 'reactor', 0, 36, 30, { complete: true });
    wreck.hp = wreck.maxHp * 0.25;

    // Otherwise "let it get shot to bits, then cash it out" is free money.
    assert.ok(sellBuilding(world, wreck) < sellBuilding(world, intact));
  });

  test('frees the footprint so something else can be built there', () => {
    const world = makeEmptyWorld();
    const reactor = spawnBuilding(world, 'reactor', 0, 30, 30, { complete: true });
    assert.notEqual(world.map.occupied[30 * world.map.width + 30], 0);

    sellBuilding(world, reactor);
    tick(world, []);
    assert.equal(world.map.occupied[30 * world.map.width + 30], 0);
  });

  test('the last Command Rig cannot be sold', () => {
    const world = makeEmptyWorld();
    const hq = spawnBuilding(world, 'command', 0, 30, 30, { complete: true });
    const before = world.players[0].scrap;

    applyCommand(world, { type: 'sell', player: 0, ids: [hq.id] });
    assert.ok(!hq.dead, 'a misclick should not end the match');
    assert.equal(world.players[0].scrap, before);
  });

  test('a second Command Rig can be sold', () => {
    const world = makeEmptyWorld();
    spawnBuilding(world, 'command', 0, 30, 30, { complete: true });
    const spare = spawnBuilding(world, 'command', 0, 40, 40, { complete: true });

    applyCommand(world, { type: 'sell', player: 0, ids: [spare.id] });
    assert.ok(spare.dead);
  });

  test('a player cannot sell someone else’s structures', () => {
    const world = makeEmptyWorld();
    const theirs = spawnBuilding(world, 'reactor', 1, 30, 30, { complete: true });
    applyCommand(world, { type: 'sell', player: 0, ids: [theirs.id] });
    assert.ok(!theirs.dead);
  });
});

describe('repairing structures', () => {
  function repairWorld() {
    const world = makeArena();
    const foundry = spawnBuilding(world, 'foundry', 0, 30, 30, { complete: true });
    foundry.hp = 200;
    world.players[0].scrap = 20000;
    return { world, foundry };
  }

  test('restores hull and charges for it', () => {
    const { world, foundry } = repairWorld();
    const before = world.players[0].scrap;

    applyCommand(world, { type: 'repair', player: 0, ids: [foundry.id], on: true });
    run(world, 200);

    assert.ok(foundry.hp > 200, 'nothing was repaired');
    assert.ok(world.players[0].scrap < before, 'the repair was free');
  });

  test('stops at full hull rather than draining scrap forever', () => {
    const { world, foundry } = repairWorld();
    applyCommand(world, { type: 'repair', player: 0, ids: [foundry.id], on: true });

    run(world, 1200);
    assert.equal(foundry.hp, foundry.maxHp);
    assert.equal(foundry.repairing, false, 'repair never switched itself off');

    const settled = world.players[0].scrap;
    run(world, 200);
    assert.equal(world.players[0].scrap, settled, 'still charging after finishing');
  });

  test('stops rather than going into debt', () => {
    const { world, foundry } = repairWorld();
    world.players[0].scrap = 30;

    applyCommand(world, { type: 'repair', player: 0, ids: [foundry.id], on: true });
    run(world, 200);

    assert.ok(world.players[0].scrap >= 0, 'repair drove the player into debt');
    assert.equal(foundry.repairing, false);
  });

  test('is a toggle', () => {
    const { world, foundry } = repairWorld();
    applyCommand(world, { type: 'repair', player: 0, ids: [foundry.id] });
    assert.equal(foundry.repairing, true);
    applyCommand(world, { type: 'repair', player: 0, ids: [foundry.id] });
    assert.equal(foundry.repairing, false);
  });

  test('a site under construction cannot be repaired', () => {
    const world = makeArena();
    const site = spawnBuilding(world, 'foundry', 0, 30, 30);
    applyCommand(world, { type: 'repair', player: 0, ids: [site.id], on: true });
    assert.equal(site.repairing, false);
  });
});

describe('the Orbital Lance', () => {
  function lanceWorld() {
    const world = makeArena();
    const lance = spawnBuilding(world, 'lance', 0, 30, 30, { complete: true });
    // Enough generation to keep it powered.
    for (let i = 0; i < 3; i++) spawnBuilding(world, 'reactor', 0, 40 + i * 3, 30, { complete: true });
    return { world, lance };
  }

  test('needs its full charge before it will fire', () => {
    const { world, lance } = lanceWorld();
    assert.equal(superweaponReady(lance), false);
    assert.equal(fireSuperweapon(world, lance, 50, 50), false);

    run(world, BUILDINGS.lance.superweapon.charge + 10);
    assert.equal(superweaponReady(lance), true);
  });

  test('does not charge while unpowered', () => {
    const world = makeArena();
    const lance = spawnBuilding(world, 'lance', 0, 30, 30, { complete: true });
    // No reactors: the Lance's own draw guarantees a brownout.
    run(world, 400);

    assert.equal(lance.powered, false, 'this test needs an actual brownout');
    assert.equal(lance.charge, 0, 'an unpowered superweapon charged anyway');
  });

  test('flattens what is under it and spares what is outside the radius', () => {
    const { world, lance } = lanceWorld();
    run(world, BUILDINGS.lance.superweapon.charge + 10);

    const radius = BUILDINGS.lance.superweapon.radius;
    const centre = spawnUnit(world, 'anvil', 1, 55, 55);
    const rim = spawnUnit(world, 'anvil', 1, 55 + radius * 0.9, 55);
    const clear = spawnUnit(world, 'anvil', 1, 55 + radius + 6, 55);

    applyCommand(world, { type: 'superweapon', player: 0, buildingId: lance.id, x: 55, y: 55 });
    run(world, TICKS_PER_SECOND + 6);

    const hurt = (e) => e.dead || e.hp < e.maxHp;
    assert.ok(hurt(centre), 'the strike missed its own aim point');
    assert.ok(hurt(rim), 'the rim of the blast did nothing');
    assert.equal(clear.hp, clear.maxHp, 'the blast reached outside its radius');
  });

  test('hits hardest at the centre', () => {
    const { world, lance } = lanceWorld();
    run(world, BUILDINGS.lance.superweapon.charge + 10);

    const centre = spawnUnit(world, 'anvil', 1, 55, 55);
    const rim = spawnUnit(world, 'anvil', 1, 55 + BUILDINGS.lance.superweapon.radius * 0.85, 55);
    centre.shield = 0;
    rim.shield = 0;

    applyCommand(world, { type: 'superweapon', player: 0, buildingId: lance.id, x: 55, y: 55 });
    run(world, TICKS_PER_SECOND + 6);

    const centreLost = centre.maxHp - centre.hp;
    const rimLost = rim.maxHp - rim.hp;
    assert.ok(centreLost > rimLost, 'falloff is not being applied');
  });

  test('lands where it was aimed, not where the target ran to', () => {
    // A superweapon you can dodge by walking is not a superweapon; the
    // telegraph is the counterplay, and it only works if the strike commits.
    const { world, lance } = lanceWorld();
    run(world, BUILDINGS.lance.superweapon.charge + 10);

    const runner = spawnUnit(world, 'vireo', 1, 55, 55);
    applyCommand(world, { type: 'superweapon', player: 0, buildingId: lance.id, x: 55, y: 55 });

    runner.x = 20;
    runner.y = 20;
    const bystander = spawnUnit(world, 'anvil', 1, 55, 55);

    run(world, TICKS_PER_SECOND + 6);
    assert.equal(runner.hp, runner.maxHp, 'the strike followed a unit that left');
    assert.ok(bystander.dead || bystander.hp < bystander.maxHp, 'the strike did not land');
  });

  test('spends its charge and has to earn it again', () => {
    const { world, lance } = lanceWorld();
    run(world, BUILDINGS.lance.superweapon.charge + 10);

    applyCommand(world, { type: 'superweapon', player: 0, buildingId: lance.id, x: 55, y: 55 });
    run(world, 40);

    assert.equal(superweaponReady(lance), false, 'the Lance fired twice');
    assert.ok(lance.charge < BUILDINGS.lance.superweapon.charge * 0.1);
  });

  test('warns the defender before it lands', () => {
    const { world, lance } = lanceWorld();
    run(world, BUILDINGS.lance.superweapon.charge + 10);

    // Through `tick`, not `applyCommand` directly: a tick clears the event
    // list before applying commands, so firing outside one would have its own
    // warning wiped by the next tick.
    tick(world, [{ type: 'superweapon', player: 0, buildingId: lance.id, x: 55, y: 55 }]);

    assert.ok(
      world.events.some((e) => e.type === 'superweaponFired'),
      'no warning was raised'
    );
  });

  test('requires a Tech Lab and a Hangar', () => {
    assert.deepEqual(BUILDINGS.lance.requires, ['techlab', 'hangar']);
  });

  test('a player cannot fire someone else’s Lance', () => {
    const { world, lance } = lanceWorld();
    run(world, BUILDINGS.lance.superweapon.charge + 10);

    applyCommand(world, { type: 'superweapon', player: 1, buildingId: lance.id, x: 55, y: 55 });
    assert.equal(superweaponReady(lance), true, 'the enemy fired our Lance');
  });
});

describe('scrap regrowth', () => {
  test('a partly worked cell recovers toward what it started with', () => {
    const world = makeBareWorld();
    const cell = world.map.fields[0].cells[0];
    const i = cell.y * world.map.width + cell.x;
    const cap = world.map.resourceMax[i];
    world.map.resource[i] = 10;

    updateRegrowth(world);
    assert.ok(world.map.resource[i] > 10, 'nothing regrew');
    assert.ok(world.map.resource[i] <= cap);
  });

  test('never exceeds what the cell originally held', () => {
    const world = makeBareWorld();
    const cell = world.map.fields[0].cells[0];
    const i = cell.y * world.map.width + cell.x;
    const cap = world.map.resourceMax[i];

    for (let n = 0; n < 500; n++) updateRegrowth(world);
    assert.equal(world.map.resource[i], cap);
  });

  test('a depleted cell comes back only if a neighbour survived', () => {
    const world = makeBareWorld();
    const field = world.map.fields[0];
    const cell = field.cells[0];
    const i = cell.y * world.map.width + cell.x;

    world.map.resource[i] = 0;
    updateRegrowth(world);
    assert.ok(world.map.resource[i] > 0, 'a cell next to live scrap should reseed');
  });

  test('a completely stripped field stays dead', () => {
    // Expanding to a fresh field has to stay the right move.
    const world = makeBareWorld();
    const field = world.map.fields[1];
    for (const c of field.cells) world.map.resource[c.y * world.map.width + c.x] = 0;

    for (let n = 0; n < 100; n++) updateRegrowth(world);
    const total = field.cells.reduce(
      (sum, c) => sum + resourceAt(world.map, c.x, c.y),
      0
    );
    assert.equal(total, 0, 'a mined-out field came back from nothing');
  });

  test('runs on its own cadence during a match', () => {
    const world = makeBareWorld();
    const cell = world.map.fields[0].cells[0];
    const i = cell.y * world.map.width + cell.x;
    world.map.resource[i] = 5;

    run(world, REGROWTH.INTERVAL * 2 + 2);
    assert.ok(world.map.resource[i] > 5, 'regrowth never ran');
  });

  test('leaves the rest of the map alone', () => {
    const world = makeBareWorld();
    // A cell that never had scrap must never grow any.
    let empty = -1;
    for (let i = 0; i < world.map.resource.length; i++) {
      if (world.map.resourceMax[i] === 0) {
        empty = i;
        break;
      }
    }
    assert.ok(empty >= 0);

    for (let n = 0; n < 100; n++) updateRegrowth(world);
    assert.equal(world.map.resource[empty], 0, 'scrap appeared on bare ground');
  });
});
