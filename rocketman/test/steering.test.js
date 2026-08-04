/**
 * Direct control: driving a machine from the keyboard.
 *
 * The interesting properties are the ones that would let a piloted mech
 * escape the rules everything else obeys — walking through cliffs, ignoring
 * EMP, mining while being driven — plus the two that keep the feature honest
 * with the rest of the architecture: it goes through the command stream like
 * everything else, so it replays; and the vector is sticky, so holding a key
 * costs one command rather than twenty a second.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { tick, applyCommand } from '../engine/sim.js';
import { spawnUnit } from '../engine/entities.js';
import { TERRAIN } from '../engine/content.js';
import { makeArena, run, findEntity, hashWorld } from './helpers.js';
import { advanceTick, createRecorder, record, rebuildWorld } from '../engine/replay.js';

/** A driveable mech placed in open ground away from either base. */
function withMech(overrides = {}) {
  const world = makeArena(overrides);
  const mid = Math.floor(world.map.width / 2);
  const unit = spawnUnit(world, 'kestrel', 0, mid, mid);
  return { world, unit };
}

const steer = (unit, dx, dy) => ({ type: 'steer', player: 0, ids: [unit.id], dx, dy });

describe('direct control', () => {
  test('a steer command moves the machine in that direction', () => {
    const { world, unit } = withMech();
    const x0 = unit.x;
    const y0 = unit.y;

    applyCommand(world, steer(unit, 1, 0));
    run(world, 20);

    assert.ok(unit.x > x0 + 0.5, `expected eastward travel, moved ${unit.x - x0}`);
    assert.ok(Math.abs(unit.y - y0) < 0.4, 'drifted off the axis');
  });

  test('the vector is sticky — one command drives until it is changed', () => {
    const { world, unit } = withMech();
    applyCommand(world, steer(unit, 0, 1));

    const first = unit.y;
    run(world, 10);
    const second = unit.y;
    run(world, 10);

    assert.ok(second > first, 'did not move on the first stretch');
    assert.ok(unit.y > second, 'stopped without being told to');
    // No further commands were issued in between — that is the point.
  });

  test('a zero vector hands the machine back and it stops where it stands', () => {
    const { world, unit } = withMech();
    applyCommand(world, steer(unit, 1, 0));
    run(world, 15);

    applyCommand(world, steer(unit, 0, 0));
    const stopped = { x: unit.x, y: unit.y };
    run(world, 25);

    assert.equal(unit.steer, null);
    assert.ok(Math.abs(unit.x - stopped.x) < 0.001, 'kept moving after release');
    assert.ok(Math.abs(unit.y - stopped.y) < 0.001, 'kept moving after release');
  });

  test('diagonals travel on both axes without exceeding the unit speed', () => {
    const { world, unit } = withMech();
    const x0 = unit.x;
    const y0 = unit.y;

    applyCommand(world, steer(unit, 1, 1));
    run(world, 20);

    const dx = unit.x - x0;
    const dy = unit.y - y0;
    assert.ok(dx > 0.3 && dy > 0.3, `expected both axes, got ${dx},${dy}`);

    // A normalised diagonal must not out-run a straight line — the classic
    // bug where holding two keys makes you 41% faster.
    const straight = withMech();
    applyCommand(straight.world, steer(straight.unit, 1, 0));
    const sx0 = straight.unit.x;
    run(straight.world, 20);
    const straightDist = straight.unit.x - sx0;
    const diagonalDist = Math.sqrt(dx * dx + dy * dy);

    assert.ok(
      diagonalDist <= straightDist + 0.01,
      `diagonal ${diagonalDist.toFixed(3)} beat straight ${straightDist.toFixed(3)}`
    );
  });

  test('driving obeys terrain — a cliff still stops you', () => {
    const { world, unit } = withMech();
    // Wall off everything east of the mech.
    const wallX = Math.floor(unit.x) + 2;
    for (let y = 0; y < world.map.height; y++) {
      world.map.terrain[y * world.map.width + wallX] = TERRAIN.CLIFF;
    }

    applyCommand(world, steer(unit, 1, 0));
    run(world, 60);

    assert.ok(unit.x < wallX, `walked into the cliff at ${unit.x}`);
  });

  test('driving obeys EMP — a disabled machine does not move', () => {
    const { world, unit } = withMech();
    unit.disabledUntil = world.tick + 40;

    const x0 = unit.x;
    applyCommand(world, steer(unit, 1, 0));
    run(world, 20);

    assert.ok(Math.abs(unit.x - x0) < 0.001, 'drove while disabled by EMP');
  });

  test('an order takes the machine back off the sticks', () => {
    const { world, unit } = withMech();
    applyCommand(world, steer(unit, 1, 0));
    run(world, 5);
    assert.ok(unit.steer, 'precondition: should be under direct control');

    applyCommand(world, { type: 'move', player: 0, ids: [unit.id], x: unit.x, y: unit.y + 6 });
    assert.equal(unit.steer, null, 'a move order left the steer vector in place');
  });

  test('a stop command releases direct control', () => {
    const { world, unit } = withMech();
    applyCommand(world, steer(unit, -1, 0));
    run(world, 5);

    applyCommand(world, { type: 'stop', player: 0, ids: [unit.id] });
    assert.equal(unit.steer, null);
  });

  test('driving a Collector suspends harvesting rather than fighting it', () => {
    // makeArena strips every unit, so the Collector and the field it works
    // are both placed here rather than assumed.
    const world = makeArena();
    let field = null;
    for (let i = 0; i < world.map.resource.length && !field; i++) {
      if (world.map.resource[i] > 0) {
        field = { x: (i % world.map.width) + 0.5, y: Math.floor(i / world.map.width) + 0.5 };
      }
    }
    assert.ok(field, 'the generated map has no scrap at all');

    const collector = spawnUnit(world, 'collector', 0, field.x, field.y + 2);
    applyCommand(world, { type: 'harvest', player: 0, ids: [collector.id], x: field.x, y: field.y });
    run(world, 10);

    const y0 = collector.y;
    applyCommand(world, steer(collector, 0, 1));
    run(world, 25);

    assert.ok(collector.y > y0 + 0.4, 'the harvest loop overrode the driver');
    assert.equal(collector.order, null);
  });

  test('you cannot drive another player’s machine', () => {
    const { world } = withMech();
    const enemy = spawnUnit(world, 'tick', 1, 30, 30);
    const x0 = enemy.x;

    applyCommand(world, { type: 'steer', player: 0, ids: [enemy.id], dx: 1, dy: 0 });
    run(world, 20);

    assert.equal(enemy.steer, null);
    assert.ok(Math.abs(enemy.x - x0) < 0.001);
  });

  test('a driven match replays to the identical world', () => {
    // Direct control has to be ordinary command traffic, or it silently
    // breaks replays and mid-match saves — which is exactly the kind of
    // regression that only shows up weeks later in someone's save file.
    const config = {
      seed: 909,
      players: [{ faction: 'ascendancy' }, { faction: 'bulwark', isAI: true }],
    };
    const recorder = createRecorder(config);
    const world = rebuildWorld({ ...recorder, ticks: 0 });

    let driver = null;
    for (let i = 0; i < 200; i++) {
      const commands = [];
      if (world.tick === 5) {
        driver = findEntity(world, (e) => e.player === 0 && e.kind === 'unit' && !e.harvest);
        if (driver) commands.push(steer(driver, 1, 1));
      }
      if (world.tick === 60 && driver) commands.push(steer(driver, -1, 0));
      if (world.tick === 120 && driver) commands.push(steer(driver, 0, 0));
      record(recorder, world.tick, commands);
      advanceTick(world, commands);
    }

    const rebuilt = rebuildWorld({ ...recorder, ticks: world.tick });
    assert.equal(hashWorld(rebuilt), hashWorld(world));
    // And the drive was actually recorded, rather than the test proving that
    // two idle worlds match.
    assert.equal(recorder.log.length, 3);
  });

  test('a driven machine still shoots what wanders into range', () => {
    // The whole appeal of piloting one: you drive, it fights.
    const { world, unit } = withMech();
    const victim = spawnUnit(world, 'tick', 1, unit.x + 2, unit.y);
    victim.order = { type: 'hold' };

    applyCommand(world, steer(unit, 0, 1));
    run(world, 40);

    assert.ok(victim.hp < victim.maxHp, 'the driven mech never opened fire');
  });
});

describe('steering and the tick contract', () => {
  test('steering is applied at the top of a tick like every other command', () => {
    const { world, unit } = withMech();
    const x0 = unit.x;
    // Passed into tick() rather than applyCommand'd directly — the path a
    // real keypress takes.
    tick(world, [steer(unit, 1, 0)]);
    assert.ok(unit.x > x0, 'the command did not take effect on its own tick');
  });
});
