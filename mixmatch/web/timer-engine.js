// Mix & Match — the Timer tab's engine.
//
// WHAT THIS IS
//
// A practice-round clock, and a small arcade game that runs on the same clock.
// One session object drives both, because they are the same thing from the
// user's side: you set a round length, you press start, the round ends when the
// clock says so. Whether you spent that round watching digits or shooting down
// pressure tactics is a mode flag.
//
// WHY IT IS PURE
//
// No DOM, no canvas, no timers of its own, no Date.now(). Every advance is
// `update(nowMs)` with the caller's clock, so a whole round can be replayed in
// a unit test in microseconds and the result is identical every time. The
// drawing and input live in timer-tab.html; this file decides what is true.
//
// WHY IT IS DETERMINISTIC
//
// Seeded RNG plus a fixed simulation step. Same seed and same input timeline
// gives the same score, which is what lets the tests assert real gameplay
// outcomes rather than "it did not throw".
//
// NO ASSETS
//
// Everything on screen is a rectangle, a circle, or a text label. There are no
// images, no sprite sheets and no audio files anywhere in this feature, which
// is the constraint that lets it ship on a static host with nothing to upload
// and nothing to cache-bust.
//
// Plain ESM, no dependencies. Imported by the browser and by node --test.

// ── round lengths ───────────────────────────────────────────────────────────

/**
 * The presets are the drills, not round numbers. Twelve minutes is the
 * three-stage session the site already promises ("if your team can run a
 * three-stage session in twelve minutes"), and a stage is four of those, so
 * the two are the same claim at different zoom levels.
 */
export const ROUND_PRESETS = [
  { id: 'drill', label: '1 min', ms: 60_000, blurb: 'One tool, one rep.' },
  { id: 'stage', label: '3 min', ms: 180_000, blurb: 'One stage of a session.' },
  { id: 'round', label: '5 min', ms: 300_000, blurb: 'A full practice round.' },
  { id: 'session', label: '12 min', ms: 720_000, blurb: 'A three-stage session.' },
];

export const DEFAULT_PRESET = 'stage';

export function presetById(id) {
  const preset = ROUND_PRESETS.find((p) => p.id === id);
  if (!preset) throw new TypeError(`Unknown round preset: ${id}`);
  return preset;
}

// ── what falls ──────────────────────────────────────────────────────────────

/**
 * Pressure tactics. Shooting one is worth points.
 *
 * Kept to short strings on purpose: the label is drawn inside a block roughly
 * a sixth of the field wide, so anything longer than about twelve characters
 * stops being readable on a phone.
 */
export const TACTICS = [
  'Lowball',
  'Nibble',
  'Deadline',
  'Bluff',
  'Good Cop',
  'Exploding',
  'Take It',
  'Flinch',
];

/**
 * Genuine offers. Shooting one costs you, letting it land pays.
 *
 * This is the whole game, and it is why firing is held rather than automatic.
 * An always-on gun would mean the only decision is where to stand, and you
 * would lose points to offers that happened to drift overhead while you were
 * chasing something else. Holding to fire makes *not responding* a move you
 * can actually play — which is the thing being practised. The hard part of a
 * negotiation is rarely having a rebuttal ready; it is noticing that the thing
 * in front of you does not need one.
 */
export const OFFERS = ['Fair Offer', 'Good Faith', 'Real Ask', 'Straight Deal'];

export const HIT_TACTIC = 10;
export const LAND_OFFER = 25;

/**
 * The two mistakes cost the same, on purpose: answering something that did not
 * need answering, and failing to answer something that did.
 *
 * They also have to be this steep or the game has no game in it. Offers are a
 * quarter of what spawns, so standing still and touching nothing is worth
 * 0.25 x 25 + 0.75 x MISS per block. At -5 that is *positive* and doing
 * nothing beats playing; at -15 it is clearly negative, spraying at everything
 * comes out mildly positive, and actually choosing comes out far ahead. That
 * ordering is the whole design, and a test pins it.
 */
export const HIT_OFFER = -15;
export const MISS_TACTIC = -15;

// ── field geometry ──────────────────────────────────────────────────────────
//
// Normalised: x and y both run 0..1, y increasing downward. The renderer
// multiplies by whatever the canvas happens to be, so the same numbers are
// correct on a phone and on an iPad and nothing needs a second set of assets.

export const FIELD = Object.freeze({
  tankY: 0.9,
  tankHalfWidth: 0.05,
  tankSpeed: 1.6, // field-widths per second
  shotSpeed: 1.15, // field-heights per second
  fireIntervalMs: 260,
  blockHalfWidth: 0.08,
  blockHeight: 0.075,
});

const STEP_MS = 1000 / 60;
/** Simulation steps one `update` may run. Caps the catch-up after a
 *  backgrounded tab so a returning player gets a dropped frame, not a wall of
 *  blocks that fell while they were not looking. */
const MAX_STEPS_PER_UPDATE = 10;

/** mulberry32 — 32 bits of state, uniform enough for spawn choices and small
 *  enough to read. The point is reproducibility, not cryptography. */
function makeRng(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Difficulty as a 0..1 ramp across the round. A twelve-minute session and a
 *  one-minute drill therefore both start gentle and both finish hard, instead
 *  of the long one being twelve minutes of the easy part. */
function ramp(session) {
  if (session.durationMs <= 0) return 1;
  return Math.min(1, session.elapsedMs / session.durationMs);
}

function spawnIntervalMs(session) {
  return 1600 - 750 * ramp(session);
}

/**
 * A hard ceiling on what is on screen at once.
 *
 * Not a difficulty knob — a legibility one. Every block carries a text label
 * roughly a sixth of the field wide, and past about seven of them the field
 * stops being a game and becomes a wall of words nobody can read on a phone.
 * The first tuning pass peaked at eleven.
 */
export const MAX_BLOCKS = 7;

function fallSpeed(session, rng) {
  const base = 0.1 + 0.11 * ramp(session);
  return base * (0.85 + 0.3 * rng());
}

/**
 * A session: one round of the clock, optionally with a game attached.
 *
 * `mode` is 'timer' or 'arcade'. In timer mode nothing is simulated at all —
 * the clock is the entire feature, which is the mode a facilitator running a
 * live drill actually wants.
 */
export function createSession({
  durationMs = presetById(DEFAULT_PRESET).ms,
  mode = 'timer',
  seed = 1,
} = {}) {
  if (!Number.isFinite(durationMs) || durationMs <= 0) {
    throw new TypeError(`durationMs must be a positive number, got ${durationMs}`);
  }
  if (mode !== 'timer' && mode !== 'arcade') {
    throw new TypeError(`mode must be 'timer' or 'arcade', got ${mode}`);
  }

  const session = {
    durationMs,
    mode,
    state: 'idle', // idle | running | paused | done
    elapsedMs: 0,
    lastNow: null,

    // game
    rng: makeRng(seed),
    tankX: 0.5,
    targetX: 0.5,
    firing: false,
    shots: [],
    blocks: [],
    score: 0,
    /** Pressure tactics that got past you. Costs score, never the round. */
    missed: 0,
    sinceSpawnMs: 0,
    sinceFireMs: 0,
    stepDebtMs: 0,
    /** Transient events since the last update, for the renderer to flash. */
    events: [],
  };

  return session;
}

export function start(session, nowMs) {
  if (session.state === 'running') return session;
  session.state = 'running';
  session.lastNow = nowMs;
  return session;
}

export function pause(session) {
  if (session.state === 'running') session.state = 'paused';
  return session;
}

export function resume(session, nowMs) {
  if (session.state !== 'paused') return session;
  session.state = 'running';
  session.lastNow = nowMs;
  return session;
}

/** Back to idle with the clock full. Keeps `mode` and `durationMs`; everything
 *  else including the RNG stream is rebuilt, so a reset round is the same
 *  round. */
export function reset(session, { durationMs = session.durationMs, mode = session.mode, seed = 1 } = {}) {
  const fresh = createSession({ durationMs, mode, seed });
  Object.assign(session, fresh);
  return session;
}

export function remainingMs(session) {
  return Math.max(0, session.durationMs - session.elapsedMs);
}

/** Steer the tank. `x` is a field coordinate; the tank walks toward it at a
 *  finite speed rather than teleporting, which is what makes standing in the
 *  wrong place cost something. */
export function aimAt(session, x) {
  session.targetX = clamp(x, FIELD.tankHalfWidth, 1 - FIELD.tankHalfWidth);
  return session;
}

/**
 * Hold the trigger, or let it go.
 *
 * Pressing fires at once rather than after the cooldown: a gun that ignores
 * the first press for a quarter of a second reads as a dropped input, and the
 * player blames the game rather than their aim.
 */
export function setFiring(session, firing) {
  const next = Boolean(firing);
  if (next && !session.firing) session.sinceFireMs = FIELD.fireIntervalMs;
  session.firing = next;
  return session;
}

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

/**
 * Advance to `nowMs`.
 *
 * The clock advances by real elapsed time, uncapped: a practice timer that
 * loses a minute because the tab was backgrounded is a broken timer. The
 * simulation advances in fixed steps and is capped, because a game that
 * fast-forwards thirty seconds of falling blocks the moment you switch back is
 * a broken game. Those two rules disagree on purpose, and only in the case
 * where the player was not watching.
 */
export function update(session, nowMs) {
  if (session.state !== 'running') return session;

  const deltaMs = Math.max(0, nowMs - (session.lastNow ?? nowMs));
  session.lastNow = nowMs;
  session.events = [];

  const room = Math.max(0, session.durationMs - session.elapsedMs);
  const clockMs = Math.min(deltaMs, room);
  session.elapsedMs += clockMs;

  if (session.mode === 'arcade') {
    session.stepDebtMs = Math.min(
      session.stepDebtMs + clockMs,
      STEP_MS * MAX_STEPS_PER_UPDATE,
    );
    while (session.stepDebtMs >= STEP_MS) {
      session.stepDebtMs -= STEP_MS;
      step(session, STEP_MS);
    }
  }

  // The clock is the only thing that can end a round. There is deliberately no
  // lose condition: a facilitator running a twelve-minute drill cannot have the
  // arcade decide the drill is over at 0:47, which is exactly what three lives
  // did the first time this was played.
  if (remainingMs(session) === 0) {
    session.state = 'done';
    session.shots = [];
  }

  return session;
}

function step(session, dtMs) {
  const dt = dtMs / 1000;

  // tank
  const wanted = session.targetX - session.tankX;
  const travel = FIELD.tankSpeed * dt;
  session.tankX += Math.abs(wanted) <= travel ? wanted : Math.sign(wanted) * travel;

  // fire
  if (session.firing) {
    session.sinceFireMs += dtMs;
    if (session.sinceFireMs >= FIELD.fireIntervalMs) {
      session.sinceFireMs -= FIELD.fireIntervalMs;
      session.shots.push({ x: session.tankX, y: FIELD.tankY - 0.02 });
    }
  }

  // spawn
  session.sinceSpawnMs += dtMs;
  if (session.sinceSpawnMs >= spawnIntervalMs(session)) {
    session.sinceSpawnMs = 0;
    if (session.blocks.length < MAX_BLOCKS) spawn(session);
  }

  // shots rise
  for (const shot of session.shots) shot.y -= FIELD.shotSpeed * dt;
  session.shots = session.shots.filter((s) => s.y > -0.05);

  // blocks fall
  for (const block of session.blocks) block.y += block.speed * dt;

  resolveHits(session);
  resolveLandings(session);
}

function spawn(session) {
  const isOffer = session.rng() < 0.25;
  const pool = isOffer ? OFFERS : TACTICS;
  const label = pool[Math.floor(session.rng() * pool.length) % pool.length];
  const x = clamp(
    FIELD.blockHalfWidth + session.rng() * (1 - 2 * FIELD.blockHalfWidth),
    FIELD.blockHalfWidth,
    1 - FIELD.blockHalfWidth,
  );
  session.blocks.push({
    x,
    y: -FIELD.blockHeight,
    kind: isOffer ? 'offer' : 'tactic',
    label,
    speed: fallSpeed(session, session.rng),
  });
}

function resolveHits(session) {
  const survivingShots = [];
  outer: for (const shot of session.shots) {
    for (let i = 0; i < session.blocks.length; i++) {
      const block = session.blocks[i];
      const inX = Math.abs(shot.x - block.x) <= FIELD.blockHalfWidth;
      const inY = shot.y >= block.y && shot.y <= block.y + FIELD.blockHeight;
      if (!inX || !inY) continue;

      session.blocks.splice(i, 1);
      if (block.kind === 'tactic') {
        session.score += HIT_TACTIC;
        session.events.push({ type: 'hitTactic', x: block.x, y: block.y, points: HIT_TACTIC });
      } else {
        session.score += HIT_OFFER;
        session.events.push({ type: 'hitOffer', x: block.x, y: block.y, points: HIT_OFFER });
      }
      continue outer; // one shot, one block
    }
    survivingShots.push(shot);
  }
  session.shots = survivingShots;
}

function resolveLandings(session) {
  const stillFalling = [];
  for (const block of session.blocks) {
    if (block.y <= 1) {
      stillFalling.push(block);
      continue;
    }
    if (block.kind === 'offer') {
      session.score += LAND_OFFER;
      session.events.push({ type: 'landedOffer', x: block.x, points: LAND_OFFER });
    } else {
      session.score += MISS_TACTIC;
      session.missed += 1;
      session.events.push({ type: 'landedTactic', x: block.x, points: MISS_TACTIC });
    }
  }
  session.blocks = stillFalling;
}

// ── display ─────────────────────────────────────────────────────────────────

/** "3:00", "0:07". Minutes are not zero-padded; seconds always are. */
export function formatClock(ms) {
  const total = Math.ceil(Math.max(0, ms) / 1000);
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

/**
 * A read-only view for the renderer, so drawing code never reaches into the
 * session and mutates it by accident.
 */
export function snapshot(session) {
  return {
    state: session.state,
    mode: session.mode,
    remainingMs: remainingMs(session),
    fractionLeft: session.durationMs ? remainingMs(session) / session.durationMs : 0,
    score: session.score,
    missed: session.missed,
    tankX: session.tankX,
    firing: session.firing,
    shots: session.shots.map((s) => ({ x: s.x, y: s.y })),
    blocks: session.blocks.map((b) => ({ x: b.x, y: b.y, kind: b.kind, label: b.label })),
    events: session.events.slice(),
  };
}
