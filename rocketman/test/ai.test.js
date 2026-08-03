/**
 * The skirmish opponent.
 *
 * The hard requirement is not that the AI is good — it is that it plays by the
 * same rules the player does. If any of these go red, the AI has started
 * cheating, and a cheating AI stops being an opponent and becomes a tax.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { runAI, findEntity, countOf } from './helpers.js';
import { createWorld } from '../engine/sim.js';
import { updateAI, DIFFICULTIES, createAIState } from '../engine/ai.js';
import { isVisible } from '../engine/vision.js';
import { UNITS, BUILDINGS, START } from '../engine/content.js';

function aiMatch(seed = 2024, difficulty = 'normal', ticks = 3000) {
  const world = createWorld({
    seed,
    players: [
      { faction: 'ascendancy', isAI: true, difficulty },
      { faction: 'bulwark', isAI: true, difficulty },
    ],
  });
  runAI(world, ticks);
  return world;
}

describe('fair play', () => {
  test('never spends scrap it does not have', () => {
    const world = aiMatch(11, 'hard', 4000);
    for (const p of world.players) assert.ok(p.scrap >= 0, `${p.name} went into debt`);
  });

  test('mined scrap accounts for everything above the starting bank', () => {
    // Income can only come from the map. If a player has spent and banked more
    // than they started with plus what they mined, scrap is being conjured.
    const world = aiMatch(12, 'hard', 4000);
    for (const p of world.players) {
      assert.ok(
        p.scrap + p.scrapSpent <= START.scrap + p.scrapMined + 1,
        `${p.name} has unexplained income`
      );
    }
  });

  test('only builds units from its own faction', () => {
    const world = aiMatch(13, 'normal', 5000);
    for (const e of world.entities.values()) {
      if (e.kind !== 'unit') continue;
      const faction = UNITS[e.defId].faction;
      if (!faction) continue; // the Collector is shared
      assert.equal(faction, world.players[e.player].faction, `${e.defId} on the wrong side`);
    }
  });

  test('respects the tech tree', () => {
    const world = aiMatch(14, 'hard', 5000);
    for (const e of world.entities.values()) {
      if (e.kind !== 'unit') continue;
      const def = UNITS[e.defId];
      if (!def.tier || def.tier < 2) continue;
      assert.ok(
        world.players[e.player].tech.has('techlab'),
        `${e.defId} exists without a Tech Lab`
      );
    }
  });

  test('builds only inside its own build radius', () => {
    const world = aiMatch(15, 'normal', 4000);
    for (const e of world.entities.values()) {
      if (e.kind !== 'building' || e.defId === 'command') continue;
      const hq = findEntity(world, (b) => b.defId === 'command' && b.player === e.player);
      if (!hq) continue;
      assert.ok(
        Math.hypot(hq.x - e.x, hq.y - e.y) < 60,
        `${e.defId} was built implausibly far from its base`
      );
    }
  });

  test('emits only well-formed commands for its own player', () => {
    const world = createWorld({
      seed: 16,
      players: [
        { faction: 'ascendancy', isAI: true, difficulty: 'hard' },
        { faction: 'bulwark', isAI: true, difficulty: 'hard' },
      ],
    });

    const known = new Set([
      'move',
      'attackMove',
      'attack',
      'harvest',
      'stop',
      'hold',
      'ability',
      'build',
      'train',
      'cancelTrain',
      'rally',
    ]);

    for (let i = 0; i < 1500; i++) {
      for (const player of world.players) {
        for (const cmd of updateAI(world, player)) {
          assert.ok(known.has(cmd.type), `unknown command type ${cmd.type}`);
          assert.equal(cmd.player, player.id, 'the AI issued a command as another player');
          for (const id of cmd.ids || []) {
            const e = world.entities.get(id);
            if (e) assert.equal(e.player, player.id, 'the AI commanded a unit it does not own');
          }
        }
      }
      runAI(world, 1);
    }
  });
});

describe('competence', () => {
  test('grows its economy past what it started with', () => {
    const world = aiMatch(21, 'normal', 4000);
    for (const p of world.players) {
      assert.ok(p.scrapMined > 2000, `${p.name} barely mined anything`);
      assert.ok(countOf(world, 'collector', p.id) > 1, `${p.name} lost its economy`);
    }
  });

  test('keeps the lights on', () => {
    const world = aiMatch(22, 'normal', 4000);
    for (const p of world.players) {
      assert.ok(p.powerMade > 0, `${p.name} never built a reactor`);
    }
  });

  test('reaches tier two on a normal-length match', () => {
    const world = aiMatch(23, 'hard', 6000);
    const reached = world.players.some((p) => p.tech.has('techlab'));
    assert.ok(reached, 'neither AI teched up in five minutes');
  });

  test('builds an army and eventually fights with it', () => {
    const world = aiMatch(24, 'hard', 8000);
    const fought = world.players.some((p) => p.stats.killed > 0);
    assert.ok(fought, 'nobody threw a punch in six minutes');
  });

  test('a harder opponent pushes sooner than an easier one', () => {
    assert.ok(DIFFICULTIES.hard.pushValue < DIFFICULTIES.easy.pushValue);
    assert.ok(DIFFICULTIES.hard.thinkInterval < DIFFICULTIES.easy.thinkInterval);
  });

  test('difficulty changes tempo, never income or information', () => {
    // The moment a difficulty setting grants scrap or sight, the game stops
    // being a game and starts being a handicap.
    for (const profile of Object.values(DIFFICULTIES)) {
      for (const key of Object.keys(profile)) {
        assert.ok(
          !/scrap|income|vision|sight|reveal|cheat/i.test(key),
          `difficulty profile exposes ${key}`
        );
      }
    }
  });
});

describe('AI state', () => {
  test('defaults to normal for an unknown difficulty', () => {
    const state = createAIState('impossible');
    assert.equal(state.profile, DIFFICULTIES.normal);
  });

  test('every declared difficulty is complete', () => {
    for (const [id, profile] of Object.entries(DIFFICULTIES)) {
      assert.ok(profile.label, `${id} has no label for the UI`);
      assert.ok(profile.thinkInterval > 0);
      assert.ok(profile.pushValue > 0);
      assert.ok(profile.collectorTarget > 0);
      assert.ok(profile.maxCollectors >= profile.collectorTarget);
    }
  });

  test('an AI player with no buildings left does not throw', () => {
    const world = createWorld({
      seed: 31,
      players: [
        { faction: 'ascendancy', isAI: true },
        { faction: 'bulwark', isAI: true },
      ],
    });
    runAI(world, 200);

    for (const e of [...world.entities.values()]) {
      if (e.player === 1 && e.kind === 'building') e.dead = true;
    }
    runAI(world, 200);
    assert.ok(true);
  });
});
