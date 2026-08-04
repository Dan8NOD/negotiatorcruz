/**
 * Objectives, missions, and the save profile.
 *
 * The expensive assertion at the bottom actually plays the whole campaign with
 * the AI driving both sides. It is slow, and it is the only thing that can
 * catch an unwinnable mission — an objective nobody can satisfy looks perfectly
 * healthy in every unit test and ends a player's campaign dead.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { makeBareWorld, makeEmptyWorld, run, runAI } from './helpers.js';
import { createWorld, tick } from '../engine/sim.js';
import { updateAI } from '../engine/ai.js';
import { spawnUnit, spawnBuilding, applyDamage } from '../engine/entities.js';
import {
  prepareObjectives,
  evaluateObjectives,
  describeObjective,
  objectiveProgressText,
} from '../engine/objectives.js';
import {
  MISSIONS,
  missionById,
  missionWorldConfig,
  missionOutcome,
  CAMPAIGN_INTRO,
} from '../engine/campaign.js';
import {
  createProfile,
  recruitFor,
  nextMission,
  missionUnlocked,
  campaignComplete,
  applyMissionResult,
  canBuy,
  buyUpgrade,
  serialize,
  deserialize,
  rosterForMission,
} from '../engine/profile.js';
import { UPGRADES, PILOTS, MAX_PILOT_LEVEL } from '../engine/progression.js';
import { DAMAGE, TICKS_PER_SECOND } from '../engine/content.js';

/* ---------------------------------------------------------- objectives -- */

function objectiveWorld(mission) {
  // Genuinely empty: the default world hands both sides a Command Rig, which
  // would make "destroy every enemy structure" unsatisfiable and "protect the
  // base" unfailable.
  const world = makeEmptyWorld();
  world.mission = mission;
  world.objectives = prepareObjectives(mission);
  world.missionStartTick = 0;
  return world;
}

describe('objective evaluation', () => {
  test('destroyStructures completes when the last building falls', () => {
    const world = objectiveWorld({
      objectives: [{ kind: 'destroyStructures', player: 1 }],
    });
    const a = spawnBuilding(world, 'reactor', 1, 20, 20, { complete: true });
    const b = spawnBuilding(world, 'turret', 1, 26, 20, { complete: true });

    let r = evaluateObjectives(world, world.objectives);
    assert.equal(r.won, false);
    assert.equal(world.objectives[0].total, 2);

    applyDamage(world, a, 99999, DAMAGE.EXPLOSIVE);
    tick(world, []);
    r = evaluateObjectives(world, world.objectives);
    assert.equal(r.won, false);
    assert.equal(world.objectives[0].progress, 1);

    applyDamage(world, b, 99999, DAMAGE.EXPLOSIVE);
    tick(world, []);
    r = evaluateObjectives(world, world.objectives);
    assert.equal(r.won, true);
  });

  test('destroyStructures ignores surviving units', () => {
    // The point of this objective is to not make the player hunt one scout.
    const world = objectiveWorld({ objectives: [{ kind: 'destroyStructures', player: 1 }] });
    const building = spawnBuilding(world, 'reactor', 1, 20, 20, { complete: true });
    spawnUnit(world, 'tick', 1, 40, 40);

    applyDamage(world, building, 99999, DAMAGE.EXPLOSIVE);
    tick(world, []);
    assert.equal(evaluateObjectives(world, world.objectives).won, true);
  });

  test('destroyCount counts kills, not survivors', () => {
    const world = objectiveWorld({
      objectives: [{ kind: 'destroyCount', player: 1, defId: 'reactor', count: 2 }],
    });
    const a = spawnBuilding(world, 'reactor', 1, 20, 20, { complete: true });
    const b = spawnBuilding(world, 'reactor', 1, 26, 20, { complete: true });
    spawnBuilding(world, 'reactor', 1, 32, 20, { complete: true });

    evaluateObjectives(world, world.objectives);
    applyDamage(world, a, 99999, DAMAGE.EXPLOSIVE);
    tick(world, []);
    assert.equal(evaluateObjectives(world, world.objectives).won, false);

    applyDamage(world, b, 99999, DAMAGE.EXPLOSIVE);
    tick(world, []);
    assert.equal(evaluateObjectives(world, world.objectives).won, true, 'two of three is enough');
  });

  test('survive completes on the clock', () => {
    const world = objectiveWorld({ objectives: [{ kind: 'survive', ticks: 40 }] });
    spawnUnit(world, 'vireo', 0, 20, 20);

    run(world, 20);
    assert.equal(evaluateObjectives(world, world.objectives).won, false);
    run(world, 30);
    assert.equal(evaluateObjectives(world, world.objectives).won, true);
  });

  test('accumulate tracks scrap mined, not scrap held', () => {
    const world = objectiveWorld({ objectives: [{ kind: 'accumulate', player: 0, amount: 100 }] });
    world.players[0].scrap = 99999; // a full bank must not satisfy it
    assert.equal(evaluateObjectives(world, world.objectives).won, false);

    world.players[0].scrapMined = 100;
    assert.equal(evaluateObjectives(world, world.objectives).won, true);
  });

  test('build only counts completed structures', () => {
    const world = objectiveWorld({
      objectives: [{ kind: 'build', player: 0, defId: 'reactor', count: 1 }],
    });
    const site = spawnBuilding(world, 'reactor', 0, 20, 20); // under construction
    assert.equal(evaluateObjectives(world, world.objectives).won, false);

    site.constructing = false;
    assert.equal(evaluateObjectives(world, world.objectives).won, true);
  });

  test('reach completes when any unit arrives', () => {
    const world = objectiveWorld({
      objectives: [{ kind: 'reach', player: 0, x: 30, y: 30, radius: 2 }],
    });
    const unit = spawnUnit(world, 'vireo', 0, 20, 20);
    assert.equal(evaluateObjectives(world, world.objectives).won, false);

    unit.x = 30.5;
    unit.y = 30.5;
    assert.equal(evaluateObjectives(world, world.objectives).won, true);
  });

  test('protect fails the mission when what it guards dies', () => {
    const world = objectiveWorld({
      objectives: [
        { kind: 'survive', ticks: 99999 },
        { kind: 'protect', player: 0, defId: 'command', atLeast: 1 },
      ],
    });
    const hq = spawnBuilding(world, 'command', 0, 20, 20, { complete: true });

    let r = evaluateObjectives(world, world.objectives);
    assert.equal(r.lost, false);

    applyDamage(world, hq, 99999, DAMAGE.EXPLOSIVE);
    tick(world, []);
    r = evaluateObjectives(world, world.objectives);
    assert.equal(r.lost, true);
  });

  test('a standing objective alone never wins the mission', () => {
    // Otherwise "protect the base" would be complete the instant it is checked.
    const world = objectiveWorld({
      objectives: [{ kind: 'protect', player: 0, defId: 'command', atLeast: 1 }],
    });
    spawnBuilding(world, 'command', 0, 20, 20, { complete: true });
    assert.equal(evaluateObjectives(world, world.objectives).won, false);
  });

  test('a pilot protect objective tracks the pilot, not the chassis', () => {
    const world = objectiveWorld({
      objectives: [
        { kind: 'survive', ticks: 99999 },
        { kind: 'protect', pilot: 'ash' },
      ],
    });
    const hero = spawnUnit(world, 'kestrel', 0, 20, 20);
    hero.pilotId = 'ash';
    spawnUnit(world, 'kestrel', 0, 24, 20); // an ordinary Kestrel

    assert.equal(evaluateObjectives(world, world.objectives).lost, false);
    applyDamage(world, hero, 99999, DAMAGE.KINETIC);
    tick(world, []);
    assert.equal(evaluateObjectives(world, world.objectives).lost, true);
  });

  test('completion latches — un-doing the condition does not un-win it', () => {
    const world = objectiveWorld({
      objectives: [{ kind: 'destroyStructures', player: 1 }],
    });
    const b = spawnBuilding(world, 'reactor', 1, 20, 20, { complete: true });
    evaluateObjectives(world, world.objectives);
    applyDamage(world, b, 99999, DAMAGE.EXPLOSIVE);
    tick(world, []);
    assert.equal(evaluateObjectives(world, world.objectives).won, true);

    // The enemy rebuilds. The mission stays won.
    spawnBuilding(world, 'reactor', 1, 30, 30, { complete: true });
    assert.equal(evaluateObjectives(world, world.objectives).won, true);
  });

  test('a bonus objective alone cannot win or lose the mission', () => {
    const world = objectiveWorld({
      objectives: [{ kind: 'survive', ticks: 99999 }],
      bonusObjectives: [{ kind: 'protect', pilot: 'ash' }],
    });
    assert.equal(evaluateObjectives(world, world.objectives).lost, false, 'no pilot, no loss');
  });

  test('an unknown objective kind is skipped rather than fatal', () => {
    const world = objectiveWorld({ objectives: [{ kind: 'teleport_the_moon' }] });
    assert.doesNotThrow(() => evaluateObjectives(world, world.objectives));
  });

  test('every objective renders a label and sane progress text', () => {
    for (const mission of MISSIONS) {
      for (const o of prepareObjectives(mission)) {
        const label = describeObjective(o);
        assert.ok(label && label !== o.kind, `${mission.id}: unlabelled objective ${o.kind}`);
        assert.doesNotThrow(() => objectiveProgressText(o));
      }
    }
  });
});

/* ------------------------------------------------------------- missions -- */

describe('mission definitions', () => {
  test('are ordered, uniquely identified, and complete', () => {
    const ids = new Set();
    MISSIONS.forEach((m, i) => {
      assert.equal(m.index, i + 1, `${m.id} has the wrong index`);
      assert.ok(!ids.has(m.id), `duplicate mission id ${m.id}`);
      ids.add(m.id);

      assert.ok(m.name && m.subtitle && m.briefing, `${m.id} is missing briefing copy`);
      assert.ok(m.reward > 0, `${m.id} pays nothing`);
      assert.ok(m.seed > 0, `${m.id} has no seed`);
      assert.ok((m.objectives || []).length > 0, `${m.id} has no objectives`);
      assert.ok(m.player && m.enemy, `${m.id} is missing a side`);
    });
  });

  test('every mission names pilots that exist', () => {
    for (const mission of MISSIONS) {
      for (const id of rosterForMission(mission)) {
        assert.ok(PILOTS[id], `${mission.id} fields unknown pilot ${id}`);
      }
    }
  });

  test('the crew only ever grows', () => {
    // A pilot appearing in mission 2 and missing from mission 4 reads as a
    // continuity bug in the story, because it is one.
    let seen = [];
    for (const mission of MISSIONS) {
      const roster = rosterForMission(mission);
      if (roster.length === 0) continue;
      for (const id of seen) {
        assert.ok(roster.includes(id), `${mission.id} silently drops pilot ${id}`);
      }
      seen = roster;
    }
  });

  test('every mission has a story beat attached', () => {
    for (const mission of MISSIONS) {
      assert.ok(mission.briefing.length > 80, `${mission.id} briefing is a stub`);
      assert.ok(mission.debrief, `${mission.id} has no debrief`);
    }
    assert.ok(CAMPAIGN_INTRO.length > 100);
  });

  test('a mission world config carries the profile loadout in', () => {
    let profile = createProfile();
    profile = buyUpgrade({ ...profile, salvage: 99999 }, 'field_plating');
    const config = missionWorldConfig(MISSIONS[0], profile);

    assert.equal(config.seed, MISSIONS[0].seed);
    assert.deepEqual(config.players[0].upgrades, ['field_plating']);
    assert.equal(config.mission, MISSIONS[0]);
    assert.ok(config.players[0].pilots.some((p) => p.id === 'ash'));
  });

  test('missionById finds a mission and tolerates a bad id', () => {
    assert.equal(missionById(MISSIONS[0].id), MISSIONS[0]);
    assert.equal(missionById('nope'), null);
  });

  test('a mission world starts with the forces its briefing promises', () => {
    const mission = MISSIONS[0];
    const world = createWorld(missionWorldConfig(mission, recruitFor(createProfile(), mission)));

    const mine = [...world.entities.values()].filter((e) => e.player === 0);
    assert.equal(mine.filter((e) => e.defId === 'command').length, 0, 'mission 1 has no base');
    assert.ok(mine.some((e) => e.pilotId === 'ash'), 'Ash was not deployed');
    assert.ok(world.objectives.length > 0);
  });
});

/* -------------------------------------------------------------- profile -- */

describe('the save profile', () => {
  test('starts with one pilot and no progress', () => {
    const p = createProfile();
    assert.equal(p.salvage, 0);
    assert.deepEqual(p.completed, []);
    assert.deepEqual(Object.keys(p.pilots), ['ash']);
  });

  test('missions unlock strictly in order', () => {
    let p = createProfile();
    assert.equal(missionUnlocked(p, MISSIONS[0]), true);
    assert.equal(missionUnlocked(p, MISSIONS[1]), false);

    p = { ...p, completed: [MISSIONS[0].id] };
    assert.equal(missionUnlocked(p, MISSIONS[1]), true);
    assert.equal(nextMission(p).id, MISSIONS[1].id);
  });

  test('recruits the pilots a mission needs', () => {
    let p = createProfile();
    p = recruitFor(p, MISSIONS[4]); // the mission that fields everyone
    for (const id of rosterForMission(MISSIONS[4])) {
      assert.ok(p.pilots[id], `${id} was never recruited`);
    }
  });

  test('recruiting twice is a no-op', () => {
    const p = recruitFor(createProfile(), MISSIONS[0]);
    assert.equal(recruitFor(p, MISSIONS[0]), p, 'a redundant recruit rebuilt the profile');
  });

  test('a win banks salvage, records the clear, and levels pilots', () => {
    const mission = MISSIONS[0];
    const before = recruitFor(createProfile(), mission);
    const after = applyMissionResult(before, mission, {
      won: true,
      rewards: { salvage: 600, base: 400, killBonus: 200, speedBonus: 0 },
      bonusSalvage: 200,
      pilotXp: { ash: 500 },
      stats: { ticks: 1000, killed: 8, lost: 0, mined: 0 },
    });

    assert.equal(after.salvage, 800);
    assert.deepEqual(after.completed, [mission.id]);
    assert.ok(after.records[mission.id]);
    assert.equal(after.pilots.ash.xp, 500);
    assert.ok(after.pilots.ash.level > 1, 'Ash did not level');
    assert.equal(before.salvage, 0, 'the original profile was mutated');
  });

  test('a loss pays no salvage but still teaches the pilots something', () => {
    const mission = MISSIONS[0];
    const before = recruitFor(createProfile(), mission);
    const after = applyMissionResult(before, mission, {
      won: false,
      rewards: { salvage: 600, base: 400, killBonus: 200, speedBonus: 0 },
      pilotXp: { ash: 100 },
      stats: { ticks: 500, killed: 2, lost: 3, mined: 0 },
    });

    assert.equal(after.salvage, 0);
    assert.deepEqual(after.completed, []);
    assert.equal(after.pilots.ash.xp, 100);
  });

  test('a replay pays the bonuses but not the base reward again', () => {
    const mission = MISSIONS[0];
    const outcome = {
      won: true,
      rewards: { salvage: 600, base: 400, killBonus: 200, speedBonus: 0 },
      bonusSalvage: 0,
      pilotXp: {},
      stats: { ticks: 1000, killed: 8, lost: 0, mined: 0 },
    };

    const first = applyMissionResult(recruitFor(createProfile(), mission), mission, outcome);
    const second = applyMissionResult(first, mission, outcome);

    assert.equal(first.salvage, 600);
    assert.equal(second.salvage, 800, 'a replay should pay only the kill bonus');
    assert.deepEqual(second.completed, [mission.id], 'a replay double-counted the clear');
  });

  test('a faster replay improves the record; a slower one does not', () => {
    const mission = MISSIONS[0];
    const base = {
      won: true,
      rewards: { salvage: 500, base: 400, killBonus: 100, speedBonus: 0 },
      pilotXp: {},
    };

    let p = applyMissionResult(recruitFor(createProfile(), mission), mission, {
      ...base,
      stats: { ticks: 2000, killed: 1, lost: 0, mined: 0 },
    });
    p = applyMissionResult(p, mission, { ...base, stats: { ticks: 1000, killed: 1, lost: 0 } });
    assert.equal(p.records[mission.id].ticks, 1000);

    p = applyMissionResult(p, mission, { ...base, stats: { ticks: 5000, killed: 1, lost: 0 } });
    assert.equal(p.records[mission.id].ticks, 1000, 'a slower run overwrote the record');
  });

  test('pilot levels are capped', () => {
    const mission = MISSIONS[0];
    const p = applyMissionResult(recruitFor(createProfile(), mission), mission, {
      won: true,
      rewards: { salvage: 0, base: 0, killBonus: 0, speedBonus: 0 },
      pilotXp: { ash: 9999999 },
      stats: {},
    });
    assert.equal(p.pilots.ash.level, MAX_PILOT_LEVEL);
  });

  test('campaignComplete needs every mission', () => {
    const p = { ...createProfile(), completed: MISSIONS.map((m) => m.id) };
    assert.equal(campaignComplete(p), true);
    assert.equal(campaignComplete(createProfile()), false);
    assert.equal(nextMission(p), null);
  });
});

describe('buying upgrades', () => {
  test('spends salvage and records the purchase', () => {
    const p = buyUpgrade({ ...createProfile(), salvage: 5000 }, 'field_plating');
    assert.equal(p.salvage, 5000 - UPGRADES.field_plating.cost);
    assert.deepEqual(p.upgrades, ['field_plating']);
  });

  test('refuses what cannot be afforded, and says why', () => {
    const poor = { ...createProfile(), salvage: 1 };
    const check = canBuy(poor, 'field_plating');
    assert.equal(check.ok, false);
    assert.match(check.reason, /salvage/i);
    assert.deepEqual(buyUpgrade(poor, 'field_plating').upgrades, []);
  });

  test('refuses an upgrade whose prerequisite is missing, and names it', () => {
    const rich = { ...createProfile(), salvage: 99999 };
    const check = canBuy(rich, 'hardened_frames');
    assert.equal(check.ok, false);
    assert.match(check.reason, /Field Plating/);
  });

  test('refuses to buy the same upgrade twice', () => {
    let p = buyUpgrade({ ...createProfile(), salvage: 99999 }, 'field_plating');
    const banked = p.salvage;
    p = buyUpgrade(p, 'field_plating');
    assert.equal(p.salvage, banked, 'paid twice for one upgrade');
    assert.equal(p.upgrades.length, 1);
  });

  test('the upgrade list is kept sorted, so the loadout is order-independent', () => {
    let p = { ...createProfile(), salvage: 99999 };
    p = buyUpgrade(p, 'servos');
    p = buyUpgrade(p, 'capacitors');
    assert.deepEqual(p.upgrades, [...p.upgrades].sort());
  });
});

describe('serialisation', () => {
  test('round-trips a played profile', () => {
    let p = recruitFor(createProfile(), MISSIONS[2]);
    p = buyUpgrade({ ...p, salvage: 99999 }, 'field_plating');
    p = applyMissionResult(p, MISSIONS[0], {
      won: true,
      rewards: { salvage: 600, base: 400, killBonus: 200, speedBonus: 0 },
      pilotXp: { ash: 900 },
      stats: { ticks: 1200, killed: 5, lost: 1, mined: 4000 },
    });

    const back = deserialize(serialize(p));
    assert.equal(back.salvage, p.salvage);
    assert.deepEqual(back.completed, p.completed);
    assert.deepEqual(back.upgrades, p.upgrades);
    assert.equal(back.pilots.ash.xp, p.pilots.ash.xp);
    assert.equal(back.pilots.ash.level, p.pilots.ash.level);
  });

  test('garbage produces a fresh campaign rather than a crash', () => {
    // A save file lives in localStorage where anything could have edited it.
    for (const junk of ['', 'not json', 'null', '[]', '{"salvage":"lots"}', '42']) {
      const p = deserialize(junk);
      assert.ok(Number.isFinite(p.salvage), `${junk} produced a broken profile`);
      assert.ok(p.pilots.ash, `${junk} produced a profile with no crew`);
    }
  });

  test('drops content that no longer exists instead of bricking the save', () => {
    const p = deserialize(
      JSON.stringify({
        salvage: 100,
        completed: ['hard_landing', 'a_mission_we_deleted'],
        upgrades: ['field_plating', 'an_upgrade_we_deleted'],
        pilots: { ash: { xp: 500 }, someone_we_deleted: { xp: 900 } },
      })
    );

    assert.deepEqual(p.completed, ['hard_landing']);
    assert.deepEqual(p.upgrades, ['field_plating']);
    assert.deepEqual(Object.keys(p.pilots), ['ash']);
  });

  test('refuses to load a negative or fractional salvage balance', () => {
    assert.equal(deserialize(JSON.stringify({ salvage: -500 })).salvage, 0);
    assert.equal(deserialize(JSON.stringify({ salvage: 10.7 })).salvage, 10);
  });

  test('recomputes pilot level from XP rather than trusting the file', () => {
    const p = deserialize(JSON.stringify({ pilots: { ash: { xp: 0, level: 99 } } }));
    assert.equal(p.pilots.ash.level, 1);
  });
});

/* ------------------------------------------------------ the whole thing -- */

describe('the campaign is playable', () => {
  test('every mission can be won', () => {
    // Drives both sides with the AI. Slow, and the only check that can catch
    // an objective no player could ever satisfy.
    let profile = createProfile();

    for (const mission of MISSIONS) {
      profile = recruitFor(profile, mission);
      const config = missionWorldConfig(mission, profile);
      config.players[0] = { ...config.players[0], isAI: true, difficulty: 'normal' };

      const world = createWorld(config);
      for (let i = 0; i < 24000 && !world.over; i++) {
        const commands = [];
        for (const p of world.players) {
          if (p.isAI && !p.defeated) commands.push(...updateAI(world, p));
        }
        tick(world, commands);
      }

      assert.equal(world.result, 'won', `${mission.id} could not be won`);

      const outcome = missionOutcome(world, mission);
      assert.ok(outcome.rewards.salvage > 0, `${mission.id} paid nothing`);
      profile = applyMissionResult(profile, mission, outcome);
    }

    assert.equal(campaignComplete(profile), true);
    assert.ok(profile.salvage > 0, 'a full campaign banked no salvage');
  });

  test('a mission world is deterministic like any other', () => {
    const mission = MISSIONS[2];
    const profile = recruitFor(createProfile(), mission);

    const play = () => {
      const config = missionWorldConfig(mission, profile);
      config.players[0] = { ...config.players[0], isAI: true };
      return runAI(createWorld(config), 900);
    };

    const a = play();
    const b = play();
    assert.equal(a.tick, b.tick);
    assert.deepEqual(
      a.objectives.map((o) => [o.key, o.complete, Math.floor(o.progress)]),
      b.objectives.map((o) => [o.key, o.complete, Math.floor(o.progress)])
    );
  });

  test('a mission is lost when the player is wiped out', () => {
    const mission = MISSIONS[0];
    const world = createWorld(missionWorldConfig(mission, recruitFor(createProfile(), mission)));

    for (const e of [...world.entities.values()]) if (e.player === 0) e.dead = true;
    run(world, 30);

    assert.equal(world.over, true);
    assert.equal(world.result, 'lost');
  });

  test('a debrief reports objectives, rewards and pilot XP', () => {
    const mission = MISSIONS[0];
    const config = missionWorldConfig(mission, recruitFor(createProfile(), mission));
    config.players[0] = { ...config.players[0], isAI: true };

    const world = createWorld(config);
    for (let i = 0; i < 12000 && !world.over; i++) {
      const commands = [];
      for (const p of world.players) if (p.isAI) commands.push(...updateAI(world, p));
      tick(world, commands);
    }

    const outcome = missionOutcome(world, mission);
    assert.equal(outcome.won, true);
    assert.equal(outcome.objectives.length, world.objectives.length);
    assert.ok(outcome.pilotXp.ash > 0, 'Ash flew the mission and learned nothing');
    assert.ok(outcome.stats.ticks > 0);
  });

  test('bonus salvage is only paid on a win', () => {
    const mission = {
      reward: 100,
      objectives: [{ kind: 'survive', ticks: 10 }],
      player: { start: { heroes: [] } },
    };
    const world = makeBareWorld();
    world.mission = mission;
    world.objectives = prepareObjectives(mission);
    world.objectives.push({
      key: 'b',
      kind: 'reach',
      optional: true,
      complete: true,
      failed: false,
      reward: 500,
      progress: 1,
      total: 1,
    });
    world.result = 'lost';

    const outcome = missionOutcome(world, mission);
    assert.equal(outcome.bonusSalvage, 0, 'a lost mission paid a bonus');
  });
});
