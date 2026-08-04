/**
 * Replays and mid-match saves.
 *
 * The claims under test are strong ones: a recording rebuilds the *identical*
 * world (hashWorld includes float positions, so "identical" means to the
 * bit), a resumed match continues exactly as the unbroken one would have, and
 * a mission config survives the JSON round-trip a save file forces on it.
 * Everything else — the campaign, the AI, upgrades — inherits those.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  createRecorder,
  record,
  advanceTick,
  commandsAt,
  rebuildWorld,
  serializeMatch,
  deserializeMatch,
  REPLAY_VERSION,
} from '../engine/replay.js';
import { createWorld } from '../engine/sim.js';
import { MISSIONS, missionWorldConfig } from '../engine/campaign.js';
import { hashWorld, findEntity } from './helpers.js';

const SKIRMISH = {
  seed: 4242,
  players: [
    { faction: 'ascendancy', name: 'You' },
    { faction: 'bulwark', isAI: true, difficulty: 'normal' },
  ],
};

/**
 * Play a short match the way main.js does — human commands on some ticks, the
 * AI every tick — recording as it goes. The human's script exercises the
 * command types with entity ids in them, since those are the ones that would
 * break if rebuild ordering ever drifted (an id names a different machine in a
 * different world).
 */
function playRecordedMatch(ticks) {
  const recorder = createRecorder(SKIRMISH);
  const world = createWorld(SKIRMISH);

  for (let i = 0; i < ticks; i++) {
    const commands = [];
    if (world.tick === 12) {
      const scout = findEntity(world, (e) => e.player === 0 && e.kind === 'unit' && !e.harvest);
      if (scout) commands.push({ type: 'move', player: 0, ids: [scout.id], x: 30, y: 30 });
    }
    if (world.tick === 40) {
      const hq = findEntity(world, (e) => e.player === 0 && e.defId === 'command');
      if (hq) commands.push({ type: 'train', player: 0, buildingId: hq.id, defId: 'collector' });
    }
    if (world.tick === 90) {
      const army = [...world.entities.values()]
        .filter((e) => e.player === 0 && e.kind === 'unit' && !e.harvest)
        .map((e) => e.id);
      if (army.length) commands.push({ type: 'attackMove', player: 0, ids: army, x: 44, y: 44 });
    }
    record(recorder, world.tick, commands);
    advanceTick(world, commands);
  }

  return { recorder, world };
}

describe('match recording', () => {
  test('a recorded match rebuilds to the identical world', () => {
    const { recorder, world } = playRecordedMatch(300);
    const rebuilt = rebuildWorld({ ...recorder, ticks: world.tick });
    assert.equal(hashWorld(rebuilt), hashWorld(world));
  });

  test('the file survives serialisation — the round trip is the product', () => {
    const { recorder, world } = playRecordedMatch(250);
    const save = deserializeMatch(serializeMatch(recorder, world.tick));
    assert.ok(save, 'a freshly written save failed to parse');
    assert.equal(save.ticks, world.tick);
    assert.equal(hashWorld(rebuildWorld(save)), hashWorld(world));
  });

  test('a resumed match continues exactly as the unbroken one would have', () => {
    // Split one match at tick 150: the original plays straight through to 400;
    // the copy is serialised, rebuilt, and plays the remaining ticks. Any
    // divergence — RNG state, an entity id, a float position — fails the hash.
    const { recorder, world } = playRecordedMatch(150);
    const resumed = rebuildWorld(deserializeMatch(serializeMatch(recorder, world.tick)));

    while (world.tick < 400 && !world.over) advanceTick(world, null);
    while (resumed.tick < 400 && !resumed.over) advanceTick(resumed, null);

    assert.equal(hashWorld(resumed), hashWorld(world));
  });

  test('the log is sparse — quiet ticks cost nothing', () => {
    const { recorder, world } = playRecordedMatch(300);
    assert.ok(recorder.log.length <= 3, `expected ≤3 entries, got ${recorder.log.length}`);
    assert.ok(world.tick >= 300);
    // And the sparse lookup agrees with what was recorded.
    for (const entry of recorder.log) {
      assert.deepEqual(commandsAt({ log: recorder.log }, entry.t), entry.c);
    }
    assert.equal(commandsAt({ log: recorder.log }, 13), null);
  });

  test('a mission config survives the JSON round-trip a save forces on it', () => {
    // Mission configs carry the most structure — objectives, opening forces,
    // upgrades, pilots — so this is the config most likely to smuggle in
    // something JSON silently mangles (a Set, undefined, a function).
    const mission = MISSIONS[4];
    const profile = {
      upgrades: ['srv_plating', 'ord_calibration'],
      pilots: { ash: { name: 'Ash Calder', chassis: 'kestrel', level: 3 } },
    };
    const config = missionWorldConfig(mission, profile);
    const cloned = JSON.parse(JSON.stringify(config));

    const a = createWorld(config);
    const b = createWorld(cloned);
    for (let i = 0; i < 200; i++) {
      advanceTick(a, null);
      advanceTick(b, null);
    }
    assert.equal(hashWorld(b), hashWorld(a));
  });
});

describe('save-file hostility', () => {
  test('garbage is rejected, not thrown', () => {
    for (const raw of ['', 'not json', '[]', '{}', '{"version":9}', 'null', '{"version":1}']) {
      assert.equal(deserializeMatch(raw), null, `accepted: ${raw}`);
    }
  });

  test('structural damage is rejected field by field', () => {
    const { recorder, world } = playRecordedMatch(60);
    const good = JSON.parse(serializeMatch(recorder, world.tick));

    const broken = [
      { ...good, version: REPLAY_VERSION + 1 },
      { ...good, ticks: -5 },
      { ...good, ticks: 1.5 },
      { ...good, config: null },
      { ...good, config: { ...good.config, players: [] } },
      { ...good, log: 'nope' },
      { ...good, log: [{ t: 'twelve', c: [] }] },
      { ...good, log: [{ t: 5, c: {} }] },
      // Out-of-order and duplicate ticks break the sparse lookup's early-out,
      // so an edited file with either must not load.
      { ...good, log: [{ t: 9, c: [] }, { t: 3, c: [] }] },
      { ...good, log: [{ t: 3, c: [] }, { t: 3, c: [] }] },
    ];
    for (const [i, data] of broken.entries()) {
      assert.equal(deserializeMatch(JSON.stringify(data)), null, `variant ${i} was accepted`);
    }

    // And the undamaged original still loads, so the rejections above are
    // discriminating rather than a parser that fails everything.
    assert.ok(deserializeMatch(JSON.stringify(good)));
  });

  test('a save with hostile command contents rebuilds without throwing', () => {
    // Structure passes the parser; meaning is the simulation's problem, and
    // the simulation treats every command as untrusted. A tampered log must
    // fall through applyCommand's guards, not crash the rebuild.
    const { recorder, world } = playRecordedMatch(40);
    recorder.log.push({
      t: 45,
      c: [
        { type: 'move', player: 0, ids: [999999], x: -40, y: 1e9 },
        { type: 'train', player: 0, buildingId: -1, defId: 'no_such_unit' },
        { type: 'sell', player: 1, ids: [1] },
        { type: 'not_a_command', player: 0 },
      ],
    });
    const save = deserializeMatch(serializeMatch(recorder, 80));
    assert.ok(save);
    const rebuilt = rebuildWorld(save);
    assert.equal(rebuilt.tick, 80);
    assert.equal(rebuilt.over, false);
    void world;
  });
});
