/**
 * A gateway loads the next plate: chains, and the run that spans them.
 *
 * The old behaviour was a full debrief between two halves of one descent, and
 * a button back through the briefing screen to launch the far side. What
 * replaces it is a chain — the shaft loads the Undercroft directly — and a run
 * that accumulates across every plate until the crew stops finding doors.
 *
 * Almost none of that is simulation, and that is the point of testing it here:
 * the chain is made of `world.exit`, mission data and pure folding functions,
 * so the accumulation is provable without a browser and the only thing left
 * for the browser suite is what a screen looks like.
 *
 * The failures this file is built around, in the order they would bite:
 *
 *   - a run whose plates are summed but whose objectives are merged, so the
 *     debrief cannot say which fight the ticks belong to
 *   - a one-plate run that reads differently to a plain mission, which is
 *     every story mission in the game changing as a side effect
 *   - a chain that walks into a destination the profile has not unlocked
 *   - a plate lost mid-chain silently taking the earlier plates' salvage with
 *     it
 *   - a pilot who only exists on the far side of a door earning XP no profile
 *     has anywhere to put
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { createWorld, tick } from '../engine/sim.js';
import { killEntity } from '../engine/entities.js';
import { GATEWAY_KINDS } from '../engine/content.js';
import {
  ALL_MISSIONS,
  CHALLENGES,
  MISSIONS,
  missionById,
  missionWorldConfig,
  missionOutcome,
  createRun,
  recordPlate,
  runOutcome,
  plateAfter,
} from '../engine/campaign.js';
import {
  createProfile,
  recruitFor,
  rosterForMission,
  applyMissionResult,
  challengeUnlocked,
} from '../engine/profile.js';
import { run as runTicks } from './helpers.js';

/** A challenge world, standing where the game would stand it. */
function challengeWorld(id) {
  const mission = missionById(id);
  const profile = recruitFor(createProfile(), mission);
  return { mission, world: createWorld(missionWorldConfig(mission, profile)) };
}

/** Take the gateway: kill what holds it shut, then stand somebody in it. */
function takeTheGateway(world) {
  const [gateway] = world.gateways;
  killEntity(world, world.entities.get(gateway.keyId));
  for (let i = 0; i < 40 && !gateway.open; i++) tick(world, []);

  const unit = [...world.entities.values()].find(
    (e) => e.kind === 'unit' && e.player === 0 && !e.harvest
  );
  unit.x = gateway.x;
  unit.y = gateway.y;
  runTicks(world, 12);
  return gateway;
}

/** A finished-plate outcome, without playing one. */
function plateOutcome(overrides = {}) {
  return {
    won: true,
    exit: null,
    rewards: { salvage: 100, xp: 50, base: 100, killBonus: 0, speedBonus: 0 },
    bonusSalvage: 0,
    bonusesCleared: 0,
    bonusTotal: 1,
    pilotXp: {},
    pilotsLost: [],
    stats: { ticks: 100, killed: 0, lost: 0, mined: 0 },
    objectives: [],
    ...overrides,
  };
}

describe('what a gateway hands the screen that announces it', () => {
  test('the exit names the plate it leads to and says one line about it', () => {
    const { world } = challengeWorld('ironhold');
    takeTheGateway(world);

    assert.equal(world.exit.to, 'undercroft');
    assert.equal(world.exit.name, 'The Undercroft');
    assert.equal(world.exit.flavour, 'The air coming up is warm.');
    // No numbers. The card between two plates is a held beat, and a payout is
    // the thing it exists instead of.
    assert.deepEqual(Object.keys(world.exit).sort(), [
      'flavour',
      'gateway',
      'kind',
      'name',
      'to',
    ]);
  });

  test('every gateway in the game has a card that can be drawn', () => {
    // A blank half-screen where the flavour line should be is not a crash, so
    // nothing else would ever catch it.
    for (const mission of ALL_MISSIONS) {
      for (const g of mission.gateways || []) {
        const kind = GATEWAY_KINDS[g.kind];
        assert.ok(kind, `${mission.id}/${g.id}: unknown kind`);
        assert.ok(g.name || kind.name, `${mission.id}/${g.id}: nothing to title the card with`);
        assert.ok(
          (g.flavour || kind.opened || '').trim().length > 0,
          `${mission.id}/${g.id}: no line to say on the way through`
        );
      }
    }
  });

  test('a gateway written without a flavour line still gets a sentence', () => {
    // The fallback is not decoration: a third challenge is meant to cost a
    // mission file, and forgetting one field must not cost it a broken screen.
    const mission = missionById('ironhold');
    const bare = {
      ...mission,
      gateways: [{ ...mission.gateways[0], flavour: undefined }],
    };
    const world = createWorld(missionWorldConfig(bare, recruitFor(createProfile(), bare)));
    takeTheGateway(world);
    assert.equal(world.exit.flavour, GATEWAY_KINDS.shaft.opened);
  });
});

describe('where the chain goes next', () => {
  test('plateAfter resolves the mission on the other side of the door', () => {
    const { world, mission } = challengeWorld('ironhold');
    takeTheGateway(world);
    const next = plateAfter(missionOutcome(world, mission));
    assert.equal(next.id, 'undercroft');
    assert.equal(next.biome, 'cavern');
  });

  test('a mission with no door ends the run rather than continuing it', () => {
    // The three endings that all mean "stop here": no gateway at all, a
    // gateway nobody took, and a destination that no longer exists.
    assert.equal(plateAfter(plateOutcome()), null);
    assert.equal(plateAfter(plateOutcome({ exit: { gateway: 'x', to: null } })), null);
    assert.equal(plateAfter(plateOutcome({ exit: { gateway: 'x', to: 'deleted' } })), null);
    assert.equal(plateAfter(null), null);
  });

  test('every destination is unlocked by the plate that leads to it', () => {
    // The chain gates on the same rule the mission list does, so a run cannot
    // drag the player somewhere the menu would refuse them. If clearing the
    // near side did not satisfy the far side's `requires`, the door would open
    // onto a locked screen and the whole feature would be dead on arrival.
    for (const mission of ALL_MISSIONS) {
      for (const g of mission.gateways || []) {
        const destination = missionById(g.to);
        let profile = createProfile();
        // Everything the near side itself needed, then the near side.
        profile = {
          ...profile,
          completed: [...MISSIONS.map((m) => m.id), mission.id],
        };
        profile = applyMissionResult(profile, mission, {
          won: true,
          exit: { gateway: g.id, to: g.to, kind: g.kind },
          rewards: { salvage: 0, base: 0, killBonus: 0, speedBonus: 0 },
          stats: {},
        });
        assert.equal(
          challengeUnlocked(profile, destination),
          true,
          `${mission.id} → ${g.to}: the door opens onto a mission the profile refuses`
        );
      }
    }
  });

  test('a hidden world is still launchable on its own once it is discovered', () => {
    // The chain must not become the only way in, or a player who has already
    // been down there cannot replay it from the mission list.
    const undercroft = missionById('undercroft');
    const profile = {
      ...createProfile(),
      completed: [...MISSIONS.map((m) => m.id), 'ironhold'],
      discovered: ['undercroft'],
    };
    assert.equal(challengeUnlocked(profile, undercroft), true);
    // And standalone, it debriefs: it has no door of its own to chain through.
    assert.deepEqual(undercroft.gateways, undefined);
  });

  test('the far side of a door fields pilots the near side never met', () => {
    // The reason a chained launch has to recruit: skipping the briefing skips
    // recruitment, and XP for a pilot with no profile record is dropped on the
    // floor by applyMissionResult without a word.
    const ironhold = new Set(rosterForMission(missionById('ironhold')));
    const undercroft = rosterForMission(missionById('undercroft'));
    const strangers = undercroft.filter((id) => !ironhold.has(id));
    assert.ok(
      strangers.length > 0,
      'the Undercroft fields nobody new — this test has stopped guarding anything'
    );
  });
});

describe('a run of one plate', () => {
  test('reads exactly like the mission it is', () => {
    // Every story mission in the game is a one-plate run. If this diverges,
    // the debrief of a feature nobody used has changed.
    const { world, mission } = challengeWorld('ironhold');
    takeTheGateway(world);
    const outcome = missionOutcome(world, mission);
    const folded = runOutcome(recordPlate(createRun(), mission, outcome));

    assert.equal(folded.won, outcome.won);
    assert.deepEqual(folded.exit, outcome.exit);
    assert.deepEqual(folded.rewards, outcome.rewards);
    assert.deepEqual(folded.pilotXp, outcome.pilotXp);
    assert.deepEqual(folded.pilotsLost, outcome.pilotsLost);
    assert.deepEqual(folded.stats, outcome.stats);
    assert.deepEqual(folded.objectives, outcome.objectives);
    assert.equal(folded.bonusTotal, outcome.bonusTotal);
    assert.equal(folded.plates.length, 1);
    assert.equal(folded.plates[0].name, mission.name);
  });

  test('an empty run is still renderable rather than a crash', () => {
    const empty = runOutcome(createRun());
    assert.equal(empty.won, false);
    assert.equal(empty.exit, null);
    assert.deepEqual(empty.plates, []);
    assert.deepEqual(empty.objectives, []);
    assert.equal(empty.rewards.salvage, 0);
  });
});

describe('a run of several plates', () => {
  const first = plateOutcome({
    exit: { gateway: 'undercroft', to: 'undercroft', kind: 'shaft', name: 'The Undercroft' },
    rewards: { salvage: 900, xp: 450, base: 900, killBonus: 0, speedBonus: 0 },
    bonusSalvage: 350,
    bonusesCleared: 1,
    pilotXp: { ash: 200, box: 120 },
    pilotsLost: ['box'],
    stats: { ticks: 1200, killed: 9, lost: 2, mined: 4000 },
    objectives: [{ key: 'enter-a0', text: 'Take the shaft', complete: true }],
  });
  const second = plateOutcome({
    rewards: { salvage: 1400, xp: 700, base: 1400, killBonus: 200, speedBonus: 0 },
    bonusSalvage: 0,
    bonusesCleared: 0,
    pilotXp: { ash: 300, sable: 90 },
    pilotsLost: ['box'],
    stats: { ticks: 2000, killed: 14, lost: 3, mined: 6500 },
    objectives: [{ key: 'destroyStructures-a0', text: 'Clear the lower chambers', complete: true }],
  });

  const chain = () => {
    let r = createRun();
    r = recordPlate(r, missionById('ironhold'), first);
    r = recordPlate(r, missionById('undercroft'), second);
    return r;
  };

  test('salvage, statistics and XP are the whole deployment', () => {
    const folded = runOutcome(chain());
    assert.equal(folded.rewards.salvage, 2300);
    assert.equal(folded.rewards.killBonus, 200);
    assert.equal(folded.bonusSalvage, 350);
    assert.equal(folded.stats.ticks, 3200);
    assert.equal(folded.stats.killed, 23);
    assert.equal(folded.stats.mined, 10500);
    assert.deepEqual(folded.pilotXp, { ash: 500, box: 120, sable: 90 });
  });

  test('a pilot shot down on one plate is one loss, not one per plate', () => {
    assert.deepEqual(runOutcome(chain()).pilotsLost, ['box']);
  });

  test('objectives stay under the plate that set them', () => {
    const folded = runOutcome(chain());
    assert.deepEqual(
      folded.plates.map((p) => p.name),
      ['Ironhold', 'The Undercroft']
    );
    assert.equal(folded.plates[0].objectives[0].text, 'Take the shaft');
    assert.equal(folded.plates[1].objectives[0].text, 'Clear the lower chambers');
    // And flattened for anything that only wants "how did they go".
    assert.equal(folded.objectives.length, 2);
  });

  test('the run ends where its last plate did', () => {
    const folded = runOutcome(chain());
    assert.equal(folded.won, true);
    // The last plate had no door, so the run stops rather than pointing on.
    assert.equal(folded.exit, null);
    assert.equal(plateAfter(folded), null);
  });

  test('a plate lost mid-chain ends the run and keeps what came before it', () => {
    let r = createRun();
    r = recordPlate(r, missionById('ironhold'), first);
    r = recordPlate(
      r,
      missionById('undercroft'),
      plateOutcome({
        won: false,
        rewards: { salvage: 0, xp: 100, base: 0, killBonus: 0, speedBonus: 0 },
        pilotXp: { ash: 40 },
        stats: { ticks: 800, killed: 3, lost: 9, mined: 1200 },
        objectives: [{ key: 'x', text: 'Clear the lower chambers', complete: false }],
      })
    );

    const folded = runOutcome(r);
    assert.equal(folded.won, false, 'a run is won or lost on its last plate');
    assert.equal(folded.rewards.salvage, 900, 'the first plate stopped counting');
    assert.deepEqual(folded.pilotXp, { ash: 240, box: 120 });
    assert.equal(folded.plates.length, 2);
  });

  test('recording a plate does not mutate the run it was given', () => {
    // The debrief holds the run from before the last plate to show what
    // changed; a shared array would make "before" and "after" the same thing.
    const before = recordPlate(createRun(), missionById('ironhold'), first);
    const after = recordPlate(before, missionById('undercroft'), second);
    assert.equal(before.plates.length, 1);
    assert.equal(after.plates.length, 2);
    assert.notEqual(before.plates, after.plates);
  });

  test('whatever else the caller carries on a run survives being extended', () => {
    // main.js keeps the profile as it stood before the first plate on this
    // object. Losing it would make every debrief report a level-up from
    // whatever the crew were at the *previous* plate instead of the run's
    // start, which is wrong precisely when a chain is long enough to matter.
    const seeded = { ...createRun(), before: { salvage: 42 } };
    const extended = recordPlate(seeded, missionById('ironhold'), first);
    assert.deepEqual(extended.before, { salvage: 42 });
  });
});

describe('a chain played plate by plate against a real profile', () => {
  test('each plate banks its own result, so a reload never costs one', () => {
    // The reason the profile is written between plates rather than at the end
    // of the run: the autosave holds one plate, so anything held back until
    // the debrief is lost by a closed tab halfway down a shaft.
    const ironhold = missionById('ironhold');
    const undercroft = missionById('undercroft');

    let profile = { ...createProfile(), completed: MISSIONS.map((m) => m.id) };
    profile = recruitFor(profile, ironhold);

    const firstOutcome = plateOutcome({
      exit: { gateway: 'undercroft', to: 'undercroft', kind: 'shaft' },
      rewards: { salvage: 900, xp: 450, base: 900, killBonus: 0, speedBonus: 0 },
      pilotXp: { ash: 500 },
      stats: { ticks: 1200, killed: 9, lost: 1, mined: 4000 },
    });
    profile = applyMissionResult(profile, ironhold, firstOutcome);

    assert.equal(profile.salvage, 900, 'the first plate did not pay out');
    assert.deepEqual(profile.discovered, ['undercroft']);
    assert.ok(profile.completed.includes('ironhold'));
    assert.equal(
      challengeUnlocked(profile, undercroft),
      true,
      'the chain cannot open the door it just walked through'
    );

    // The far side fields pilots the near side never had, exactly as a chained
    // launch must recruit before it starts.
    profile = recruitFor(profile, undercroft);
    assert.ok(profile.pilots.sable, 'the Undercroft crew never joined the roster');

    profile = applyMissionResult(
      profile,
      undercroft,
      plateOutcome({
        won: false,
        rewards: { salvage: 0, xp: 100, base: 0, killBonus: 0, speedBonus: 0 },
        pilotXp: { sable: 60 },
        stats: { ticks: 900, killed: 2, lost: 6, mined: 800 },
      })
    );

    assert.equal(profile.salvage, 900, 'losing the last plate refunded the first one');
    assert.equal(profile.pilots.sable.xp, 60, 'a lost plate still trains the crew');
    assert.ok(!profile.completed.includes('undercroft'));
  });
});

describe('the chain changes nothing about the simulation', () => {
  test('a world knows where it goes and nothing about what is there', () => {
    // `exit.to` is a mission id and stays one. The moment the engine could
    // reach the destination's data it would be one step from loading it, and
    // a simulation that loads maps is not one you can replay.
    const { world } = challengeWorld('ironhold');
    takeTheGateway(world);
    assert.equal(typeof world.exit.to, 'string');
    assert.equal(world.mission.id, 'ironhold');
    assert.equal(world.map.biome, 'surface', 'the world followed the crew down the hole');
  });

  test('the challenges still ship exactly two doors between four missions', () => {
    // A chain is only interesting while the plates on either side of it are
    // real missions written in this file. If a door ever pointed at something
    // generated, everything above stops being data.
    const doors = CHALLENGES.flatMap((m) => m.gateways || []);
    assert.equal(doors.length, 2);
    for (const g of doors) assert.ok(missionById(g.to), `${g.id} leads nowhere`);
  });
});
