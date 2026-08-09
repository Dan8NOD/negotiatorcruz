import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ROUND_PRESETS,
  DEFAULT_PRESET,
  TACTICS,
  OFFERS,
  FIELD,
  HIT_TACTIC,
  HIT_OFFER,
  LAND_OFFER,
  MISS_TACTIC,
  MAX_BLOCKS,
  presetById,
  createSession,
  start,
  pause,
  resume,
  reset,
  update,
  aimAt,
  setFiring,
  remainingMs,
  formatClock,
  snapshot,
} from '../web/timer-engine.js';

/*
 * The engine is pure and deterministic precisely so these can assert real
 * gameplay outcomes — a score, a tactic that got through, a block that should
 * not have spawned — rather than "it did not throw". Anything here that only checks a
 * type is a placeholder for a test that has not been written yet.
 */

const STEP = 1000 / 60;

/** Drive a session forward `ms` in the same fixed steps the engine simulates
 *  in, so tests never accumulate step debt the renderer would not have. */
function run(session, ms, { from = 0 } = {}) {
  let now = from;
  const until = from + ms;
  while (now < until) {
    now = Math.min(until, now + STEP);
    update(session, now);
  }
  return now;
}

// ── round presets ───────────────────────────────────────────────────────────

test('round presets', async (t) => {
  await t.test('are unique, positive, and ascending', () => {
    const ids = ROUND_PRESETS.map((p) => p.id);
    assert.equal(new Set(ids).size, ids.length, 'preset ids must be unique');

    let previous = 0;
    for (const preset of ROUND_PRESETS) {
      assert.ok(preset.ms > previous, `${preset.id} should be longer than the one before it`);
      previous = preset.ms;
    }
  });

  await t.test('include the twelve-minute session the site advertises', () => {
    // index.html and system.html both promise "a three-stage session in twelve
    // minutes". If that claim moves, this preset moves with it.
    const session = ROUND_PRESETS.find((p) => p.ms === 720_000);
    assert.ok(session, 'a 12-minute preset must exist');
  });

  await t.test('the default resolves', () => {
    assert.equal(presetById(DEFAULT_PRESET).id, DEFAULT_PRESET);
  });

  await t.test('an unknown id throws rather than returning undefined', () => {
    assert.throws(() => presetById('nope'), TypeError);
  });
});

// ── the clock ───────────────────────────────────────────────────────────────

test('the clock', async (t) => {
  await t.test('does not advance until started', () => {
    const s = createSession({ durationMs: 60_000 });
    update(s, 10_000);
    assert.equal(remainingMs(s), 60_000);
    assert.equal(s.state, 'idle');
  });

  await t.test('counts down and ends on time', () => {
    const s = createSession({ durationMs: 1000 });
    start(s, 0);
    run(s, 1200);
    assert.equal(remainingMs(s), 0);
    assert.equal(s.state, 'done');
  });

  await t.test('is wall-clock accurate across a backgrounded tab', () => {
    // A practice timer that loses a minute because the facilitator switched
    // apps is a broken timer, so the clock is deliberately uncapped.
    const s = createSession({ durationMs: 300_000 });
    start(s, 0);
    update(s, 120_000);
    assert.equal(remainingMs(s), 180_000);
  });

  await t.test('never runs past zero', () => {
    const s = createSession({ durationMs: 5000 });
    start(s, 0);
    update(s, 900_000);
    assert.equal(remainingMs(s), 0);
    assert.equal(s.elapsedMs, 5000);
  });

  await t.test('holds while paused', () => {
    const s = createSession({ durationMs: 60_000 });
    start(s, 0);
    run(s, 1000);
    const held = remainingMs(s);

    pause(s);
    update(s, 30_000);
    assert.equal(remainingMs(s), held, 'a paused clock must not drift');

    resume(s, 30_000);
    run(s, 1000, { from: 30_000 });
    assert.ok(remainingMs(s) < held, 'resuming must start it again');
  });

  await t.test('ignores updates once done', () => {
    const s = createSession({ durationMs: 1000 });
    start(s, 0);
    run(s, 1100);
    const after = { ...snapshot(s) };
    update(s, 50_000);
    assert.equal(s.state, 'done');
    assert.equal(snapshot(s).remainingMs, after.remainingMs);
  });
});

test('formatClock', () => {
  assert.equal(formatClock(0), '0:00');
  assert.equal(formatClock(1), '0:01', 'a sliver of a second still reads as a second left');
  assert.equal(formatClock(7_000), '0:07');
  assert.equal(formatClock(60_000), '1:00');
  assert.equal(formatClock(180_000), '3:00');
  assert.equal(formatClock(720_000), '12:00');
  assert.equal(formatClock(-5_000), '0:00', 'a negative remainder is still zero');
});

// ── timer mode simulates nothing ────────────────────────────────────────────

test('timer mode', async (t) => {
  await t.test('never spawns anything', () => {
    const s = createSession({ durationMs: 60_000, mode: 'timer' });
    start(s, 0);
    run(s, 20_000);
    assert.equal(s.blocks.length, 0);
    assert.equal(s.shots.length, 0);
    assert.equal(s.score, 0);
    assert.equal(s.missed, 0);
  });

  await t.test('rejects an unknown mode instead of silently picking one', () => {
    assert.throws(() => createSession({ mode: 'shooter' }), TypeError);
  });

  await t.test('rejects a zero or negative round', () => {
    assert.throws(() => createSession({ durationMs: 0 }), TypeError);
    assert.throws(() => createSession({ durationMs: -1 }), TypeError);
  });
});

// ── the game ────────────────────────────────────────────────────────────────

test('the arcade', async (t) => {
  await t.test('spawns while the round runs', () => {
    const s = createSession({ durationMs: 60_000, mode: 'arcade', seed: 7 });
    start(s, 0);
    run(s, 10_000);
    assert.ok(s.blocks.length > 0, 'ten seconds should have put something on screen');
  });

  await t.test('only ever spawns known labels', () => {
    const s = createSession({ durationMs: 60_000, mode: 'arcade', seed: 3 });
    start(s, 0);
    const seen = new Set();
    let now = 0;
    for (let i = 0; i < 40; i++) {
      now = run(s, 500, { from: now });
      for (const b of s.blocks) seen.add(b.label);
    }
    assert.ok(seen.size > 1, 'the run should have produced a variety of blocks');
    for (const label of seen) {
      assert.ok(
        TACTICS.includes(label) || OFFERS.includes(label),
        `${label} is not in either pool`,
      );
    }
  });

  await t.test('does not fast-forward the game after a backgrounded tab', () => {
    // The clock catches up; the battlefield does not. Coming back to thirty
    // seconds of blocks that fell while you were in another app is not a
    // difficulty spike, it is a bug.
    const s = createSession({ durationMs: 300_000, mode: 'arcade', seed: 11 });
    start(s, 0);
    update(s, 30_000);
    assert.equal(remainingMs(s), 270_000, 'the clock still caught up');
    assert.ok(s.blocks.length <= 1, `expected at most one spawn, got ${s.blocks.length}`);
  });

  await t.test('is deterministic for a given seed', () => {
    const play = (seed) => {
      const s = createSession({ durationMs: 30_000, mode: 'arcade', seed });
      start(s, 0);
      let now = 0;
      for (let i = 0; i < 12; i++) {
        aimAt(s, i % 2 ? 0.2 : 0.8);
        setFiring(s, i % 3 !== 0);
        now = run(s, 2000, { from: now });
      }
      return { score: s.score, missed: s.missed, labels: s.blocks.map((b) => b.label) };
    };

    assert.deepEqual(play(42), play(42), 'same seed, same round');
    assert.notDeepEqual(play(42), play(43), 'a different seed should play differently');
  });
});

// ── the one decision the game asks you to make ──────────────────────────────

test('tactics and offers score in opposite directions', async (t) => {
  /** A session with one planted block and nothing else in flight. Short runs
   *  keep the spawner (which fires no sooner than ~550ms) out of the way. */
  function planted(kind, { x, y, speed = 0.05 }) {
    const s = createSession({ durationMs: 60_000, mode: 'arcade', seed: 1 });
    start(s, 0);
    s.blocks.push({ x, y, kind, label: kind === 'offer' ? OFFERS[0] : TACTICS[0], speed });
    return s;
  }

  await t.test('shooting a tactic scores', () => {
    const s = planted('tactic', { x: 0.5, y: 0.7 });
    aimAt(s, 0.5);
    setFiring(s, true);
    run(s, 450);
    assert.equal(s.score, HIT_TACTIC);
    assert.equal(s.missed, 0);
  });

  await t.test('letting a tactic land costs', () => {
    const s = planted('tactic', { x: 0.9, y: 0.95, speed: 0.6 });
    aimAt(s, 0.2); // stand well clear
    run(s, 200);
    assert.equal(s.score, MISS_TACTIC);
    assert.equal(s.missed, 1);
  });

  await t.test('letting an offer land pays', () => {
    const s = planted('offer', { x: 0.9, y: 0.95, speed: 0.6 });
    aimAt(s, 0.2);
    run(s, 200);
    assert.equal(s.score, LAND_OFFER);
    assert.equal(s.missed, 0);
  });

  await t.test('shooting an offer costs', () => {
    const s = planted('offer', { x: 0.5, y: 0.7 });
    aimAt(s, 0.5);
    setFiring(s, true);
    run(s, 450);
    assert.equal(s.score, HIT_OFFER);
    assert.ok(s.score < 0, 'blasting a genuine offer should hurt');
  });

  await t.test('a held trigger is what makes the choice a choice', async (tt) => {
    await tt.test('nothing fires until the trigger is held', () => {
      const s = planted('tactic', { x: 0.5, y: 0.7 });
      aimAt(s, 0.5);
      run(s, 900);
      assert.equal(s.shots.length, 0, 'an idle trigger must not fire');
      assert.equal(s.score, 0);
    });

    await tt.test('pressing fires at once, not after the cooldown', () => {
      // A gun that swallows the first press for a quarter of a second reads as
      // a dropped input, and the player blames the game rather than their aim.
      const s = createSession({ durationMs: 60_000, mode: 'arcade', seed: 1 });
      start(s, 0);
      setFiring(s, true);
      run(s, STEP * 2);
      assert.equal(s.shots.length, 1);
    });

    await tt.test('releasing stops the gun', () => {
      // Shots already in flight still count — you cannot un-say a thing. What
      // releasing buys you is that no new ones leave the barrel.
      const s = createSession({ durationMs: 60_000, mode: 'arcade', seed: 1 });
      start(s, 0);
      setFiring(s, true);
      run(s, 600);
      assert.ok(s.shots.length > 0, 'the trigger was held, something should be in the air');

      setFiring(s, false);
      run(s, 1200, { from: 600 });
      assert.equal(s.shots.length, 0, 'the field should have cleared and stayed clear');
    });
  });

  await t.test('the two mistakes cost the same', () => {
    // Answering something that did not need answering, and failing to answer
    // something that did. Charging them differently would say one of those is
    // the lesser error, which is not the lesson.
    assert.equal(HIT_OFFER, MISS_TACTIC);
    assert.ok(HIT_OFFER < 0);
  });

  await t.test('doing nothing is not a winning strategy', () => {
    // A quarter of what falls is an offer. If ignoring the field pays, the
    // game is a screensaver — this is the arithmetic that stops that, and it
    // is why MISS_TACTIC is as steep as it is.
    const idle = 0.25 * LAND_OFFER + 0.75 * MISS_TACTIC;
    const spray = 0.25 * HIT_OFFER + 0.75 * HIT_TACTIC;
    const choosing = 0.25 * LAND_OFFER + 0.75 * HIT_TACTIC;
    assert.ok(idle < 0, `standing still should lose points, got ${idle} per block`);
    assert.ok(spray > idle, 'shooting everything should still beat doing nothing');
    assert.ok(choosing > spray, 'choosing should beat spraying by a clear margin');
  });
});

test('the game can never end the round', () => {
  // A facilitator running a twelve-minute drill cannot have the arcade decide
  // the drill is over at 0:47. The first version had three lives and did
  // exactly that the first time it was played.
  const s = createSession({ durationMs: 600_000, mode: 'arcade', seed: 1 });
  start(s, 0);
  aimAt(s, 0.1);
  for (let i = 0; i < 20; i++) {
    s.blocks.push({ x: 0.9, y: 0.95, kind: 'tactic', label: TACTICS[0], speed: 0.6 });
  }
  run(s, 300);
  assert.equal(s.missed, 20);
  assert.ok(s.score < 0, 'twenty tactics through should hurt');
  assert.equal(s.state, 'running', 'and the clock should still be running');
  assert.ok(remainingMs(s) > 0);
});

test('one shot destroys one block', () => {
  const s = createSession({ durationMs: 60_000, mode: 'arcade', seed: 1 });
  start(s, 0);
  aimAt(s, 0.5);
  // Two tactics stacked at the same spot. A shot that punched through both
  // would make a wall of blocks free to clear.
  s.blocks.push({ x: 0.5, y: 0.7, kind: 'tactic', label: TACTICS[0], speed: 0 });
  s.blocks.push({ x: 0.5, y: 0.7, kind: 'tactic', label: TACTICS[1], speed: 0 });
  setFiring(s, true);
  run(s, 200); // one shot's worth: the press fires now, the next is 260ms away
  assert.equal(s.score, HIT_TACTIC, 'exactly one block should have been destroyed');
  assert.equal(s.blocks.length, 1);
});

// ── the balance, played rather than argued about ────────────────────────────

test('the balance survives contact with a player', async (t) => {
  /** A plain heuristic: chase the lowest tactic, hold fire when an offer is in
   *  the lane. No lookahead and no optimisation — roughly what a person does
   *  after ten seconds of learning the rules. */
  function competent(s) {
    const target = s.blocks.filter((b) => b.kind === 'tactic').sort((a, b) => b.y - a.y)[0];
    if (target) aimAt(s, target.x);
    const offerInLane = s.blocks.some(
      (b) => b.kind === 'offer' && Math.abs(b.x - s.tankX) <= FIELD.blockHalfWidth + 0.02,
    );
    const onTarget = target && Math.abs(target.x - s.tankX) <= FIELD.blockHalfWidth * 0.7;
    setFiring(s, Boolean(onTarget) && !offerInLane);
  }

  function play(policy, { durationMs = 60_000, seed = 1 } = {}) {
    const s = createSession({ durationMs, mode: 'arcade', seed });
    start(s, 0);
    let peak = 0;
    for (let now = 0; now <= durationMs; now += STEP) {
      policy(s);
      update(s, now);
      peak = Math.max(peak, s.blocks.length);
    }
    return { score: s.score, missed: s.missed, peak };
  }

  const seeds = [1, 2, 3, 4, 5];
  const mean = (policy, opts) =>
    seeds.reduce((n, seed) => n + play(policy, { ...opts, seed }).score, 0) / seeds.length;

  await t.test('a competent player comes out well ahead', () => {
    const skilled = mean(competent);
    const idle = mean(() => {});
    assert.ok(skilled > 0, `playing well should score positively, got ${skilled}`);
    assert.ok(
      skilled > idle + 500,
      `playing should beat ignoring it by a wide margin (${skilled} vs ${idle})`,
    );
  });

  await t.test('holds over a twelve-minute session, not just a sprint', () => {
    // The difficulty ramp is a fraction of the round, so a long round is not
    // simply more of the easy part. It still has to stay winnable at the end.
    const skilled = mean(competent, { durationMs: 720_000 });
    assert.ok(skilled > 0, `a twelve-minute round should still be winnable, got ${skilled}`);
  });

  await t.test('never crowds the field past what can be read', () => {
    // Every block carries a text label. Past about seven, the field stops
    // being a game and becomes a wall of words. An early tuning pass hit 11.
    const worst = Math.max(...seeds.map((seed) => play(() => {}, { durationMs: 180_000, seed }).peak));
    assert.ok(worst <= MAX_BLOCKS, `expected at most ${MAX_BLOCKS} on screen, saw ${worst}`);
  });
});

// ── steering ────────────────────────────────────────────────────────────────

test('the tank', async (t) => {
  await t.test('stays on the field', () => {
    const s = createSession({ durationMs: 60_000, mode: 'arcade' });
    aimAt(s, 5);
    assert.ok(s.targetX <= 1 - FIELD.tankHalfWidth);
    aimAt(s, -5);
    assert.ok(s.targetX >= FIELD.tankHalfWidth);
  });

  await t.test('walks rather than teleports', () => {
    const s = createSession({ durationMs: 60_000, mode: 'arcade' });
    start(s, 0);
    aimAt(s, 0.95);
    update(s, STEP);
    const travelled = s.tankX - 0.5;
    assert.ok(travelled > 0, 'it should have set off');
    assert.ok(
      travelled <= (FIELD.tankSpeed * STEP) / 1000 + 1e-9,
      'it must not cover the field in a single frame',
    );
  });

  await t.test('arrives eventually', () => {
    const s = createSession({ durationMs: 60_000, mode: 'arcade' });
    start(s, 0);
    aimAt(s, 0.9);
    run(s, 1000);
    assert.ok(Math.abs(s.tankX - 0.9) < 1e-6);
  });
});

// ── reset ───────────────────────────────────────────────────────────────────

test('reset', async (t) => {
  await t.test('restores a full clock and a clean field', () => {
    const s = createSession({ durationMs: 30_000, mode: 'arcade', seed: 5 });
    start(s, 0);
    run(s, 8000);
    assert.ok(s.blocks.length > 0);

    reset(s, { seed: 5 });
    assert.equal(s.state, 'idle');
    assert.equal(remainingMs(s), 30_000);
    assert.equal(s.blocks.length, 0);
    assert.equal(s.score, 0);
    assert.equal(s.missed, 0);
  });

  await t.test('replays identically', () => {
    const first = createSession({ durationMs: 20_000, mode: 'arcade', seed: 9 });
    start(first, 0);
    run(first, 6000);
    const before = snapshot(first).blocks.map((b) => b.label);

    reset(first, { seed: 9 });
    start(first, 0);
    run(first, 6000);
    assert.deepEqual(snapshot(first).blocks.map((b) => b.label), before);
  });

  await t.test('can change the round length and the mode', () => {
    const s = createSession({ durationMs: 60_000, mode: 'arcade' });
    reset(s, { durationMs: presetById('session').ms, mode: 'timer' });
    assert.equal(s.durationMs, 720_000);
    assert.equal(s.mode, 'timer');
  });
});

// ── the renderer's view ─────────────────────────────────────────────────────

test('snapshot does not hand out the live session', () => {
  const s = createSession({ durationMs: 60_000, mode: 'arcade', seed: 2 });
  start(s, 0);
  run(s, 4000);

  const view = snapshot(s);
  view.blocks.forEach((b) => {
    b.x = 999;
  });
  view.score = 999;

  assert.ok(s.blocks.every((b) => b.x !== 999), 'drawing code must not be able to move blocks');
  assert.notEqual(s.score, 999);
});
