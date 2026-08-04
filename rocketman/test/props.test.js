/**
 * Destructible terrain.
 *
 * Props are neutral entities, which buys the damage pipeline and splash for
 * free and costs one thing: every place that reasons about "the enemy" has to
 * know a tree is not one. That is not hypothetical — introducing props put
 * "the enemy base is visible at match start" and an AI that never attacked
 * into the suite, because `player !== player` was reading scenery as hostile.
 * Half of this file exists to keep that fixed.
 *
 * The other half is the mechanic worth having: props claim grid cells, so
 * A* routes around them and destroying one opens a path.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { createWorld, tick, applyCommand } from '../engine/sim.js';
import { spawnUnit, spawnProp, applyDamage, killEntity } from '../engine/entities.js';
import { createMap, isWalkable, findPath } from '../engine/grid.js';
import { PROPS, NEUTRAL_PLAYER, DAMAGE } from '../engine/content.js';
import { visibleEnemies } from '../engine/vision.js';
import { makeArena, run, findEntity, hashWorld } from './helpers.js';
import { advanceTick, createRecorder, record, rebuildWorld } from '../engine/replay.js';

const propsOf = (world) => [...world.entities.values()].filter((e) => e.kind === 'prop' && !e.dead);

describe('scenery on the map', () => {
  test('every generated map is furnished, and symmetrically', () => {
    // Same discipline as the wreck fields. A fuel station on one player's
    // approach and not the other's is unfair in a way nobody can articulate
    // while they are losing to it.
    for (const seed of [1, 7, 1234, 90210, 55]) {
      const map = createMap(seed, { width: 72, height: 72 });
      assert.ok(map.props.length > 40, `seed ${seed} generated only ${map.props.length} props`);

      const key = (defId, cx, cy) => `${defId}:${cx},${cy}`;
      const placed = new Set(map.props.map((p) => key(p.defId, p.cx, p.cy)));
      for (const p of map.props) {
        const [w, h] = PROPS[p.defId].size;
        const twin = key(p.defId, map.width - w - p.cx, map.height - h - p.cy);
        assert.ok(placed.has(twin), `seed ${seed}: ${p.defId} at ${p.cx},${p.cy} has no mirror`);
      }
    }
  });

  test('a map has a neighbourhood, a landmark and something volatile', () => {
    const kinds = new Set();
    for (const seed of [1, 7, 1234, 90210]) {
      for (const p of createMap(seed, { width: 72, height: 72 }).props) kinds.add(p.defId);
    }
    for (const want of ['house', 'tree', 'gasstation', 'statue', 'tank']) {
      assert.ok(kinds.has(want), `no ${want} on any tested seed`);
    }
  });

  test('nothing is placed on a wreck field or in a landing zone', () => {
    const map = createMap(1234, { width: 72, height: 72 });
    for (const p of map.props) {
      const [w, h] = PROPS[p.defId].size;
      for (let y = p.cy; y < p.cy + h; y++) {
        for (let x = p.cx; x < p.cx + w; x++) {
          assert.equal(map.resource[y * map.width + x], 0, `${p.defId} sits on scrap`);
          for (const s of map.starts) {
            const near = Math.abs(x - s.x) <= 7 && Math.abs(y - s.y) <= 7;
            assert.equal(near, false, `${p.defId} blocks a landing zone`);
          }
        }
      }
    }
  });

  test('they spawn into the world as neutral entities', () => {
    const world = createWorld({
      seed: 1234,
      players: [{ faction: 'ascendancy' }, { faction: 'bulwark' }],
    });
    const props = propsOf(world);
    assert.equal(props.length, world.map.props.length);
    for (const p of props) {
      assert.equal(p.player, NEUTRAL_PLAYER);
      assert.equal(p.weapons.length, 0, `${p.defId} is armed`);
    }
  });
});

describe('scenery is not the enemy', () => {
  const world = () =>
    createWorld({ seed: 1234, players: [{ faction: 'ascendancy' }, { faction: 'bulwark' }] });

  test('it is never reported as a visible enemy', () => {
    const w = world();
    for (const e of visibleEnemies(w, 0)) {
      assert.notEqual(e.kind, 'prop', 'a tree was reported as an enemy contact');
    }
  });

  test('units do not stop to demolish the landscape', () => {
    // Auto-acquisition that counted props would have every machine in the
    // game shooting trees on its way to the fight.
    const w = makeArena();
    const mech = spawnUnit(w, 'kestrel', 0, 20, 20);
    spawnProp(w, 'tree', 21, 20);
    spawnProp(w, 'house', 22, 20);
    run(w, 60);

    const tree = findEntity(w, (e) => e.defId === 'tree');
    assert.equal(tree.hp, tree.maxHp, 'a mech opened fire on a tree unprompted');
    assert.equal(mech.targetId, null);
  });

  test('but it can be attacked on purpose', () => {
    const w = makeArena();
    const mech = spawnUnit(w, 'kestrel', 0, 20, 20);
    const tree = spawnProp(w, 'tree', 22, 20);
    applyCommand(w, { type: 'attack', player: 0, ids: [mech.id], targetId: tree.id });
    run(w, 80);
    assert.ok(tree.hp < tree.maxHp, 'an ordered attack on scenery did nothing');
  });

  test('flattening it earns no rank and no kill credit', () => {
    const w = makeArena();
    const mech = spawnUnit(w, 'kestrel', 0, 20, 20);
    const before = w.players[0].stats.killed;
    for (let i = 0; i < 8; i++) {
      const prop = spawnProp(w, 'house', 24 + i * 2, 20);
      killEntity(w, prop, mech.id);
    }
    assert.equal(w.players[0].stats.killed, before, 'demolition counted as kills');
    assert.equal(mech.vet, 0, 'demolition earned veterancy');
  });

  test('it never counts toward victory or defeat', () => {
    const w = makeArena();
    spawnProp(w, 'tower', 30, 30);
    // Wipe player 1 entirely; the surviving props must not keep them alive.
    for (const e of [...w.entities.values()]) {
      if (e.player === 1) killEntity(w, e);
    }
    run(w, 40);
    assert.equal(w.players[1].defeated, true, 'props kept a dead player in the game');
  });
});

describe('knocking it down', () => {
  test('a prop blocks the grid, and destroying it opens the path', () => {
    // The mechanic, not the cleanup: a flattened tower block is a new route.
    const w = makeArena();
    const cx = 30;
    const cy = 30;
    const tower = spawnProp(w, 'tower', cx, cy);

    assert.equal(isWalkable(w.map, cx, cy), false, 'a tower block did not block its cell');
    killEntity(w, tower);
    assert.equal(isWalkable(w.map, cx, cy), true, 'the rubble is still impassable');
  });

  test('A* routes around one and straight through the gap it leaves', () => {
    const w = makeArena();
    // A wall of houses with one door, then close the door.
    const wallX = 30;
    const props = [];
    for (let y = 24; y <= 36; y++) props.push(spawnProp(w, 'house', wallX, y));

    const around = findPath(w.map, 28, 30, 34, 30);
    assert.ok(around, 'no route around the wall at all');
    const detour = around.length;

    for (const p of props) killEntity(w, p);
    const through = findPath(w.map, 28, 30, 34, 30);
    assert.ok(through.length < detour, 'demolishing the wall did not shorten the route');
  });

  test('a fuel station takes the neighbourhood with it', () => {
    const w = makeArena();
    const station = spawnProp(w, 'gasstation', 30, 30);
    const victim = spawnUnit(w, 'vireo', 0, 31.5, 31.5);
    const bystander = spawnUnit(w, 'vireo', 0, 45, 45);

    killEntity(w, station);
    assert.ok(victim.hp + victim.shield < victim.maxHp + victim.maxShield, 'the blast did nothing');
    assert.equal(bystander.hp, bystander.maxHp, 'the blast reached across the map');
  });

  test('volatile props chain', () => {
    // Splash damages props too, which is what makes a tank farm a decision
    // about where to fight rather than scenery.
    const w = makeArena();
    const farm = [];
    for (let i = 0; i < 4; i++) farm.push(spawnProp(w, 'tank', 30 + i * 2, 30));

    killEntity(w, farm[0]);
    run(w, 10);

    const standing = farm.filter((p) => !p.dead).length;
    assert.ok(standing < 3, `the chain stopped early — ${standing} of 4 still standing`);
  });

  test('a tree is not a tower — scale comes from the definition', () => {
    assert.ok(PROPS.tower.hp > PROPS.house.hp * 3);
    assert.ok(PROPS.statue.hp > PROPS.tower.hp);
    assert.ok(PROPS.gasstation.hp < PROPS.house.hp, 'fuel should be fragile');
    assert.ok(PROPS.gasstation.deathExplosion.damage > 200, 'and worth avoiding');
    for (const [id, def] of Object.entries(PROPS)) {
      assert.ok(def.height > 0, `${id} has no height for the renderer`);
      assert.ok(def.size[0] > 0 && def.size[1] > 0, `${id} has no footprint`);
    }
  });

  test('the death event carries what the renderer needs', () => {
    const w = makeArena();
    const station = spawnProp(w, 'gasstation', 30, 30);
    w.events.length = 0;
    killEntity(w, station);

    const death = w.events.find((e) => e.type === 'death' && e.kind === 'prop');
    assert.ok(death, 'no death event');
    assert.equal(death.volatile, true);
    assert.ok(death.height > 0);
  });
});

describe('scenery and determinism', () => {
  test('two worlds on one seed furnish identically', () => {
    const config = { seed: 4242, players: [{ faction: 'ascendancy' }, { faction: 'bulwark' }] };
    const a = createWorld(config);
    const b = createWorld(config);
    assert.equal(hashWorld(a), hashWorld(b));
  });

  test('a match that demolishes scenery replays to the identical world', () => {
    const config = {
      seed: 1234,
      players: [{ faction: 'ascendancy' }, { faction: 'bulwark', isAI: true }],
    };
    const recorder = createRecorder(config);
    const world = createWorld(config);

    for (let i = 0; i < 260; i++) {
      const commands = [];
      if (world.tick === 20) {
        const mech = findEntity(world, (e) => e.player === 0 && e.kind === 'unit' && !e.harvest);
        const prop = findEntity(world, (e) => e.kind === 'prop');
        if (mech && prop) {
          commands.push({ type: 'attack', player: 0, ids: [mech.id], targetId: prop.id });
        }
      }
      record(recorder, world.tick, commands);
      advanceTick(world, commands);
    }

    const rebuilt = rebuildWorld({ ...recorder, ticks: world.tick });
    assert.equal(hashWorld(rebuilt), hashWorld(world));
  });
});
