/**
 * The crew layer: hero abilities and mid-mission arrivals.
 *
 * Two things worth pinning hard. Skyfall crosses half the map on a fifteen
 * second cooldown, which is the strongest movement in the game — so its
 * range, its cooldown and its refusal to bury a pilot in a cliff all need to
 * be facts rather than intentions. And a scheduled arrival has to be exactly
 * as deterministic as everything else, or it desyncs every replay and every
 * resumed save the moment it fires.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { createWorld, applyCommand } from '../engine/sim.js';
import { spawnUnit, makeHero } from '../engine/entities.js';
import { ABILITIES, UNITS, WEAPONS, HERO_ABILITY, TICKS_PER_SECOND, TERRAIN } from '../engine/content.js';
import { HERO_SLOT, CHASSIS_SLOT, abilityReady } from '../engine/abilities.js';
import { MISSIONS, missionWorldConfig } from '../engine/campaign.js';
import { createProfile, recruitFor } from '../engine/profile.js';
import { PILOTS } from '../engine/progression.js';
import { makeArena, run, findEntity, hashWorld } from './helpers.js';
import { advanceTick, createRecorder, record, rebuildWorld } from '../engine/replay.js';

/** An arena with one hero mech in the middle. */
function withHero(chassis = 'kestrel') {
  const world = makeArena();
  const mid = Math.floor(world.map.width / 2);
  const unit = spawnUnit(world, chassis, 0, mid, mid);
  makeHero(world, unit, { id: 'ash', name: 'Test Pilot', level: 1 }, world.players[0].defs.abilities);
  return { world, unit };
}

describe('the crew ability', () => {
  test('a named pilot carries it on top of the chassis ability', () => {
    const { unit } = withHero();
    assert.ok(unit.ability, 'lost the chassis ability');
    assert.equal(unit.ability.id, 'jumpjet');
    assert.ok(unit.heroAbility, 'no crew ability');
    assert.equal(unit.heroAbility.id, HERO_ABILITY);
  });

  test('an ordinary machine of the same chassis does not', () => {
    const world = makeArena();
    const plain = spawnUnit(world, 'kestrel', 0, 20, 20);
    assert.ok(plain.ability);
    assert.equal(plain.heroAbility, null);
  });

  test('it crosses half the map', () => {
    const { world, unit } = withHero();
    const x0 = unit.x;
    const y0 = unit.y;

    // Aim well past the far edge; the engine clamps to the ability's reach
    // rather than refusing, so an over-ambitious click still leaps as far as
    // it can.
    applyCommand(world, {
      type: 'ability', player: 0, ids: [unit.id], slot: HERO_SLOT, x: x0 + 500, y: y0,
    });
    run(world, ABILITIES.skyfall.duration + 4);

    const travelled = Math.sqrt((unit.x - x0) ** 2 + (unit.y - y0) ** 2);
    assert.ok(travelled > 30, `only travelled ${travelled.toFixed(1)} cells`);
    assert.ok(travelled <= ABILITIES.skyfall.distance + 6, `overshot to ${travelled.toFixed(1)}`);
    // Half a 72-cell map, as advertised.
    assert.equal(ABILITIES.skyfall.distance, 36);
  });

  test('it comes back every fifteen seconds and not sooner', () => {
    const { world, unit } = withHero();
    assert.equal(ABILITIES.skyfall.cooldown, 15 * TICKS_PER_SECOND);

    const fire = () =>
      applyCommand(world, {
        type: 'ability', player: 0, ids: [unit.id], slot: HERO_SLOT, x: unit.x + 10, y: unit.y,
      });

    fire();
    run(world, 60);
    assert.equal(abilityReady(world, unit, HERO_SLOT), false, 'ready far too early');

    run(world, ABILITIES.skyfall.cooldown - 60 - 2);
    assert.equal(abilityReady(world, unit, HERO_SLOT), false, 'ready one tick early');

    run(world, 4);
    assert.equal(abilityReady(world, unit, HERO_SLOT), true, 'never came back');
  });

  test('the two slots cool down independently', () => {
    // Firing Skyfall must not eat the chassis ability, or a pilot's perk —
    // which is written against the chassis ability — becomes worthless.
    const { world, unit } = withHero();
    applyCommand(world, {
      type: 'ability', player: 0, ids: [unit.id], slot: HERO_SLOT, x: unit.x + 10, y: unit.y,
    });
    run(world, ABILITIES.skyfall.duration + 2);

    assert.equal(abilityReady(world, unit, HERO_SLOT), false);
    assert.equal(abilityReady(world, unit, CHASSIS_SLOT), true, 'the jump jets went on cooldown too');
  });

  test('a command with no slot still means the chassis ability', () => {
    // Matches recorded before heroes had a second slot must keep replaying.
    const { world, unit } = withHero();
    applyCommand(world, { type: 'ability', player: 0, ids: [unit.id], x: unit.x + 3, y: unit.y });
    assert.equal(abilityReady(world, unit, CHASSIS_SLOT), false, 'did not fire the chassis ability');
    assert.equal(abilityReady(world, unit, HERO_SLOT), true, 'fired the crew ability by mistake');
  });

  test('it never lands a pilot inside terrain', () => {
    // Thirty-six cells is far enough that the target is routinely under fog
    // and routinely a cliff. Burying the player character is not an option.
    const { world, unit } = withHero();
    const target = { x: Math.floor(unit.x) + 20, y: Math.floor(unit.y) };
    for (let dy = -3; dy <= 3; dy++) {
      for (let dx = -3; dx <= 3; dx++) {
        world.map.terrain[(target.y + dy) * world.map.width + target.x + dx] = TERRAIN.CLIFF;
      }
    }

    applyCommand(world, {
      type: 'ability', player: 0, ids: [unit.id], slot: HERO_SLOT, x: target.x, y: target.y,
    });
    run(world, ABILITIES.skyfall.duration + 4);

    const cell = world.map.terrain[Math.floor(unit.y) * world.map.width + Math.floor(unit.x)];
    assert.notEqual(cell, TERRAIN.CLIFF, 'the pilot is inside a cliff');
  });

  test('the AI can never field it — it is hero-only', () => {
    // The whole balance argument for half-map mobility is that only the
    // player's handful of named pilots have it.
    assert.equal(ABILITIES.skyfall.heroOnly, true);
    for (const [id, def] of Object.entries(UNITS)) {
      assert.notEqual(def.ability, HERO_ABILITY, `${id} mounts skyfall from its chassis`);
    }
  });
});

describe('new hardware', () => {
  test('every new weapon resolves and is mounted by something', () => {
    const added = ['railspike', 'stormrepeater', 'thermite', 'arcprojector', 'talon'];
    const mounted = new Set();
    for (const def of Object.values(UNITS)) for (const h of def.hardpoints || []) mounted.add(h);

    for (const id of added) {
      const w = WEAPONS[id];
      assert.ok(w, `${id} missing`);
      assert.ok(w.damage > 0 && w.range > 0 && w.cooldown > 0, `${id} has nonsense numbers`);
      assert.ok(mounted.has(id), `${id} is dead content — nothing mounts it`);
    }
  });

  test('hero chassis are unbuildable and off both faction rosters', () => {
    // Keeping them out of production is what leaves the AI's options — and
    // therefore the faction balance the suite pins — exactly as they were.
    for (const id of ['corvid', 'cinder', 'revenant']) {
      const def = UNITS[id];
      assert.ok(def, `${id} missing`);
      assert.equal(def.heroOnly, true, `${id} is not marked hero-only`);
      assert.equal(def.builtAt, undefined, `${id} can be trained at ${def.builtAt}`);
    }
  });

  test('every new pilot has a chassis and a working perk', () => {
    for (const id of ['halcyon', 'roan', 'ghost']) {
      const p = PILOTS[id];
      assert.ok(p, `${id} missing`);
      assert.ok(UNITS[p.chassis], `${id} flies unknown chassis ${p.chassis}`);
      assert.ok(p.perk && p.perk.effects.length > 0, `${id} has no perk`);
      assert.ok(p.blurb && p.blurb.length > 40, `${id} has no character`);
    }
  });
});

describe('mid-mission arrivals', () => {
  /** Mission one, set up the way the campaign sets it up. */
  function missionOne() {
    const mission = MISSIONS[0];
    const profile = recruitFor(createProfile(), mission);
    return { mission, world: createWorld(missionWorldConfig(mission, profile)) };
  }

  test('nobody arrives before their tick, and exactly one does after it', () => {
    const { mission, world } = missionOne();
    const drop = mission.reinforcements[0];
    const count = () =>
      [...world.entities.values()].filter((e) => e.pilotId === drop.pilot && !e.dead).length;

    run(world, drop.at - 2);
    assert.equal(count(), 0, 'arrived early');

    run(world, 4);
    assert.equal(count(), 1, 'did not arrive');

    // And does not keep arriving every tick afterwards.
    run(world, 200);
    assert.equal(count(), 1, 'arrived more than once');
  });

  test('the arrival is a hero, with the crew ability', () => {
    const { mission, world } = missionOne();
    run(world, mission.reinforcements[0].at + 4);

    const arrival = findEntity(world, (e) => e.pilotId === 'halcyon');
    assert.ok(arrival, 'no arrival');
    assert.equal(arrival.player, 0, 'arrived on the wrong side');
    assert.equal(arrival.defId, PILOTS.halcyon.chassis);
    assert.ok(arrival.heroAbility, 'the new pilot cannot Skyfall');
    assert.ok(arrival.pilotName, 'arrived anonymous');
  });

  test('it announces itself, so it cannot land off-screen unnoticed', () => {
    const { mission, world } = missionOne();
    run(world, mission.reinforcements[0].at - 1);

    let event = null;
    for (let i = 0; i < 6 && !event; i++) {
      run(world, 1);
      event = world.events.find((e) => e.type === 'reinforcement');
    }
    assert.ok(event, 'arrived silently');
    assert.equal(event.player, 0);
    assert.ok(event.message, 'no message for the player');
    assert.ok(event.ids.length > 0);
  });

  test('every scheduled arrival names a pilot the campaign knows', () => {
    for (const mission of MISSIONS) {
      for (const drop of mission.reinforcements || []) {
        assert.ok(PILOTS[drop.pilot], `${mission.id} schedules unknown pilot ${drop.pilot}`);
        assert.ok(drop.at > 0, `${mission.id} arrival has no time`);
        assert.ok(drop.message, `${mission.id} arrival says nothing`);
      }
    }
  });

  test('an arrival replays to the identical world', () => {
    // Scheduled spawns change entity ids and the RNG's consumers, so a
    // reinforcement that is not perfectly deterministic desyncs every replay
    // and every resumed save the moment it fires.
    const mission = MISSIONS[0];
    const profile = recruitFor(createProfile(), mission);
    const config = missionWorldConfig(mission, profile);
    const drop = mission.reinforcements[0];

    const recorder = createRecorder(config);
    const world = createWorld(config);
    for (let i = 0; i < drop.at + 60; i++) {
      const commands = [];
      if (world.tick === 10) {
        const hero = findEntity(world, (e) => e.player === 0 && e.pilotId === 'ash');
        if (hero) commands.push({ type: 'steer', player: 0, ids: [hero.id], dx: 1, dy: 0 });
      }
      record(recorder, world.tick, commands);
      advanceTick(world, commands);
    }

    const rebuilt = rebuildWorld({ ...recorder, ticks: world.tick });
    assert.equal(hashWorld(rebuilt), hashWorld(world));
    assert.ok(findEntity(rebuilt, (e) => e.pilotId === drop.pilot), 'the arrival did not replay');
  });

  test('a skirmish schedules nothing — reinforcements are campaign data', () => {
    const world = createWorld({
      seed: 5,
      players: [{ faction: 'ascendancy' }, { faction: 'bulwark', isAI: true }],
    });
    run(world, 900);
    assert.deepEqual(world.reinforced, []);
    assert.equal(findEntity(world, (e) => e.pilotId), null);
  });
});
