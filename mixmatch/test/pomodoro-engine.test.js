import test from 'node:test';
import assert from 'node:assert/strict';

import {
  POMODORO_DEFAULTS,
  createPomodoro,
  pomodoroStart,
  pomodoroPause,
  pomodoroResume,
  pomodoroReset,
  pomodoroSkipBreak,
  pomodoroUpdate,
  pomodoroRemainingMs,
  pomodoroPhaseMs,
  pomodoroSnapshot,
} from '../web/pomodoro-engine.js';

/*
 * These assert the *technique*, not a countdown. The rules that make a
 * Pomodoro a Pomodoro — the 4th break is long, breaks auto-start and focuses
 * do not, an interrupted pomodoro does not count — are exactly the rules a
 * plausible-looking refactor quietly breaks.
 */

const MIN = 60_000;
const STEP = 250;

/** Drive the session forward in small steps, like a real animation frame
 *  would, so a boundary is crossed the way it is crossed in production. */
function run(session, ms, { from = 0 } = {}) {
  let now = from;
  const until = from + ms;
  while (now < until) {
    now = Math.min(until, now + STEP);
    pomodoroUpdate(session, now);
  }
  return now;
}

/** Run a phase out to exactly its boundary and return the clock. Landing on
 *  the boundary rather than past it matters: overshooting spends the overshoot
 *  inside the *next* phase, which is real behaviour but not what these tests
 *  are measuring. */
function finishPhase(session, from) {
  return run(session, pomodoroRemainingMs(session), { from });
}

// ── the classic numbers ─────────────────────────────────────────────────────

test('the durations are the classic ones', () => {
  // The technique's claim is that the numbers are part of the method. If these
  // drift, it is a focus timer, not a Pomodoro.
  assert.equal(POMODORO_DEFAULTS.focusMs, 25 * MIN);
  assert.equal(POMODORO_DEFAULTS.breakMs, 5 * MIN);
  assert.equal(POMODORO_DEFAULTS.longBreakMs, 15 * MIN);
  assert.equal(POMODORO_DEFAULTS.cyclesPerLong, 4);
});

test('a new machine is idle at a full focus', () => {
  const s = createPomodoro();
  assert.equal(s.phase, 'focus');
  assert.equal(s.state, 'idle');
  assert.equal(pomodoroRemainingMs(s), 25 * MIN);
  assert.equal(s.completed, 0);
});

test('nonsense configuration is refused, not coerced', () => {
  assert.throws(() => createPomodoro({ focusMs: 0 }), TypeError);
  assert.throws(() => createPomodoro({ breakMs: -1 }), TypeError);
  assert.throws(() => createPomodoro({ cyclesPerLong: 0 }), TypeError);
  assert.throws(() => createPomodoro({ cyclesPerLong: 2.5 }), TypeError);
});

// ── the cycle ───────────────────────────────────────────────────────────────

test('the cycle', async (t) => {
  await t.test('focus is followed by a short break that starts itself', () => {
    const s = createPomodoro();
    pomodoroStart(s, 0);
    finishPhase(s, 0);

    assert.equal(s.phase, 'break');
    assert.equal(s.state, 'running', 'rest is not something to forget to take');
    assert.equal(s.completed, 1);
    assert.equal(pomodoroRemainingMs(s), 5 * MIN);
  });

  await t.test('a finished break waits for you to choose the next focus', () => {
    const s = createPomodoro();
    pomodoroStart(s, 0);
    let now = finishPhase(s, 0);
    now = finishPhase(s, now);

    assert.equal(s.phase, 'focus');
    assert.equal(s.state, 'idle', 'sitting down to work again is a decision');
    assert.equal(pomodoroRemainingMs(s), 25 * MIN);

    // And it stays idle no matter how long nobody presses anything.
    pomodoroUpdate(s, now + 60 * MIN);
    assert.equal(pomodoroRemainingMs(s), 25 * MIN);
  });

  await t.test('the fourth focus earns a long break, and the count resets', () => {
    const s = createPomodoro();
    let now = 0;
    const breaks = [];

    for (let i = 0; i < 4; i++) {
      pomodoroStart(s, now);
      now = finishPhase(s, now); // focus
      breaks.push({ phase: s.phase, ms: pomodoroRemainingMs(s) });
      now = finishPhase(s, now); // its break
    }

    assert.deepEqual(breaks.map((b) => b.phase), ['break', 'break', 'break', 'long']);
    assert.deepEqual(breaks.map((b) => b.ms), [5 * MIN, 5 * MIN, 5 * MIN, 15 * MIN]);
    assert.equal(s.completed, 4);
    assert.equal(s.cycle, 0, 'the set starts over after a long break');
  });

  await t.test('a second set behaves like the first', () => {
    const s = createPomodoro();
    let now = 0;
    const phases = [];
    for (let i = 0; i < 8; i++) {
      pomodoroStart(s, now);
      now = finishPhase(s, now);
      phases.push(s.phase);
      now = finishPhase(s, now);
    }
    assert.deepEqual(phases, [
      'break', 'break', 'break', 'long',
      'break', 'break', 'break', 'long',
    ]);
    assert.equal(s.completed, 8);
  });

  await t.test('announces each boundary exactly once', () => {
    const s = createPomodoro();
    pomodoroStart(s, 0);
    const seen = [];
    let now = 0;
    const until = 25 * MIN + 5 * MIN;
    while (now < until) {
      now = Math.min(until, now + STEP);
      pomodoroUpdate(s, now);
      pomodoroSnapshot(s).events.forEach((e) => seen.push(e.type));
    }
    assert.deepEqual(seen, ['focusComplete', 'breakComplete']);
  });
});

// ── a pomodoro is indivisible ───────────────────────────────────────────────

test('an interrupted pomodoro does not count', async (t) => {
  await t.test('reset mid-focus voids it and does not advance the count', () => {
    const s = createPomodoro();
    pomodoroStart(s, 0);
    run(s, 20 * MIN);
    assert.equal(s.completed, 0);

    pomodoroReset(s);
    assert.equal(s.phase, 'focus', 'you do that pomodoro again');
    assert.equal(s.state, 'idle');
    assert.equal(pomodoroRemainingMs(s), 25 * MIN);
    assert.equal(s.completed, 0, 'the count staying honest is what makes it worth anything');
    assert.equal(s.cycle, 0);
  });

  await t.test('twenty-four minutes of focus is worth nothing', () => {
    // The rule that stings, and the one that makes the technique work.
    const s = createPomodoro();
    pomodoroStart(s, 0);
    run(s, 24 * MIN + 59_000);
    pomodoroReset(s);
    assert.equal(s.completed, 0);
  });

  await t.test('a focus cannot be skipped', () => {
    const s = createPomodoro();
    pomodoroStart(s, 0);
    assert.throws(() => pomodoroSkipBreak(s), /cannot be skipped/);
    assert.equal(s.completed, 0);
    assert.equal(s.phase, 'focus');
  });

  await t.test('a break can be skipped — getting back to work early is allowed', () => {
    const s = createPomodoro();
    pomodoroStart(s, 0);
    finishPhase(s, 0);
    assert.equal(s.phase, 'break');

    pomodoroSkipBreak(s);
    assert.equal(s.phase, 'focus');
    assert.equal(s.state, 'idle');
    assert.equal(s.completed, 1, 'the completed focus still counts');
  });

  await t.test('skipping a long break still resets the set', () => {
    const s = createPomodoro();
    let now = 0;
    for (let i = 0; i < 3; i++) {
      pomodoroStart(s, now);
      now = finishPhase(s, now);
      now = finishPhase(s, now);
    }
    pomodoroStart(s, now);
    finishPhase(s, now);
    assert.equal(s.phase, 'long');

    pomodoroSkipBreak(s);
    assert.equal(s.cycle, 0);
    assert.equal(s.completed, 4);
  });
});

// ── pausing ─────────────────────────────────────────────────────────────────

test('pausing', async (t) => {
  await t.test('holds the clock and does not void the pomodoro', () => {
    // Pausing is not the same as being interrupted. Answering the door and
    // coming back is allowed; the technique's purist would disagree, and the
    // technique's purist has never had a doorbell.
    const s = createPomodoro();
    pomodoroStart(s, 0);
    run(s, 5 * MIN);
    const held = pomodoroRemainingMs(s);

    pomodoroPause(s);
    pomodoroUpdate(s, 60 * MIN);
    assert.equal(pomodoroRemainingMs(s), held);
    assert.equal(s.completed, 0);

    pomodoroResume(s, 60 * MIN);
    run(s, MIN, { from: 60 * MIN });
    assert.ok(pomodoroRemainingMs(s) < held);
  });

  await t.test('a paused machine can still be resumed to completion', () => {
    const s = createPomodoro();
    pomodoroStart(s, 0);
    run(s, 10 * MIN);
    pomodoroPause(s);
    pomodoroResume(s, 90 * MIN);
    finishPhase(s, 90 * MIN);
    assert.equal(s.completed, 1);
    assert.equal(s.phase, 'break');
  });
});

// ── the backgrounded tab ────────────────────────────────────────────────────

test('a backgrounded tab', async (t) => {
  await t.test('completes the focus and its break, then waits', () => {
    // A kitchen timer on the desk would have rung, the break would have
    // passed, and you would come back to a machine waiting for the next
    // focus. Anything else is a timer that lied about what happened.
    const s = createPomodoro();
    pomodoroStart(s, 0);
    pomodoroUpdate(s, 40 * MIN);

    assert.equal(s.completed, 1);
    assert.equal(s.phase, 'focus');
    assert.equal(s.state, 'idle');
    assert.equal(pomodoroRemainingMs(s), 25 * MIN,
      'the next focus must not consume time nobody chose to give it');
  });

  await t.test('reports both boundaries it crossed', () => {
    const s = createPomodoro();
    pomodoroStart(s, 0);
    pomodoroUpdate(s, 40 * MIN);
    assert.deepEqual(s.events.map((e) => e.type), ['focusComplete', 'breakComplete']);
  });

  await t.test('crossing many boundaries stops at the next focus, not later', () => {
    // Four hours away must not silently bank four pomodoros nobody worked.
    const s = createPomodoro();
    pomodoroStart(s, 0);
    pomodoroUpdate(s, 4 * 60 * MIN);
    assert.equal(s.completed, 1, 'only the focus that was actually running counts');
    assert.equal(s.phase, 'focus');
    assert.equal(s.state, 'idle');
  });

  await t.test('a break crossed while away leaves the next focus full', () => {
    const s = createPomodoro();
    pomodoroStart(s, 0);
    finishPhase(s, 0);
    assert.equal(s.phase, 'break');
    pomodoroUpdate(s, 25 * MIN + 60 * MIN);
    assert.equal(s.phase, 'focus');
    assert.equal(pomodoroRemainingMs(s), 25 * MIN);
  });
});

// ── the renderer's view ─────────────────────────────────────────────────────

test('the snapshot', async (t) => {
  await t.test('reports progress through the current phase', () => {
    const s = createPomodoro();
    pomodoroStart(s, 0);
    run(s, 5 * MIN);
    const v = pomodoroSnapshot(s);
    assert.equal(v.phase, 'focus');
    assert.ok(Math.abs(v.fractionLeft - 0.8) < 0.01, `expected ~0.8, got ${v.fractionLeft}`);
    assert.equal(v.cyclesPerLong, 4);
  });

  await t.test('counts completed focuses toward the long break', () => {
    const s = createPomodoro();
    let now = 0;
    pomodoroStart(s, now);
    now = finishPhase(s, now);
    now = finishPhase(s, now);
    pomodoroStart(s, now);
    finishPhase(s, now);
    const v = pomodoroSnapshot(s);
    assert.equal(v.completed, 2);
    assert.equal(v.cycle, 2);
  });

  await t.test('does not hand out the live session', () => {
    const s = createPomodoro();
    pomodoroStart(s, 0);
    pomodoroUpdate(s, 26 * MIN);
    const v = pomodoroSnapshot(s);
    v.events.length = 0;
    v.completed = 999;
    assert.equal(s.events.length, 1);
    assert.equal(s.completed, 1);
  });
});

test('phase lengths are reported per phase', () => {
  const s = createPomodoro();
  assert.equal(pomodoroPhaseMs(s, 'focus'), 25 * MIN);
  assert.equal(pomodoroPhaseMs(s, 'break'), 5 * MIN);
  assert.equal(pomodoroPhaseMs(s, 'long'), 15 * MIN);
});

test('a full four-pomodoro set takes exactly two hours', () => {
  // 4 x 25 focus + 3 x 5 short + 15 long = 130 minutes of running clock.
  // Asserted as a whole because it is the number a user would check against
  // a wall clock, and any single wrong duration moves it.
  const s = createPomodoro();
  let running = 0;
  for (let i = 0; i < 4; i++) {
    running += pomodoroPhaseMs(s, 'focus');
    pomodoroStart(s, 0);
    pomodoroUpdate(s, pomodoroPhaseMs(s, 'focus'));
    running += pomodoroPhaseMs(s);
    pomodoroUpdate(s, pomodoroPhaseMs(s, 'focus') + pomodoroPhaseMs(s));
    pomodoroReset(s);
  }
  assert.equal(running, 130 * MIN);
});
