/**
 * Challenges: the two ways off a map.
 *
 * Destroy the headquarters and the shaft under it is uncovered; kill the Robot
 * Marine and the castle's great door opens. Both are one system, and most of
 * what can go wrong with it is not "does it open" — that part is four lines —
 * but everything a neutral, indestructible, walk-into-me entity does to the
 * systems it was dropped into:
 *
 *   - an army that stops to shoot the way out never takes it
 *   - crowd avoidance that shoves machines out of a doorway makes the door
 *     impossible to walk through
 *   - a castle you can demolish makes the guard in front of it optional
 *   - a gateway counted as a player's entity would change who has been
 *     annihilated
 *
 * Every one of those is a real failure this file caught. The two "does it
 * open" tests are the cheap ones.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { createWorld, tick } from '../engine/sim.js';
import { spawnUnit, killEntity, applyDamage, isCombatant } from '../engine/entities.js';
import { createMap, findPath, nearestWalkable } from '../engine/grid.js';
import { PROPS, UNITS, DAMAGE, GATEWAY_KINDS, BIOMES, NEUTRAL_PLAYER } from '../engine/content.js';
import { acquireTarget } from '../engine/combat.js';
import { buildSpatialIndex } from '../engine/entities.js';
import { CHALLENGES, MISSIONS, ALL_MISSIONS, missionById, missionWorldConfig } from '../engine/campaign.js';
import {
  createProfile,
  recruitFor,
  applyMissionResult,
  challengeUnlocked,
  visibleChallenges,
  deserialize,
  serialize,
} from '../engine/profile.js';
import { gatewayLandmarks } from '../engine/gateways.js';
import { run, runAI, hashWorld } from './helpers.js';
import { advanceTick, createRecorder, record, rebuildWorld } from '../engine/replay.js';

/** A challenge world, standing where the game would stand it. */
function challengeWorld(id) {
  const mission = missionById(id);
  const profile = recruitFor(createProfile(), mission);
  return { mission, world: createWorld(missionWorldConfig(mission, profile)) };
}

const gatewayEntities = (world) =>
  [...world.entities.values()].filter((e) => e.kind === 'gateway' && !e.dead);

/** Walk the world forward until a gateway opens, or give up. */
function runUntilOpen(world, gateway, ticks = 40) {
  for (let i = 0; i < ticks && !gateway.open; i++) tick(world, []);
  return gateway.open;
}

describe('the landmarks a challenge is built on', () => {
  test('every challenge places the landmark its gateways name', () => {
    for (const mission of CHALLENGES) {
      const wanted = gatewayLandmarks(mission);
      if (wanted.length === 0) continue;
      const { world } = challengeWorld(mission.id);
      for (const defId of wanted) {
        assert.ok(
          world.map.landmarks[defId],
          `${mission.id} declares a gateway on a ${defId} the map never placed`
        );
        const standing = [...world.entities.values()].filter((e) => e.defId === defId);
        assert.equal(standing.length, 1, `${mission.id} has ${standing.length} ${defId}s`);
      }
    }
  });

  test('a landmark is placed by fiat rather than by luck', () => {
    // The whole reason placement flattens the ground and strips the scrap:
    // a challenge that only works on seeds where a 6×6 footprint happened to
    // find a home is a lottery, not a challenge.
    for (let shift = 0; shift < 12; shift++) {
      const map = createMap(80559 + shift, {
        width: 128,
        height: 128,
        landmarks: ['castle'],
      });
      const at = map.landmarks.castle;
      assert.ok(at, `seed shift ${shift} produced no castle`);
      assert.ok(map.props.some((p) => p.defId === 'castle'), 'the castle is not on the map');
    }
  });

  test('there is a way round to the door on every seed', () => {
    // A castle nobody can walk round is a castle whose door nobody can reach,
    // which is a mission that cannot be completed rather than a hard one.
    for (let shift = 0; shift < 8; shift++) {
      const map = createMap(80559 + shift, { width: 128, height: 128, landmarks: ['castle'] });
      const at = map.landmarks.castle;
      const door = PROPS.castle.door;
      const from = nearestWalkable(map, map.starts[0].x, map.starts[0].y, 12);
      const to = nearestWalkable(map, at.cx + door[0], at.cy + door[1], 8);
      assert.ok(to, `seed shift ${shift}: nowhere to stand at the door`);
      assert.ok(findPath(map, from.x, from.y, to.x, to.y), `seed shift ${shift}: door unreachable`);
    }
  });

  test('the castle does not fall, and the headquarters does', () => {
    // The one deliberate exception to "the map is destructible", and the
    // reason for it: a wall you can demolish makes the door guard optional.
    const { world } = challengeWorld('bastion');
    const castle = [...world.entities.values()].find((e) => e.defId === 'castle');
    const before = castle.hp;
    applyDamage(world, castle, 999999, DAMAGE.EXPLOSIVE, 0);
    assert.equal(castle.dead, false, 'the castle came down');
    assert.equal(castle.hp, before, 'the castle took damage it should have shrugged off');

    const hq = [...challengeWorld('ironhold').world.entities.values()].find(
      (e) => e.defId === 'headquarters'
    );
    assert.ok(hq.hp > 0 && !hq.invulnerable, 'the headquarters must be destructible');
  });
});

describe('opening the way', () => {
  test('levelling the headquarters uncovers the shaft', () => {
    const { world } = challengeWorld('ironhold');
    const [gateway] = world.gateways;

    tick(world, []);
    assert.equal(gateway.open, false, 'the shaft was open before the building fell');
    assert.equal(gatewayEntities(world).length, 0);

    killEntity(world, world.entities.get(gateway.keyId));
    assert.ok(runUntilOpen(world, gateway), 'the shaft never opened');

    const [marker] = gatewayEntities(world);
    assert.ok(marker, 'no marker entity was spawned');
    assert.equal(marker.gatewayId, gateway.id);
    // Where the building stood, so the player looks where they were fighting.
    assert.ok(Math.abs(marker.x - gateway.x) < 0.001 && Math.abs(marker.y - gateway.y) < 0.001);
  });

  test('killing the Robot Marine opens the great door, and nothing else does', () => {
    const { world } = challengeWorld('bastion');
    const [gateway] = world.gateways;
    const guard = world.entities.get(gateway.keyId);

    assert.equal(guard.defId, 'marine', 'the door is guarded by something else');
    assert.equal(guard.player, 1, 'the guard is not the enemy’s');

    // A hundred ticks of the guard standing there is not an opening.
    run(world, 100);
    assert.equal(gateway.open, false, 'the door opened on its own');

    killEntity(world, world.entities.get(gateway.keyId));
    assert.ok(runUntilOpen(world, gateway), 'the door never opened');
  });

  test('the guard stands in the doorway, not at the enemy base', () => {
    // A guard listed in the enemy's opening forces would walk off to fight the
    // war, and the door would be unguarded by minute two.
    const { world } = challengeWorld('bastion');
    const [gateway] = world.gateways;
    const guard = world.entities.get(gateway.keyId);
    const start = world.map.starts[1];

    const toDoor = Math.hypot(guard.x - gateway.x, guard.y - gateway.y);
    const toBase = Math.hypot(guard.x - start.x, guard.y - start.y);
    assert.ok(toDoor < 3, `the guard is ${toDoor.toFixed(1)} cells from the door it guards`);
    assert.ok(toBase > toDoor, 'the guard spawned at the base rather than the door');
  });

  test('the Robot Marine is unbuildable and off both rosters', () => {
    // Same argument as the hero chassis: keeping it out of production leaves
    // the AI's options — and the faction balance the suite pins — untouched.
    const def = UNITS.marine;
    assert.ok(def, 'the Robot Marine is missing');
    assert.equal(def.builtAt, undefined, `it can be trained at ${def.builtAt}`);
    assert.equal(def.heroOnly, true);
    assert.ok(def.hp > UNITS.anvil.hp * 2, 'a door guard should not be a slightly larger Anvil');
    assert.ok(def.shieldRegen > UNITS.anvil.shieldRegen, 'chipping it should not work');
  });
});

describe('walking into one', () => {
  test('a machine standing in the shaft takes it, and the mission is won', () => {
    const { world } = challengeWorld('ironhold');
    const [gateway] = world.gateways;
    killEntity(world, world.entities.get(gateway.keyId));
    runUntilOpen(world, gateway);

    const unit = [...world.entities.values()].find(
      (e) => e.kind === 'unit' && e.player === 0 && !e.harvest
    );
    unit.x = gateway.x;
    unit.y = gateway.y;
    run(world, 12);

    assert.equal(gateway.entered, true, 'nobody went in');
    assert.equal(world.exit.to, 'undercroft', 'the exit does not say where it goes');
    assert.equal(world.result, 'won', 'taking the shaft did not complete the mission');
  });

  test('the enemy cannot take your way out', () => {
    const { world } = challengeWorld('ironhold');
    const [gateway] = world.gateways;
    killEntity(world, world.entities.get(gateway.keyId));
    runUntilOpen(world, gateway);

    const spot = nearestWalkable(world.map, Math.floor(gateway.x), Math.floor(gateway.y), 6);
    const theirs = spawnUnit(world, 'tick', 1, spot.x + 0.5, spot.y + 0.5);
    theirs.x = gateway.x;
    theirs.y = gateway.y;
    run(world, 15);

    assert.equal(gateway.entered, false, 'the Bulwark walked into our shaft');
    assert.equal(world.exit, null);
  });

  test('entry latches — a second machine does not enter twice', () => {
    const { world } = challengeWorld('ironhold');
    const [gateway] = world.gateways;
    killEntity(world, world.entities.get(gateway.keyId));
    runUntilOpen(world, gateway);

    const mine = [...world.entities.values()].filter((e) => e.kind === 'unit' && e.player === 0);
    for (const e of mine.slice(0, 3)) {
      e.x = gateway.x;
      e.y = gateway.y;
    }
    run(world, 20);

    const entries = world.events.filter((e) => e.type === 'gatewayEntered');
    assert.ok(entries.length <= 1, `${entries.length} entry events in one tick batch`);
    assert.equal(gateway.entered, true);
  });

  test('the objective tracks both halves of the job', () => {
    const { world } = challengeWorld('ironhold');
    const objective = world.objectives.find((o) => o.kind === 'enter');
    assert.ok(objective, 'the challenge has no enter objective');

    run(world, 10);
    assert.equal(objective.progress, 0, 'progress before the building fell');
    assert.equal(objective.total, 2);

    const [gateway] = world.gateways;
    killEntity(world, world.entities.get(gateway.keyId));
    run(world, 15);
    assert.equal(objective.progress, 1, 'opening the way is half the objective');
    assert.equal(objective.complete, false, 'a shaft nobody walked into is not taken');
  });
});

describe('a gateway is not a combatant', () => {
  test('nothing auto-targets the way out', () => {
    // Props had exactly this bug — `player !== player` reads anything neutral
    // as hostile — and an army that stops to shoot the shaft never takes it.
    const { world } = challengeWorld('ironhold');
    const [gateway] = world.gateways;
    killEntity(world, world.entities.get(gateway.keyId));
    runUntilOpen(world, gateway);

    const [marker] = gatewayEntities(world);
    assert.equal(isCombatant(marker), false);
    assert.equal(marker.player, NEUTRAL_PLAYER);

    const spot = nearestWalkable(world.map, Math.floor(gateway.x), Math.floor(gateway.y), 6);
    const shooter = spawnUnit(world, 'kestrel', 0, spot.x + 0.5, spot.y + 0.5);
    const index = buildSpatialIndex(world);
    const target = acquireTarget(world, shooter, index, 12);
    assert.notEqual(target && target.kind, 'gateway', 'a mech tried to shoot the shaft');
  });

  test('the way out cannot be destroyed', () => {
    const { world } = challengeWorld('ironhold');
    const [gateway] = world.gateways;
    killEntity(world, world.entities.get(gateway.keyId));
    runUntilOpen(world, gateway);

    const [marker] = gatewayEntities(world);
    applyDamage(world, marker, 999999, DAMAGE.EXPLOSIVE, 0);
    assert.equal(marker.dead, false, 'the shaft was destroyed');
  });

  test('it does not block the cell it is standing on', () => {
    // The mechanic, not an oversight: a machine has to be able to stand on it.
    const { world } = challengeWorld('ironhold');
    const [gateway] = world.gateways;
    killEntity(world, world.entities.get(gateway.keyId));
    runUntilOpen(world, gateway);

    const cell = Math.floor(gateway.y) * world.map.width + Math.floor(gateway.x);
    assert.equal(world.map.occupied[cell], 0, 'the gateway claimed its cell');
  });

  test('an ordered move ends on the gateway rather than beside it', () => {
    // Crowd avoidance shoves machines apart, and a gateway with a two-cell
    // radius would push everything out of the doorway if it were counted.
    const { world } = challengeWorld('ironhold');
    const [gateway] = world.gateways;
    killEntity(world, world.entities.get(gateway.keyId));
    runUntilOpen(world, gateway);

    const [marker] = gatewayEntities(world);
    const spot = nearestWalkable(world.map, Math.floor(gateway.x) + 3, Math.floor(gateway.y), 6);
    const unit = spawnUnit(world, 'kestrel', 0, spot.x + 0.5, spot.y + 0.5);
    unit.x = gateway.x + 0.1;
    unit.y = gateway.y + 0.1;

    run(world, 6);
    const drift = Math.hypot(unit.x - marker.x, unit.y - marker.y);
    assert.ok(drift < GATEWAY_KINDS[gateway.kind].radius, `pushed ${drift.toFixed(2)} cells out`);
  });

  test('it belongs to nobody, so it cannot decide who has been wiped out', () => {
    const { world } = challengeWorld('ironhold');
    const [gateway] = world.gateways;
    killEntity(world, world.entities.get(gateway.keyId));
    runUntilOpen(world, gateway);

    for (const player of world.players) {
      const owned = [...world.entities.values()].filter((e) => e.player === player.id);
      assert.ok(!owned.some((e) => e.kind === 'gateway'), 'a gateway is owned by a player');
    }
  });
});

describe('the worlds on the other side', () => {
  test('every gateway leads somewhere that exists', () => {
    for (const mission of ALL_MISSIONS) {
      for (const g of mission.gateways || []) {
        assert.ok(GATEWAY_KINDS[g.kind], `${mission.id}/${g.id} is an unknown kind ${g.kind}`);
        assert.ok(PROPS[g.landmark], `${mission.id}/${g.id} anchors to unknown prop ${g.landmark}`);
        assert.ok(missionById(g.to), `${mission.id}/${g.id} leads to nothing`);
        if (g.guard) assert.ok(UNITS[g.guard.defId], `${g.id} is guarded by an unknown unit`);
      }
    }
  });

  test('an underworld is chambers cut out of rock, and it is connected', () => {
    for (const id of ['undercroft', 'ironkeep']) {
      const mission = missionById(id);
      assert.ok(BIOMES[mission.biome], `${id} names an unknown biome`);

      for (let shift = 0; shift < 5; shift++) {
        const map = createMap(mission.seed + shift, {
          width: mission.mapSize,
          height: mission.mapSize,
          biome: mission.biome,
        });
        assert.ok(map.rooms.length > 6, `${id}+${shift} generated ${map.rooms.length} chambers`);

        const floor = [...map.terrain].filter((t) => t !== 2 && t !== 3).length;
        const ratio = floor / map.terrain.length;
        // Solid rock with holes in it: a cave that is mostly floor is a field.
        assert.ok(ratio > 0.3 && ratio < 0.7, `${id}+${shift} is ${(ratio * 100) | 0}% floor`);

        const a = nearestWalkable(map, map.starts[0].x, map.starts[0].y, 12);
        const b = nearestWalkable(map, map.starts[1].x, map.starts[1].y, 12);
        assert.ok(findPath(map, a.x, a.y, b.x, b.y), `${id}+${shift} is partitioned`);
      }
    }
  });

  test('a chamber map is furnished with its own scenery, not the surface’s', () => {
    const map = createMap(80347, { width: 128, height: 128, biome: 'cavern' });
    const kinds = new Set(map.props.map((p) => p.defId));
    assert.ok(kinds.size > 1, 'the Undercroft is bare');
    for (const id of kinds) {
      assert.ok(
        BIOMES.cavern.scenery.includes(id) || id === BIOMES.cavern.hazard,
        `a ${id} turned up underground`
      );
    }
    assert.ok(!kinds.has('house'), 'there is a house in the cave');
  });

  test('no sky underground — for both sides', () => {
    // A rule only the player obeys is not a rule, it is a handicap.
    for (const id of ['undercroft', 'ironkeep']) {
      const mission = missionById(id);
      for (const side of [mission.player, mission.enemy]) {
        assert.ok(
          (side.start.locked || []).includes('vulture'),
          `${id}: one side can still field air`
        );
      }
    }
  });

  test('a hidden world is not on the mission select until its door is opened', () => {
    let profile = createProfile();
    const hidden = missionById('undercroft');

    assert.equal(challengeUnlocked(profile, hidden), false, 'unlocked from a fresh save');
    assert.ok(
      !visibleChallenges(profile).some((m) => m.id === 'undercroft'),
      'the mission list spoils it'
    );

    // Clearing the challenge is not enough — the shaft has to be taken.
    profile = { ...profile, completed: [...MISSIONS.map((m) => m.id), 'ironhold'] };
    assert.equal(challengeUnlocked(profile, hidden), false, 'cleared is not the same as found');

    profile = { ...profile, discovered: ['undercroft'] };
    assert.equal(challengeUnlocked(profile, hidden), true);
    assert.ok(visibleChallenges(profile).some((m) => m.id === 'undercroft'));
  });

  test('taking a gateway is recorded, and survives a save round trip', () => {
    const profile = createProfile();
    const after = applyMissionResult(profile, missionById('ironhold'), {
      won: true,
      exit: { gateway: 'undercroft', to: 'undercroft', kind: 'shaft' },
      rewards: { salvage: 900, base: 900, killBonus: 0, speedBonus: 0 },
      stats: {},
    });
    assert.deepEqual(after.discovered, ['undercroft']);
    assert.deepEqual(deserialize(serialize(after)).discovered, ['undercroft']);

    // A gateway the game no longer has is dropped rather than carried.
    const stale = deserialize(JSON.stringify({ ...after, discovered: ['undercroft', 'nonsense'] }));
    assert.deepEqual(stale.discovered, ['undercroft']);
  });
});

describe('challenges are still the same simulation', () => {
  test('a challenge world is deterministic on its seed', () => {
    const a = challengeWorld('bastion').world;
    const b = challengeWorld('bastion').world;
    assert.equal(hashWorld(a), hashWorld(b));
  });

  test('a match that opens the way replays to the identical world', () => {
    // The whole point of doing this as data rather than as a scripting hook:
    // opening a gateway is a comparison against a dead entity id, so it
    // replays like everything else.
    const mission = missionById('ironhold');
    const config = missionWorldConfig(mission, recruitFor(createProfile(), mission));
    const recorder = createRecorder(config);
    const world = createWorld(config);
    const [gateway] = world.gateways;

    for (let i = 0; i < 200; i++) {
      const commands = [];
      if (world.tick === 30) {
        const mech = [...world.entities.values()].find(
          (e) => e.player === 0 && e.kind === 'unit' && !e.harvest
        );
        if (mech) {
          commands.push({ type: 'attack', player: 0, ids: [mech.id], targetId: gateway.keyId });
        }
      }
      record(recorder, world.tick, commands);
      advanceTick(world, commands);
    }

    const rebuilt = rebuildWorld({ ...recorder, ticks: world.tick });
    assert.equal(hashWorld(rebuilt), hashWorld(world));
    assert.equal(rebuilt.gateways[0].open, world.gateways[0].open);
  });

  test('a mission with no gateways is untouched by any of this', () => {
    const mission = missionById('hard_landing');
    const world = createWorld(missionWorldConfig(mission, recruitFor(createProfile(), mission)));
    assert.deepEqual(world.gateways, []);
    assert.equal(world.exit, null);
    assert.equal(world.map.biome, 'surface');
    assert.deepEqual(world.map.landmarks, {});
  });
});

describe('the guard stays a guard', () => {
  test('the AI never marches its own door guard off to the war', () => {
    // A guardian swept into the army would join the first push, and the door
    // it was placed to guard would be unguarded by minute two — the challenge
    // deleting itself.
    const { world } = challengeWorld('bastion');
    const [gateway] = world.gateways;
    const guard = world.entities.get(gateway.keyId);
    const post = { x: guard.x, y: guard.y };

    runAI(world, 900);

    assert.equal(guard.dead, false, 'the guard died to something other than the player');
    const drift = Math.hypot(guard.x - post.x, guard.y - post.y);
    assert.ok(drift < 6, `the guard wandered ${drift.toFixed(1)} cells from its door`);
    assert.equal(gateway.open, false, 'the door opened without the guard dying');
  });
});
