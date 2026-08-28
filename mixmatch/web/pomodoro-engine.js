// Mix & Match — the Pomodoro machine.
//
// The real technique, not a countdown with a tomato on it:
//
//   - 25 minutes of focus, then a 5-minute break.
//   - Every 4th completed focus earns a 15-minute long break.
//   - Breaks start themselves. The next FOCUS never does — sitting down to
//     work again is a decision, and the machine waits for it.
//   - A pomodoro is indivisible. Resetting mid-focus voids it: the count does
//     not move, and you do that pomodoro again. There is no "skip to the end
//     of focus", because a focus you didn't finish didn't happen.
//   - A break may be skipped (getting back to work early is allowed);
//     a focus may not.
//
// Same construction rules as timer-engine.js, and for the same reasons: no
// DOM, no timers of its own, no Date.now(). Every advance is
// `pomodoroUpdate(session, nowMs)` with the caller's clock, so a whole
// two-hour cycle replays in a unit test in microseconds.
//
// The clock is wall-clock honest across a backgrounded tab: if you background
// the app for 40 minutes mid-focus, the focus completed and counted, the break
// it earned ran and finished, and you come back to the machine waiting for the
// next focus — exactly where a kitchen timer on your desk would have left you.
//
// All function names are prefixed `pomodoro` so this module can be inlined
// into the same single-file scope as timer-engine.js without a collision.
//
// Plain ESM, no dependencies. Imported by the browser and by node --test.

/** The classic durations. Deliberately not user-configurable presets: the
 *  technique's claim is that the numbers are part of the method. */
export const POMODORO_DEFAULTS = Object.freeze({
  focusMs: 25 * 60_000,
  breakMs: 5 * 60_000,
  longBreakMs: 15 * 60_000,
  /** Completed focuses that earn a long break. */
  cyclesPerLong: 4,
});

export const POMODORO_PHASES = Object.freeze({
  focus: 'focus',
  shortBreak: 'break',
  longBreak: 'long',
});

export function createPomodoro(overrides = {}) {
  const config = { ...POMODORO_DEFAULTS, ...overrides };
  for (const key of ['focusMs', 'breakMs', 'longBreakMs']) {
    if (!Number.isFinite(config[key]) || config[key] <= 0) {
      throw new TypeError(`${key} must be a positive number, got ${config[key]}`);
    }
  }
  if (!Number.isInteger(config.cyclesPerLong) || config.cyclesPerLong < 1) {
    throw new TypeError(`cyclesPerLong must be a positive integer, got ${config.cyclesPerLong}`);
  }

  return {
    config,
    phase: 'focus',
    /** idle | running | paused. Idle between a finished break and the next
     *  focus — the machine never starts a focus by itself. */
    state: 'idle',
    elapsedMs: 0,
    lastNow: null,
    /** Completed focuses in the current set of `cyclesPerLong`. */
    cycle: 0,
    /** Completed focuses over this session object's whole life. */
    completed: 0,
    /** Transient since the last update, for the renderer and the chime:
     *  {type:'focusComplete'|'breakComplete', longBreak?, next} */
    events: [],
  };
}

export function pomodoroPhaseMs(session, phase = session.phase) {
  const { config } = session;
  return phase === 'focus' ? config.focusMs
    : phase === 'long' ? config.longBreakMs
    : config.breakMs;
}

export function pomodoroRemainingMs(session) {
  return Math.max(0, pomodoroPhaseMs(session) - session.elapsedMs);
}

export function pomodoroStart(session, nowMs) {
  if (session.state === 'running') return session;
  session.state = 'running';
  session.lastNow = nowMs;
  return session;
}

export function pomodoroPause(session) {
  if (session.state === 'running') session.state = 'paused';
  return session;
}

export function pomodoroResume(session, nowMs) {
  if (session.state !== 'paused') return session;
  session.state = 'running';
  session.lastNow = nowMs;
  return session;
}

/**
 * Void the current phase back to its start.
 *
 * During focus this is the technique's honesty rule: an interrupted pomodoro
 * did not happen, `completed` does not move, and the same pomodoro is done
 * again. It is not a punishment — the count staying honest is what makes the
 * count worth anything.
 */
export function pomodoroReset(session) {
  session.state = 'idle';
  session.elapsedMs = 0;
  session.lastNow = null;
  session.events = [];
  return session;
}

/**
 * End a break early and stand ready for the next focus.
 *
 * Only breaks can be skipped. Skipping a focus would be claiming a pomodoro
 * that never happened, so during focus this is a refusal, not a no-op —
 * a caller invoking it there is a UI bug worth hearing about loudly.
 */
export function pomodoroSkipBreak(session) {
  if (session.phase === 'focus') {
    throw new Error('a focus cannot be skipped — reset voids it instead');
  }
  advance(session);
  return session;
}

/** Move to whatever follows the current phase, resetting the clock. */
function advance(session) {
  if (session.phase === 'focus') {
    session.completed += 1;
    session.cycle += 1;
    const earned = session.cycle >= session.config.cyclesPerLong;
    session.phase = earned ? 'long' : 'break';
    if (earned) session.cycle = 0;
    // Breaks start themselves; rest is not something to forget to take.
    session.state = 'running';
  } else {
    session.phase = 'focus';
    // The next focus never starts itself. Beginning a pomodoro is a decision.
    session.state = 'idle';
    session.lastNow = null;
  }
  session.elapsedMs = 0;
}

/**
 * Advance to `nowMs`, crossing as many phase boundaries as the elapsed time
 * truly covers. Backgrounded for 40 minutes mid-focus? The focus completed
 * and counted, its break ran and finished, and the machine is idle at the
 * next focus — the excess beyond that is discarded, because a focus must not
 * consume time the user never chose to give it.
 */
export function pomodoroUpdate(session, nowMs) {
  if (session.state !== 'running') return session;

  let remaining = Math.max(0, nowMs - (session.lastNow ?? nowMs));
  session.lastNow = nowMs;
  session.events = [];

  while (remaining > 0 && session.state === 'running') {
    const room = pomodoroPhaseMs(session) - session.elapsedMs;
    if (remaining < room) {
      session.elapsedMs += remaining;
      return session;
    }

    remaining -= room;
    const finished = session.phase;
    advance(session);
    session.events.push(
      finished === 'focus'
        ? { type: 'focusComplete', longBreak: session.phase === 'long', next: session.phase }
        : { type: 'breakComplete', next: 'focus' },
    );
  }

  return session;
}

/** A read-only view for the renderer. */
export function pomodoroSnapshot(session) {
  const phaseMs = pomodoroPhaseMs(session);
  return {
    phase: session.phase,
    state: session.state,
    remainingMs: pomodoroRemainingMs(session),
    fractionLeft: phaseMs ? pomodoroRemainingMs(session) / phaseMs : 0,
    cycle: session.cycle,
    cyclesPerLong: session.config.cyclesPerLong,
    completed: session.completed,
    events: session.events.slice(),
  };
}
