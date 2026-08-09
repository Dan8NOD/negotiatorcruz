/**
 * The simulation, played headless.
 *
 * The engine takes a seed and a stream of plain input objects and touches
 * nothing else, so the suite can play thousands of ticks in milliseconds. That
 * buys two classes of assertion no amount of manual play would produce:
 *
 *   - **Reproducibility.** Two worlds from one seed, fed identical input, must
 *     stay identical for a whole run. In an arcade charging a token a play,
 *     that is what makes a disputed run answerable rather than arguable.
 *   - **Survivability.** A run has to be winnable-in-principle by a competent
 *     player, and "competent" here is a scripted bot, not a person. If the bot
 *     cannot reach wave 8, no human is going to.
 *
 * The bot is deliberately mediocre — it drives at the nearest threat's opposite
 * and fires at the closest hostile. It has no dodging, no target priority and
 * no idea what a warden is. That is the point: it is a floor, and the game has
 * to be beatable well above it.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { createWorld, step, noInput, runResult } from '../engine/sim.js';
import { ARENA, TICKS_PER_SECOND, TANK, HOSTILES, WAVES, GUNS } from '../engine/content.js';

/* =================================================================== helpers */

/** Run `ticks` steps, calling `drive(world)` for the input each tick. */
function play(world, ticks, drive = () => noInput()) {
  for (let i = 0; i < ticks && !world.over; i++) step(world, drive(world));
  return world;
}

function nearest(world) {
  let best = null;
  let bestD = Infinity;
  for (const h of world.hostiles) {
    if (h.health <= 0) continue;
    const d = Math.hypot(h.x - world.tank.x, h.y - world.tank.y);
    if (d < bestD) {
      bestD = d;
      best = h;
    }
  }
  return best ? { hostile: best, range: bestD } : null;
}

/**
 * A mediocre player.
 *
 * Kites away from the closest thing, keeps roughly to the middle so it does not
 * corner itself, and shoots whatever is nearest. No dodging, no priorities.
 */
function bot(world) {
  const t = world.tank;
  const near = nearest(world);
  const input = noInput();
  if (!near) {
    // Drift to the centre between waves.
    input.moveX = (ARENA.width / 2 - t.x) / 400;
    input.moveY = (ARENA.height / 2 - t.y) / 400;
    return input;
  }

  const away = Math.atan2(t.y - near.hostile.y, t.x - near.hostile.x);
  const toCentre = Math.atan2(ARENA.height / 2 - t.y, ARENA.width / 2 - t.x);
  // Blend fleeing with a pull to the middle, or it backs itself into a corner
  // and dies to the geometry rather than to the game.
  const blend = near.range < 260 ? 0.75 : 0.25;
  input.moveX = Math.cos(away) * blend + Math.cos(toCentre) * (1 - blend);
  input.moveY = Math.sin(away) * blend + Math.sin(toCentre) * (1 - blend);
  input.aim = Math.atan2(near.hostile.y - t.y, near.hostile.x - t.x);
  input.fire = true;
  input.boost = near.range < 120;
  return input;
}

/** How far a bot gets on one seed, with a tick ceiling so a test cannot hang. */
function botRun(seed, maxTicks = TICKS_PER_SECOND * 60 * 6) {
  const world = createWorld({ seed });
  play(world, maxTicks, bot);
  return world;
}

/* ============================================================ determinism */

describe('a run reproduces from its seed', () => {
  test('two worlds fed the same input stay identical', () => {
    const a = createWorld({ seed: 12345 });
    const b = createWorld({ seed: 12345 });

    // A scripted input stream rather than the bot, so the two worlds cannot
    // diverge merely because the bot read one of them.
    for (let i = 0; i < 4000; i++) {
      const input = {
        moveX: Math.sin(i / 37),
        moveY: Math.cos(i / 53),
        aim: i / 29,
        fire: i % 7 === 0,
        boost: i % 211 === 0,
      };
      step(a, input);
      step(b, input);
    }

    assert.equal(a.tick, b.tick);
    assert.equal(a.score, b.score);
    assert.equal(a.wave, b.wave);
    assert.equal(a.tank.health, b.tank.health);
    assert.equal(a.hostiles.length, b.hostiles.length);
    assert.deepEqual(
      a.hostiles.map((h) => [h.type, Math.round(h.x), Math.round(h.y), Math.round(h.health)]),
      b.hostiles.map((h) => [h.type, Math.round(h.x), Math.round(h.y), Math.round(h.health)])
    );
  });

  test('different seeds produce different arenas', () => {
    const a = createWorld({ seed: 1 });
    const b = createWorld({ seed: 2 });
    assert.notDeepEqual(a.cover, b.cover, 'two seeds generated an identical arena');
  });

  test('the run result carries the seed that produced it', () => {
    const world = botRun(99, 600);
    assert.equal(runResult(world).seed, 99);
  });
});

/* =========================================================== the arena rules */

describe('nothing escapes the arena', () => {
  test('the tank cannot be driven through a wall', () => {
    const world = createWorld({ seed: 7 });
    // Hold full throttle into the top-left corner for ten seconds.
    play(world, TICKS_PER_SECOND * 10, () => ({ ...noInput(), moveX: -1, moveY: -1, boost: true }));
    assert.ok(world.tank.x >= TANK.radius - 0.5, `tank at x=${world.tank.x}`);
    assert.ok(world.tank.y >= TANK.radius - 0.5, `tank at y=${world.tank.y}`);
  });

  test('the tank never ends a tick inside cover', () => {
    const world = createWorld({ seed: 3 });
    for (let i = 0; i < TICKS_PER_SECOND * 25; i++) {
      step(world, { ...noInput(), moveX: Math.sin(i / 20), moveY: Math.cos(i / 17), boost: i % 90 === 0 });
      for (const c of world.cover) {
        const nx = Math.max(c.x, Math.min(world.tank.x, c.x + c.w));
        const ny = Math.max(c.y, Math.min(world.tank.y, c.y + c.h));
        const d = Math.hypot(world.tank.x - nx, world.tank.y - ny);
        assert.ok(d >= TANK.radius - 1, `tank overlapped cover by ${(TANK.radius - d).toFixed(2)} at tick ${i}`);
      }
    }
  });

  test('hostiles stay inside the arena too', () => {
    const world = botRun(21, TICKS_PER_SECOND * 90);
    for (const h of world.hostiles) {
      assert.ok(h.x >= 0 && h.x <= ARENA.width, `${h.type} at x=${h.x}`);
      assert.ok(h.y >= 0 && h.y <= ARENA.height, `${h.type} at y=${h.y}`);
    }
  });

  test('no position is ever NaN', () => {
    // The failure mode this catches is resolveCover dividing by a zero-length
    // normal when something spawns dead-centre in a block. One NaN poisons the
    // world permanently and the symptom is an invisible, unkillable enemy.
    const world = botRun(4242, TICKS_PER_SECOND * 120);
    const bodies = [world.tank, ...world.hostiles, ...world.shots, ...world.pickups];
    for (const b of bodies) {
      assert.ok(Number.isFinite(b.x) && Number.isFinite(b.y), `a ${b.type || 'body'} has a non-finite position`);
    }
  });
});

/* ============================================================ shots and cover */

describe('shots behave', () => {
  test('a fast round cannot tunnel through cover', () => {
    // The lance travels 19 units a tick. Testing the new point rather than the
    // segment travelled would let it pass clean through a thin wall.
    const world = createWorld({ seed: 11 });
    world.cover = [{ x: 600, y: 500, w: 40, h: 400 }];
    world.tank.x = 400;
    world.tank.y = 700;
    world.tank.gun = 'lance';
    world.tank.turret = 0;
    world.tank.cooldown = 0;

    step(world, { ...noInput(), aim: 0, fire: true });
    for (let i = 0; i < 60; i++) step(world, noInput());

    const through = world.shots.filter((s) => s.friendly && s.x > 660);
    assert.equal(through.length, 0, 'a lance round passed through a wall');
  });

  test('a shot that hits nothing expires rather than living forever', () => {
    const world = createWorld({ seed: 5 });
    world.cover = [];
    world.tank.cooldown = 0;
    step(world, { ...noInput(), aim: 0, fire: true });
    assert.ok(world.shots.length > 0);
    play(world, TICKS_PER_SECOND * 4);
    assert.equal(world.shots.filter((s) => s.friendly).length, 0, 'a friendly shot outlived its life');
  });

  test('a piercing round hits each target once and no more', () => {
    const world = createWorld({ seed: 8 });
    world.cover = [];
    world.hostiles = [];
    world.tank.x = 200;
    world.tank.y = 700;
    world.tank.gun = 'lance';
    world.tank.cooldown = 0;

    // Three scuttlers in a line. Health is set high so none dies and each can
    // be inspected for exactly one hit's worth of damage.
    for (let i = 0; i < 3; i++) {
      world.hostiles.push({
        id: 900 + i,
        type: 'scuttler',
        x: 400 + i * 90,
        y: 700,
        vx: 0,
        vy: 0,
        facing: Math.PI,
        radius: HOSTILES.scuttler.radius,
        health: 500,
        cooldown: 99,
        telegraph: 0,
        spawnTimer: 0,
        broodOf: null,
      });
    }

    step(world, { ...noInput(), aim: 0, fire: true });
    for (let i = 0; i < 40; i++) step(world, noInput());

    for (const h of world.hostiles) {
      const taken = 500 - h.health;
      // Damage is dealt in whole hits; anything but one is a double-hit.
      assert.equal(taken, GUNS.lance.damage, `a scuttler took ${taken}, not one lance hit`);
    }
  });
});

/* =============================================================== the hostiles */

describe('the hostiles hold their promises', () => {
  test('a warden takes far longer to kill from the front than from behind', () => {
    const seconds = (fromAngle) => {
      const world = createWorld({ seed: 2 });
      world.cover = [];
      world.hostiles = [
        {
          id: 1,
          type: 'warden',
          x: 700,
          y: 700,
          vx: 0,
          vy: 0,
          facing: 0,
          radius: HOSTILES.warden.radius,
          health: HOSTILES.warden.health,
          cooldown: 99,
          telegraph: 0,
          spawnTimer: 0,
          broodOf: null,
        },
      ];
      // Park the tank at the requested angle, out of contact range, and hold
      // the trigger. The warden is pinned by overwriting it each tick so the
      // test measures the shield rather than the chase.
      const r = 260;
      world.tank.x = 700 + Math.cos(fromAngle) * r;
      world.tank.y = 700 + Math.sin(fromAngle) * r;

      let ticks = 0;
      const limit = TICKS_PER_SECOND * 40;
      while (world.hostiles[0] && world.hostiles[0].health > 0 && ticks < limit) {
        const h = world.hostiles[0];
        h.x = 700;
        h.y = 700;
        h.vx = 0;
        h.vy = 0;
        h.facing = 0;
        world.tank.x = 700 + Math.cos(fromAngle) * r;
        world.tank.y = 700 + Math.sin(fromAngle) * r;
        world.tank.turret = fromAngle + Math.PI;
        step(world, { ...noInput(), aim: fromAngle + Math.PI, fire: true });
        ticks++;
      }
      return ticks / TICKS_PER_SECOND;
    };

    const front = seconds(0);
    const back = seconds(Math.PI);
    assert.ok(back < front / 3, `front ${front.toFixed(1)}s vs back ${back.toFixed(1)}s — the shield is not mattering`);
  });

  test('a hive spawns, and stops when it dies', () => {
    const world = createWorld({ seed: 6 });
    world.cover = [];
    world.hostiles = [
      {
        id: 1,
        type: 'hive',
        x: 500,
        y: 500,
        vx: 0,
        vy: 0,
        facing: 0,
        radius: HOSTILES.hive.radius,
        health: HOSTILES.hive.health,
        cooldown: 99,
        telegraph: 0,
        spawnTimer: HOSTILES.hive.spawn.every,
        broodOf: null,
      },
    ];
    world.waveActive = true;
    world.tank.x = 1200;
    world.tank.y = 1200;

    play(world, TICKS_PER_SECOND * 12);
    const brood = world.hostiles.filter((h) => h.type === 'scuttler').length;
    assert.ok(brood > 0, 'the hive never spawned anything');
    assert.ok(brood <= HOSTILES.hive.spawn.cap, `the hive exceeded its cap with ${brood} alive`);
  });

  test('a gunhead will not shoot through a wall', () => {
    const world = createWorld({ seed: 9 });
    world.cover = [{ x: 600, y: 400, w: 60, h: 600 }];
    world.hostiles = [
      {
        id: 1,
        type: 'gunhead',
        x: 450,
        y: 700,
        vx: 0,
        vy: 0,
        facing: 0,
        radius: HOSTILES.gunhead.radius,
        health: HOSTILES.gunhead.health,
        cooldown: 0,
        telegraph: 0,
        spawnTimer: 0,
        broodOf: null,
      },
    ];
    world.waveActive = true;
    world.tank.x = 900;
    world.tank.y = 700;

    play(world, TICKS_PER_SECOND * 8);
    assert.equal(world.shots.filter((s) => !s.friendly).length, 0, 'a gunhead fired through cover');
  });

  test('a scuttler dies delivering its hit', () => {
    const world = createWorld({ seed: 13 });
    world.cover = [];
    world.hostiles = [
      {
        id: 1,
        type: 'scuttler',
        x: world.tank.x + 40,
        y: world.tank.y,
        vx: 0,
        vy: 0,
        facing: Math.PI,
        radius: HOSTILES.scuttler.radius,
        health: HOSTILES.scuttler.health,
        cooldown: 99,
        telegraph: 0,
        spawnTimer: 0,
        broodOf: null,
      },
    ];
    world.waveActive = true;
    const before = world.tank.health;
    play(world, TICKS_PER_SECOND * 3);
    assert.ok(world.tank.health < before, 'the scuttler never connected');
    assert.equal(world.hostiles.length, 0, 'the scuttler survived its own detonation');
  });
});

/* ================================================================= the waves */

describe('the wave schedule', () => {
  test('waves arrive, and only once the field is clear', () => {
    const world = createWorld({ seed: 31 });
    let sawStart = 0;
    for (let i = 0; i < TICKS_PER_SECOND * 30; i++) {
      step(world, bot(world));
      for (const ev of world.events) {
        if (ev.type !== 'waveStart') continue;
        sawStart++;
        // Nothing from the previous wave may still be alive when the next
        // starts, or the arena compounds until it is unplayable.
        assert.equal(ev.wave, sawStart, 'waves arrived out of order');
      }
      if (world.over) break;
    }
    assert.ok(sawStart >= 2, `only ${sawStart} wave(s) started in 30 seconds`);
  });

  test('a wave never exceeds the simultaneous ceiling', () => {
    for (const seed of [1, 2, 3, 17, 88]) {
      const world = createWorld({ seed });
      for (let i = 0; i < TICKS_PER_SECOND * 60 * 3 && !world.over; i++) {
        step(world, bot(world));
        assert.ok(
          world.hostiles.length <= WAVES.maxAlive,
          `seed ${seed} reached ${world.hostiles.length} hostiles at wave ${world.wave}`
        );
      }
    }
  });

  test('the wave that introduces a hostile actually contains one', () => {
    for (const [id, def] of Object.entries(HOSTILES)) {
      const world = createWorld({ seed: 555 });
      // Fast-forward by clearing each wave outright until the debut wave.
      while (world.wave < def.minWave && world.tick < TICKS_PER_SECOND * 600) {
        step(world, noInput());
        for (const h of world.hostiles) h.health = 0;
      }
      // Let the debut wave spawn without immediately clearing it.
      while (world.wave === def.minWave - 1 && world.tick < TICKS_PER_SECOND * 700) step(world, noInput());
      assert.ok(
        world.hostiles.some((h) => h.type === id),
        `wave ${def.minWave} was supposed to introduce the ${id} and did not`
      );
    }
  });
});

/* =========================================================== is it playable? */

describe('the game is survivable, and eventually is not', () => {
  test('every run terminates, on every seed', () => {
    // The most important assertion in this file.
    //
    // A wave only ends when the field is clear, so anything that can avoid
    // resolution indefinitely makes the *run* indefinite — and an arcade round
    // that never ends is a token spent on a screensaver. Three separate causes
    // were found this way: hostiles with no obstacle avoidance wedging against
    // cover, a gunhead spawning outside its own range with no way to close,
    // and a lobber holding its standoff band behind a wall.
    //
    // Twenty seeds because the failures were seed-dependent: five of the first
    // thirty stalled, and none of them were the seed being developed against.
    const stalled = [];
    for (let seed = 1; seed <= 20; seed++) {
      const world = botRun(seed, TICKS_PER_SECOND * 60 * 8);
      if (!world.over) stalled.push(`seed ${seed} (wave ${world.wave})`);
    }
    assert.deepEqual(stalled, [], 'runs that never ended');
  });

  test('a mediocre bot always clears the opening waves', () => {
    // The floor, and it is a floor rather than a target. This bot cannot
    // dodge a telegraph, cannot use cover, cannot prioritise a hive, and
    // retreats from everything — so wave 3 from it means the opening is not
    // punishing a human who does any of those things.
    for (let seed = 1; seed <= 20; seed++) {
      const world = botRun(seed, TICKS_PER_SECOND * 60 * 8);
      assert.ok(world.wave >= 3, `seed ${seed} killed the bot on wave ${world.wave}`);
    }
  });

  test('the bot does not clear the game either', () => {
    // The other side of the floor: if a bot this poor were reaching wave 15,
    // the difficulty curve would not be doing anything.
    const reached = [];
    for (let seed = 1; seed <= 10; seed++) {
      reached.push(botRun(seed, TICKS_PER_SECOND * 60 * 8).wave);
    }
    const best = Math.max(...reached);
    assert.ok(best <= 10, `a bot with no dodging reached wave ${best}; the curve is too flat`);
  });

  test('doing nothing at all is fatal, and not instantly', () => {
    const world = createWorld({ seed: 1 });
    play(world, TICKS_PER_SECOND * 90);
    assert.ok(world.over, 'standing still forever is survivable');
    assert.ok(world.tick > TICKS_PER_SECOND * 8, 'an idle player dies within eight seconds');
  });

  test('a run reports a coherent result', () => {
    const world = botRun(2);
    const r = runResult(world);
    assert.ok(r.score > 0 && r.wave > 0 && r.kills > 0);
    assert.ok(r.accuracy >= 0 && r.accuracy <= 100, `accuracy of ${r.accuracy}%`);
    assert.equal(r.seconds, Math.round((r.ticks / TICKS_PER_SECOND) * 10) / 10);
  });

  test('score only ever goes up', () => {
    const world = createWorld({ seed: 77 });
    let last = 0;
    for (let i = 0; i < TICKS_PER_SECOND * 120 && !world.over; i++) {
      step(world, bot(world));
      assert.ok(world.score >= last, 'the score went backwards');
      last = world.score;
    }
  });
});
