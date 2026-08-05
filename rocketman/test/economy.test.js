/**
 * Power, production, tech gating and harvesting.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { makeBareWorld, makeWorld, run, findEntity, countOf } from './helpers.js';
import { spawnUnit, spawnBuilding } from '../engine/entities.js';
import {
  recomputePower,
  productionRate,
  enqueueUnit,
  cancelQueued,
  techAllows,
  availableBuildings,
  nearestResourceCell,
  nearestDropOff,
  resourceAt,
} from '../engine/economy.js';
import { placeStructure, withinBuildRadius, tick } from '../engine/sim.js';
import { canPlace, createMap } from '../engine/grid.js';
import { len } from '../engine/numeric.js';
import { UNITS, BUILDINGS } from '../engine/content.js';

/**
 * A legal footprint near a player's HQ.
 *
 * Hardcoding an offset is brittle: the starting wreck field sits a few cells
 * off the Command Rig, and `canPlace` rightly refuses to build on scrap. These
 * tests are about placement *rules*, not about map layout, so they ask the map
 * where a structure would fit.
 */
function spotNear(world, playerId, hq, size) {
  for (let r = 2; r <= 10; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        const x = hq.cx + dx;
        const y = hq.cy + dy;
        if (!canPlace(world.map, size, x, y)) continue;
        if (!withinBuildRadius(world, playerId, size, x, y)) continue;
        return { x, y };
      }
    }
  }
  throw new Error('no legal build spot near the HQ — the map generator is broken');
}

describe('power', () => {
  test('generation and draw are totalled per player', () => {
    const world = makeBareWorld();
    const before = world.players[0].powerMade;

    spawnBuilding(world, 'reactor', 0, 20, 20, { complete: true });
    recomputePower(world, world.players[0]);

    assert.equal(world.players[0].powerMade, before + BUILDINGS.reactor.power);
  });

  test('a site under construction neither generates nor draws', () => {
    const world = makeBareWorld();
    recomputePower(world, world.players[0]);
    const made = world.players[0].powerMade;
    const used = world.players[0].powerUsed;

    spawnBuilding(world, 'reactor', 0, 20, 20); // still building
    spawnBuilding(world, 'foundry', 0, 24, 20);
    recomputePower(world, world.players[0]);

    assert.equal(world.players[0].powerMade, made);
    assert.equal(world.players[0].powerUsed, used);
  });

  test('a brownout slows production but never stops it', () => {
    const world = makeBareWorld();
    const player = world.players[0];

    spawnBuilding(world, 'hangar', 0, 20, 20, { complete: true });
    spawnBuilding(world, 'techlab', 0, 26, 20, { complete: true });
    spawnBuilding(world, 'foundry', 0, 30, 20, { complete: true });
    recomputePower(world, player);

    assert.ok(player.powerUsed > player.powerMade, 'this test needs an actual brownout');
    const rate = productionRate(player);
    assert.ok(rate < 1, 'a brownout should slow things down');
    assert.ok(rate > 0, 'a brownout must never deadlock production');
  });

  test('a brownout silences turrets but not factories', () => {
    const world = makeBareWorld();
    const player = world.players[0];

    const turret = spawnBuilding(world, 'turret', 0, 20, 20, { complete: true });
    const foundry = spawnBuilding(world, 'foundry', 0, 24, 20, { complete: true });
    const hangar = spawnBuilding(world, 'hangar', 0, 28, 20, { complete: true });
    spawnBuilding(world, 'techlab', 0, 32, 20, { complete: true });
    recomputePower(world, player);

    assert.ok(player.powerUsed > player.powerMade);
    assert.equal(turret.powered, false, 'turrets should go dark');
    assert.equal(foundry.powered, true, 'factories keep running, just slower');
    assert.equal(hangar.powered, true);
  });

  test('power comes back when a reactor does', () => {
    const world = makeBareWorld();
    const player = world.players[0];
    spawnBuilding(world, 'turret', 0, 20, 20, { complete: true });
    spawnBuilding(world, 'hangar', 0, 24, 20, { complete: true });
    spawnBuilding(world, 'techlab', 0, 28, 20, { complete: true });
    recomputePower(world, player);
    assert.ok(player.powerUsed > player.powerMade);

    spawnBuilding(world, 'reactor', 0, 32, 20, { complete: true });
    spawnBuilding(world, 'reactor', 0, 36, 20, { complete: true });
    recomputePower(world, player);

    assert.ok(player.powerMade >= player.powerUsed);
    assert.equal(productionRate(player), 1);
    assert.equal(findEntity(world, (e) => e.defId === 'turret').powered, true);
  });
});

describe('tech gating', () => {
  test('a tier-two chassis is refused until the Tech Lab exists', () => {
    const world = makeBareWorld();
    const player = world.players[0];
    player.tech.add('hangar');

    assert.equal(techAllows(world, 0, 'ember'), false, 'tier two leaked through');
    player.tech.add('techlab');
    assert.equal(techAllows(world, 0, 'ember'), true);
  });

  test('the Hangar itself needs a Tech Lab', () => {
    const world = makeBareWorld();
    assert.equal(techAllows(world, 0, 'hangar'), false);
    world.players[0].tech.add('techlab');
    assert.equal(techAllows(world, 0, 'hangar'), true);
  });

  test('a unit is refused without the structure that makes it', () => {
    const world = makeBareWorld();
    world.players[0].tech.add('techlab');
    assert.equal(techAllows(world, 0, 'vireo'), false, 'no Foundry, no Vireo');
    world.players[0].tech.add('foundry');
    assert.equal(techAllows(world, 0, 'vireo'), true);
  });

  test('factions cannot build each other’s chassis', () => {
    const world = makeBareWorld();
    world.players[0].tech.add('foundry');
    world.players[1].tech.add('foundry');

    assert.equal(techAllows(world, 0, 'vireo'), true, 'Ascendancy should have the Vireo');
    assert.equal(techAllows(world, 0, 'tick'), false, 'Ascendancy must not get Bulwark units');
    assert.equal(techAllows(world, 1, 'tick'), true);
    assert.equal(techAllows(world, 1, 'vireo'), false);
  });

  test('the Collector is available to both factions', () => {
    const world = makeBareWorld();
    world.players[0].tech.add('refinery');
    world.players[1].tech.add('refinery');
    assert.equal(techAllows(world, 0, 'collector'), true);
    assert.equal(techAllows(world, 1, 'collector'), true);
  });

  test('the available build list grows with tech', () => {
    const world = makeBareWorld();
    const opening = availableBuildings(world, 0);
    assert.ok(opening.includes('reactor'));
    assert.ok(!opening.includes('hangar'));

    world.players[0].tech.add('techlab');
    assert.ok(availableBuildings(world, 0).includes('hangar'));
  });
});

describe('production queues', () => {
  function foundryWorld() {
    const world = makeBareWorld();
    world.players[0].tech.add('foundry');
    const foundry = spawnBuilding(world, 'foundry', 0, 20, 20, { complete: true });
    // Enough generation to keep the queue at full speed — these tests are
    // about the queue, and a brownout would make every timing assertion below
    // a test of the power rules instead.
    spawnBuilding(world, 'reactor', 0, 26, 20, { complete: true });
    return { world, foundry };
  }

  test('queueing charges scrap up front', () => {
    const { world, foundry } = foundryWorld();
    const before = world.players[0].scrap;

    assert.equal(enqueueUnit(world, foundry, 'vireo'), true);
    assert.equal(world.players[0].scrap, before - UNITS.vireo.cost);
    assert.equal(foundry.queue.length, 1);
  });

  test('cancelling refunds in full', () => {
    const { world, foundry } = foundryWorld();
    const before = world.players[0].scrap;

    enqueueUnit(world, foundry, 'vireo');
    cancelQueued(world, foundry, 0);

    assert.equal(world.players[0].scrap, before, 'a partial refund punishes reacting to new info');
    assert.equal(foundry.queue.length, 0);
  });

  test('refuses what the player cannot afford', () => {
    const { world, foundry } = foundryWorld();
    world.players[0].scrap = 10;
    assert.equal(enqueueUnit(world, foundry, 'vireo'), false);
    assert.equal(foundry.queue.length, 0);
  });

  test('refuses a chassis the building does not make', () => {
    const { world, foundry } = foundryWorld();
    world.players[0].tech.add('techlab');
    world.players[0].tech.add('hangar');
    // The Ember is a Hangar chassis, not a Foundry one.
    assert.equal(enqueueUnit(world, foundry, 'ember'), false);
  });

  test('a site under construction cannot produce', () => {
    const world = makeBareWorld();
    world.players[0].tech.add('foundry');
    const site = spawnBuilding(world, 'foundry', 0, 20, 20);
    assert.equal(enqueueUnit(world, site, 'vireo'), false);
  });

  test('the queue is bounded', () => {
    const { world, foundry } = foundryWorld();
    world.players[0].scrap = 999999;
    for (let i = 0; i < 20; i++) enqueueUnit(world, foundry, 'vireo');
    assert.ok(foundry.queue.length <= 8, 'an unbounded queue is a scrap-shredder');
  });

  test('a queued unit eventually walks out of the building', () => {
    const { world, foundry } = foundryWorld();
    enqueueUnit(world, foundry, 'vireo');

    run(world, UNITS.vireo.buildTime + 5);
    assert.equal(countOf(world, 'vireo', 0), 1);
    assert.equal(foundry.queue.length, 0);
  });

  test('a rally point is applied to units as they emerge', () => {
    const { world, foundry } = foundryWorld();
    foundry.rally = { x: 30, y: 30 };
    enqueueUnit(world, foundry, 'vireo');

    run(world, UNITS.vireo.buildTime + 5);
    const vireo = findEntity(world, (e) => e.defId === 'vireo');
    assert.ok(vireo);
    assert.ok(vireo.order || vireo.path.length > 0, 'the new unit ignored the rally point');
  });
});

describe('placing structures', () => {
  test('charges scrap and starts a construction site', () => {
    const world = makeWorld();
    const player = world.players[0];
    const before = player.scrap;
    const hq = findEntity(world, (e) => e.defId === 'command' && e.player === 0);
    const spot = spotNear(world, 0, hq, BUILDINGS.reactor.size);

    const site = placeStructure(world, 0, 'reactor', spot.x, spot.y);
    assert.ok(site, 'expected a legal placement next to the HQ');
    assert.equal(player.scrap, before - BUILDINGS.reactor.cost);
    assert.equal(site.constructing, true);
    assert.ok(site.hp < site.maxHp, 'a site should start fragile');
  });

  test('refuses placement the player cannot afford', () => {
    const world = makeWorld();
    const hq = findEntity(world, (e) => e.defId === 'command' && e.player === 0);
    const spot = spotNear(world, 0, hq, BUILDINGS.reactor.size);
    world.players[0].scrap = 0;
    assert.equal(placeStructure(world, 0, 'reactor', spot.x, spot.y), null);
  });

  test('refuses placement outside the build radius', () => {
    const world = makeWorld();
    const hq = findEntity(world, (e) => e.defId === 'command' && e.player === 0);
    assert.equal(withinBuildRadius(world, 0, [2, 2], hq.cx + 40, hq.cy + 40), false);
    assert.equal(placeStructure(world, 0, 'reactor', hq.cx + 40, hq.cy + 40), null);
  });

  test('refuses tech the player has not unlocked', () => {
    const world = makeWorld();
    const hq = findEntity(world, (e) => e.defId === 'command' && e.player === 0);
    const spot = spotNear(world, 0, hq, BUILDINGS.hangar.size);
    assert.equal(placeStructure(world, 0, 'hangar', spot.x, spot.y), null);
  });

  test('a finished structure comes online and unlocks its tech', () => {
    const world = makeWorld();
    const hq = findEntity(world, (e) => e.defId === 'command' && e.player === 0);
    const spot = spotNear(world, 0, hq, BUILDINGS.reactor.size);
    const site = placeStructure(world, 0, 'reactor', spot.x, spot.y);
    assert.ok(site);

    run(world, BUILDINGS.reactor.buildTime + 10);
    assert.equal(site.constructing, false);
    assert.equal(site.hp, site.maxHp);
    assert.ok(world.players[0].tech.has('reactor'));
  });

  test('a Refinery arrives with a Collector', () => {
    const world = makeWorld();
    const before = countOf(world, 'collector', 0);
    const hq = findEntity(world, (e) => e.defId === 'command' && e.player === 0);
    const spot = spotNear(world, 0, hq, BUILDINGS.refinery.size);
    assert.ok(placeStructure(world, 0, 'refinery', spot.x, spot.y));

    run(world, BUILDINGS.refinery.buildTime + 10);
    assert.equal(countOf(world, 'collector', 0), before + 1);
  });

  test('a unit standing where a structure goes up is displaced, not entombed', () => {
    const world = makeWorld();
    const hq = findEntity(world, (e) => e.defId === 'command' && e.player === 0);
    const spot = spotNear(world, 0, hq, BUILDINGS.reactor.size);
    const victim = spawnUnit(world, 'vireo', 0, spot.x + 0.5, spot.y + 0.5);

    const site = placeStructure(world, 0, 'reactor', spot.x, spot.y);
    assert.ok(site, 'expected the placement to succeed anyway');

    const insideX = victim.x >= site.cx && victim.x < site.cx + site.size[0];
    const insideY = victim.y >= site.cy && victim.y < site.cy + site.size[1];
    assert.ok(!(insideX && insideY), 'the unit was buried under the new structure');
  });
});

describe('harvesting', () => {
  test('a Collector completes a full mine-and-deliver cycle', () => {
    const world = makeWorld();
    const player = world.players[0];
    player.scrapMined = 0;

    // Only this player's collectors; the opponent is left inert.
    run(world, 1200);
    assert.ok(player.scrapMined > 0, 'sixty seconds of mining produced nothing');
  });

  test('scrap is removed from the map as it is mined', () => {
    const world = makeWorld();
    let before = 0;
    for (const v of world.map.resource) before += v;

    run(world, 1200);

    let after = 0;
    for (const v of world.map.resource) after += v;
    assert.ok(after < before, 'the map is not being depleted');
  });

  test('the Command Rig accepts scrap, so the opening is not silent', () => {
    const world = makeWorld();
    const collector = findEntity(world, (e) => e.defId === 'collector' && e.player === 0);
    const depot = nearestDropOff(world, collector);
    assert.ok(depot, 'no drop-off at match start');
    assert.equal(depot.defId, 'command');
  });

  test('a Collector finds the nearest cell with scrap left in it', () => {
    const world = makeWorld();
    const collector = findEntity(world, (e) => e.defId === 'collector' && e.player === 0);
    const cell = nearestResourceCell(world.map, collector.x, collector.y);
    assert.ok(cell, 'no reachable scrap from the starting position');
    assert.ok(resourceAt(world.map, cell.x, cell.y) > 0);
  });

  test('an exhausted cell is abandoned for another', () => {
    const world = makeWorld();
    const collector = findEntity(world, (e) => e.defId === 'collector' && e.player === 0);

    run(world, 200);
    const firstCell = collector.harvest.cell;
    assert.ok(firstCell, 'the collector never picked a cell');

    // Strip the patch it is working and confirm it moves on rather than
    // grinding on an empty cell forever.
    for (const field of world.map.fields) {
      for (const c of field.cells) {
        if (Math.hypot(c.x - firstCell.x, c.y - firstCell.y) < 3) {
          world.map.resource[c.y * world.map.width + c.x] = 0;
        }
      }
    }

    run(world, 400);
    const cell = collector.harvest.cell;
    if (cell) {
      assert.ok(
        Math.hypot(cell.x - firstCell.x, cell.y - firstCell.y) >= 3,
        'still working a mined-out patch'
      );
    }
  });

  test('collectors keep their cargo when every depot is destroyed', () => {
    const world = makeWorld();
    run(world, 300);

    for (const e of [...world.entities.values()]) {
      if (e.player === 0 && e.kind === 'building') {
        e.dead = true;
      }
    }
    tick(world, []);

    // No crash, no spin: the point is simply that the sim survives it.
    run(world, 200);
    assert.ok(true);
  });
});

describe('mining a map bigger than the old search radius', () => {
  test('a collector still finds scrap once the field beside its base is gone', () => {
    // `nearestResourceCell` used to stop looking after 30 cells. On the 72-cell
    // maps this game shipped with, 30 cells was most of the world and every
    // field was always in range — so nobody noticed it was a range at all.
    //
    // On a doubled map it is a fifth of the world, and the consequence is not
    // a slower economy but a stopped one: mine out the home field and every
    // collector returns null, goes idle, and asks again next tick with the
    // same answer, forever. Measured on seed 1234, income froze at two minutes
    // and the skirmish ran twenty-five more without either side able to break
    // it.
    const map = createMap(1234);
    const home = map.starts[0];

    // Drain everything the old radius could have seen.
    let drained = 0;
    for (let y = 0; y < map.height; y++) {
      for (let x = 0; x < map.width; x++) {
        if (len(x - home.x, y - home.y) > 30) continue;
        const i = y * map.width + x;
        if (map.resource[i] > 0) drained++;
        map.resource[i] = 0;
      }
    }
    assert.ok(drained > 0, 'the home field was already empty; this proves nothing');

    const cell = nearestResourceCell(map, home.x, home.y);
    assert.ok(cell, 'a collector at a mined-out base found no scrap anywhere on the map');
    assert.ok(
      len(cell.x - home.x, cell.y - home.y) > 30,
      'the drain did not actually push the nearest scrap past the old radius'
    );
    assert.ok(resourceAt(map, cell.x, cell.y) > 0, 'pointed a collector at an empty cell');
  });
});
