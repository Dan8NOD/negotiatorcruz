/**
 * The simulation contract: determinism, commands, orders and victory.
 *
 * The determinism assertions are the load-bearing ones. Everything the design
 * wants later — replays, saved matches, lockstep multiplayer, a Swift port
 * that can be diffed against this one — depends on "same seed plus same
 * commands produces the same world", and that property is easy to break by
 * accident and invisible until it matters.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { makeWorld, makeBareWorld, run, runAI, hashWorld, findEntity, countOf } from './helpers.js';
import { createWorld, tick, applyCommand, visibleTo } from '../engine/sim.js';
import { spawnUnit, spawnBuilding } from '../engine/entities.js';
import { isVisible, isExplored, visibleEnemies } from '../engine/vision.js';
import { UNITS, TERRAIN } from '../engine/content.js';

describe('determinism', () => {
  test('the same seed produces the same world', () => {
    const a = createWorld({ seed: 99, players: [{ faction: 'ascendancy' }, { faction: 'bulwark' }] });
    const b = createWorld({ seed: 99, players: [{ faction: 'ascendancy' }, { faction: 'bulwark' }] });
    assert.equal(hashWorld(a), hashWorld(b));
  });

  test('different seeds do not', () => {
    const a = createWorld({ seed: 1, players: [{ faction: 'ascendancy' }, { faction: 'bulwark' }] });
    const b = createWorld({ seed: 2, players: [{ faction: 'ascendancy' }, { faction: 'bulwark' }] });
    assert.notEqual(hashWorld(a), hashWorld(b));
  });

  test('two runs of the same commands stay identical for a whole match', () => {
    const config = {
      seed: 4242,
      players: [
        { faction: 'ascendancy', isAI: true, difficulty: 'normal' },
        { faction: 'bulwark', isAI: true, difficulty: 'hard' },
      ],
    };

    const a = runAI(createWorld(config), 2400);
    const b = runAI(createWorld(config), 2400);
    assert.equal(hashWorld(a), hashWorld(b), 'the simulation desynced from itself');
  });

  test('the RNG stream is reproducible and restorable', () => {
    const world = makeWorld();
    run(world, 40);

    const checkpoint = world.rng.state();
    const first = [world.rng.next(), world.rng.next(), world.rng.next()];

    world.rng.restore(checkpoint);
    const second = [world.rng.next(), world.rng.next(), world.rng.next()];
    assert.deepEqual(first, second);
  });

  test('nothing in the engine reaches for Math.random', () => {
    // A single stray Math.random() is enough to desync a replay, and it will
    // not show up in any assertion above until it happens to matter.
    const original = Math.random;
    let calls = 0;
    Math.random = () => {
      calls++;
      return original();
    };
    try {
      runAI(makeWorld({ players: [{ faction: 'ascendancy', isAI: true }, { faction: 'bulwark', isAI: true }] }), 400);
    } finally {
      Math.random = original;
    }
    assert.equal(calls, 0, `engine called Math.random ${calls} times`);
  });
});

describe('world setup', () => {
  test('each player starts with a base, collectors and an escort', () => {
    const world = makeWorld();
    for (const player of world.players) {
      assert.equal(countOf(world, 'command', player.id), 1);
      assert.ok(countOf(world, 'collector', player.id) >= 3);
      assert.ok(
        [...world.entities.values()].some(
          (e) => e.player === player.id && e.kind === 'unit' && !e.harvest
        ),
        'no combat escort at spawn'
      );
    }
  });

  test('both players start with identical scrap', () => {
    const world = makeWorld();
    assert.equal(world.players[0].scrap, world.players[1].scrap);
  });

  test('a player only knows their own faction’s roster', () => {
    const world = makeWorld();
    assert.equal(world.players[0].faction, 'ascendancy');
    assert.equal(world.players[1].faction, 'bulwark');
  });
});

describe('commands', () => {
  test('a move order routes a unit to its destination', () => {
    const world = makeBareWorld();
    const unit = spawnUnit(world, 'vireo', 0, 20.5, 30.5);

    applyCommand(world, { type: 'move', player: 0, ids: [unit.id], x: 30.5, y: 30.5 });
    run(world, 200);

    assert.ok(Math.hypot(unit.x - 30.5, unit.y - 30.5) < 2, 'the unit never arrived');
  });

  test('a stop order cancels the current order and the queue', () => {
    const world = makeBareWorld();
    const unit = spawnUnit(world, 'vireo', 0, 20.5, 30.5);

    applyCommand(world, { type: 'move', player: 0, ids: [unit.id], x: 40.5, y: 30.5 });
    run(world, 5);
    applyCommand(world, { type: 'stop', player: 0, ids: [unit.id] });

    assert.equal(unit.order, null);
    assert.equal(unit.path.length, 0);
    assert.equal(unit.orderQueue.length, 0);
  });

  test('shift-queued orders run in sequence', () => {
    const world = makeBareWorld();
    const unit = spawnUnit(world, 'vireo', 0, 20.5, 20.5);

    applyCommand(world, { type: 'move', player: 0, ids: [unit.id], x: 30.5, y: 20.5 });
    applyCommand(world, { type: 'move', player: 0, ids: [unit.id], x: 30.5, y: 30.5, queue: true });
    assert.equal(unit.orderQueue.length, 1);

    run(world, 400);
    assert.ok(Math.hypot(unit.x - 30.5, unit.y - 30.5) < 2, 'the queued order never ran');
  });

  test('a hold order keeps a unit still', () => {
    const world = makeBareWorld();
    const unit = spawnUnit(world, 'anvil', 0, 20.5, 30.5);
    const enemy = spawnUnit(world, 'vireo', 1, 34.5, 30.5);

    applyCommand(world, { type: 'hold', player: 0, ids: [unit.id] });
    const startX = unit.x;
    run(world, 120);

    assert.ok(Math.abs(unit.x - startX) < 0.5, 'a holding unit wandered off');
    assert.ok(!enemy.dead);
  });

  test('an attack order makes a unit close on its target', () => {
    const world = makeBareWorld();
    const attacker = spawnUnit(world, 'anvil', 0, 20.5, 30.5);
    const victim = spawnUnit(world, 'vireo', 1, 34.5, 30.5);
    victim.def = { ...victim.def, speed: 0.0001 }; // pin it so the test is about pursuit

    applyCommand(world, { type: 'attack', player: 0, ids: [attacker.id], targetId: victim.id });
    run(world, 300);

    assert.ok(victim.dead || Math.hypot(attacker.x - victim.x, attacker.y - victim.y) < 6);
  });

  test('attack-move engages what it meets on the way', () => {
    const world = makeBareWorld();
    const attacker = spawnUnit(world, 'ember', 0, 20.5, 30.5);
    const bystander = spawnUnit(world, 'collector', 1, 30.5, 30.5);

    applyCommand(world, { type: 'attackMove', player: 0, ids: [attacker.id], x: 45.5, y: 30.5 });
    run(world, 400);

    assert.ok(bystander.dead || bystander.hp < bystander.maxHp, 'walked straight past an enemy');
  });

  test('commands for units the player does not own are ignored', () => {
    const world = makeBareWorld();
    const enemyUnit = spawnUnit(world, 'vireo', 1, 20.5, 30.5);

    applyCommand(world, { type: 'move', player: 0, ids: [enemyUnit.id], x: 40.5, y: 30.5 });
    assert.equal(enemyUnit.order, null, 'a player moved someone else’s unit');
  });

  test('malformed commands are ignored rather than fatal', () => {
    const world = makeWorld();
    const before = hashWorld(world);

    // A command stream arriving over a network is untrusted input.
    for (const cmd of [
      { type: 'move', player: 0 },
      { type: 'move', player: 99, ids: [1], x: 0, y: 0 },
      { type: 'attack', player: 0, ids: [1], targetId: 999999 },
      { type: 'train', player: 0, buildingId: 999999, defId: 'vireo' },
      { type: 'build', player: 0, defId: 'not_a_building', cx: 5, cy: 5 },
      { type: 'ability', player: 0, ids: [999999] },
      { type: 'nonsense', player: 0 },
      { type: 'rally', player: 0, buildingId: 999999, x: 1, y: 1 },
    ]) {
      applyCommand(world, cmd);
    }

    assert.equal(hashWorld(world), before, 'a junk command mutated the world');
  });

  test('a rally point can be set on a production building', () => {
    const world = makeBareWorld();
    const foundry = spawnBuilding(world, 'foundry', 0, 20, 20, { complete: true });
    applyCommand(world, { type: 'rally', player: 0, buildingId: foundry.id, x: 30, y: 30 });
    assert.deepEqual(foundry.rally, { x: 30, y: 30 });
  });

  test('turrets accept a target but never a move order', () => {
    const world = makeBareWorld();
    const turret = spawnBuilding(world, 'turret', 0, 20, 20, { complete: true });
    const enemy = spawnUnit(world, 'vireo', 1, 24, 21);
    const before = { x: turret.x, y: turret.y };

    applyCommand(world, { type: 'attack', player: 0, ids: [turret.id], targetId: enemy.id });
    assert.equal(turret.targetId, enemy.id);

    applyCommand(world, { type: 'move', player: 0, ids: [turret.id], x: 40, y: 40 });
    run(world, 20);
    assert.deepEqual({ x: turret.x, y: turret.y }, before, 'a turret walked away');
  });
});

describe('fog of war', () => {
  test('a player sees around their own units', () => {
    const world = makeWorld();
    const unit = findEntity(world, (e) => e.player === 0 && e.kind === 'unit');
    assert.ok(isVisible(world, 0, unit.x, unit.y));
  });

  test('the far side of the map starts unseen and unexplored', () => {
    const world = makeWorld();
    const enemyStart = world.map.starts[1];
    assert.equal(isVisible(world, 0, enemyStart.x, enemyStart.y), false);
    assert.equal(isExplored(world, 0, enemyStart.x, enemyStart.y), false);
  });

  test('explored ground stays explored after the unit leaves', () => {
    const world = makeBareWorld();
    const scout = spawnUnit(world, 'vireo', 0, 30.5, 30.5);
    run(world, 8);
    assert.ok(isExplored(world, 0, 30, 30));

    applyCommand(world, { type: 'move', player: 0, ids: [scout.id], x: 55.5, y: 55.5 });
    run(world, 400);

    assert.ok(isExplored(world, 0, 30, 30), 'the map forgot what it had seen');
    assert.equal(isVisible(world, 0, 30, 30), false, 'vision did not follow the unit');
  });

  test('enemies in the fog are not reported as visible', () => {
    const world = makeWorld();
    const seen = visibleEnemies(world, 0);
    assert.equal(seen.length, 0, 'the enemy base is visible through the fog at match start');
  });

  test('a player always sees their own units regardless of fog', () => {
    const world = makeBareWorld();
    const scout = spawnUnit(world, 'vireo', 0, 30.5, 30.5);
    // Drop it somewhere nothing of theirs has ever looked.
    scout.x = 60.5;
    scout.y = 60.5;

    const visible = visibleTo(world, 0);
    assert.ok(visible.some((e) => e.id === scout.id), 'a player lost sight of their own unit');
  });
});

describe('victory', () => {
  test('a player with nothing left is defeated and the match ends', () => {
    const world = makeWorld();

    for (const e of [...world.entities.values()]) {
      if (e.player === 1) e.dead = true;
    }
    run(world, 25);

    assert.equal(world.players[1].defeated, true);
    assert.equal(world.over, true);
    assert.equal(world.winner, 0);
  });

  test('a finished match ignores further ticks', () => {
    const world = makeWorld();
    for (const e of [...world.entities.values()]) if (e.player === 1) e.dead = true;
    run(world, 25);

    const frozen = hashWorld(world);
    run(world, 50);
    assert.equal(hashWorld(world), frozen, 'the world kept simulating after the match ended');
  });

  test('a match with both sides alive is not over', () => {
    const world = makeWorld();
    run(world, 60);
    assert.equal(world.over, false);
    assert.equal(world.winner, null);
  });
});

describe('robustness', () => {
  test('a long unattended match never throws', () => {
    const world = createWorld({
      seed: 31337,
      players: [
        { faction: 'ascendancy', isAI: true, difficulty: 'hard' },
        { faction: 'bulwark', isAI: true, difficulty: 'hard' },
      ],
    });
    runAI(world, 6000);
    assert.ok(world.tick > 0);
  });

  test('dead entities are reaped every tick', () => {
    const world = makeWorld();
    run(world, 30);
    for (const e of world.entities.values()) assert.equal(e.dead, false);
  });

  test('units never end up standing inside terrain', () => {
    const world = createWorld({
      seed: 808,
      players: [
        { faction: 'ascendancy', isAI: true },
        { faction: 'bulwark', isAI: true },
      ],
    });
    runAI(world, 3000);

    for (const e of world.entities.values()) {
      if (e.kind !== 'unit' || e.layer !== 'ground' || e.leap) continue;
      const cell = world.map.terrain[Math.floor(e.y) * world.map.width + Math.floor(e.x)];
      assert.notEqual(cell, TERRAIN.CLIFF, `${e.defId} #${e.id} is inside a cliff`);
      assert.notEqual(cell, TERRAIN.WATER, `${e.defId} #${e.id} is standing in water`);
    }
  });

  test('scrap totals never go negative', () => {
    const world = createWorld({
      seed: 55,
      players: [
        { faction: 'ascendancy', isAI: true },
        { faction: 'bulwark', isAI: true },
      ],
    });
    runAI(world, 3000);
    for (const p of world.players) assert.ok(p.scrap >= 0, `${p.name} is in debt`);
  });
});
