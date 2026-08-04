/**
 * Replays and mid-match saves, in one mechanism.
 *
 * The engine is deterministic: same seed, same loadout, same command stream,
 * same world. That property has been enforced since the first commit, and this
 * file is where it pays rent. A recording is nothing but the match
 * configuration plus the *player's* commands, keyed by the tick they were
 * applied on — a few kilobytes for a long match. Rebuilding is re-simulation:
 * feed the same commands back in at the same ticks and the identical world
 * falls out, byte for byte.
 *
 * Two things follow from that, and both are features:
 *
 * - A replay and a mid-mission save are the same file. "Watch the match back"
 *   replays it at viewing speed; "resume where I left off" replays it with the
 *   renderer off and keeps going. There is no separate snapshot format to
 *   design, version, or corrupt.
 *
 * - AI commands are not recorded. The AI reads only the world and its own
 *   per-player state, both of which are rebuilt by the replay itself, so it
 *   re-derives its every decision on the way through. Recording it would only
 *   add a way for the file to disagree with the simulation.
 *
 * The one rule callers must honour: drive the replay loop *exactly* the way
 * the live loop was driven — player commands first, then AI, one tick at a
 * time. `advanceTick` exists so live play, resume and playback all share that
 * definition rather than each repeating it.
 */

import { createWorld, tick } from './sim.js';
import { updateAI } from './ai.js';

/** Bumped when the format changes shape. Old saves are dropped, not migrated. */
export const REPLAY_VERSION = 1;

/* ------------------------------------------------------------- recording -- */

/**
 * Begin recording a match.
 *
 * `config` is whatever is about to be passed to `createWorld`. It is cloned
 * through JSON immediately, for two reasons: the recorder must not keep a live
 * reference into a world that is about to start mutating, and a config that
 * cannot survive JSON cannot be saved — better to find that out at record time
 * than at load time, with a test pinning it.
 */
export function createRecorder(config) {
  return {
    config: JSON.parse(JSON.stringify(config)),
    /** Sparse: only ticks on which the player actually did something. */
    log: [],
  };
}

/**
 * Record the player commands applied on `tickIndex` (the world's tick value
 * *before* `tick()` ran). Ticks with no commands cost nothing.
 */
export function record(recorder, tickIndex, commands) {
  if (!recorder || commands.length === 0) return;
  recorder.log.push({ t: tickIndex, c: JSON.parse(JSON.stringify(commands)) });
}

/* --------------------------------------------------------------- driving -- */

/**
 * Advance a world one tick the way the live loop does: the given player
 * commands, then every undefeated AI, then the simulation. This is the single
 * definition of a "turn" that live play, resume and playback all share.
 */
export function advanceTick(world, playerCommands) {
  const commands = playerCommands ? [...playerCommands] : [];
  for (const player of world.players) {
    if (player.isAI && !player.defeated) commands.push(...updateAI(world, player));
  }
  tick(world, commands);
}

/** The player commands a recording holds for one tick, or null. */
export function commandsAt(save, tickIndex) {
  // The log is sparse and ordered; a cursor object would be faster but this is
  // called 20 times a second on arrays of a few hundred entries. Not worth it.
  for (const entry of save.log) {
    if (entry.t === tickIndex) return entry.c;
    if (entry.t > tickIndex) return null;
  }
  return null;
}

/**
 * Rebuild a world from a recording, stopping at `upToTick` (defaults to the
 * whole log's extent — wherever the save was written). Returns the world,
 * ready either to keep simulating (resume) or to be watched (replay).
 */
export function rebuildWorld(save, upToTick = save.ticks) {
  const world = createWorld(save.config);
  while (world.tick < upToTick && !world.over) {
    advanceTick(world, commandsAt(save, world.tick));
  }
  return world;
}

/* ----------------------------------------------------------- persistence -- */

/** Freeze a recording into a JSON string, stamped with where the match is. */
export function serializeMatch(recorder, atTick) {
  return JSON.stringify({
    version: REPLAY_VERSION,
    ticks: atTick,
    config: recorder.config,
    log: recorder.log,
  });
}

/**
 * Parse a saved match, defensively. Anything malformed — wrong version, wrong
 * shapes, truncated JSON, a hand-edited log — returns null rather than
 * throwing, for the same reason profile deserialisation does: a bad save file
 * must cost the save, never the page.
 */
export function deserializeMatch(raw) {
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!data || typeof data !== 'object') return null;
  if (data.version !== REPLAY_VERSION) return null;
  if (!Number.isInteger(data.ticks) || data.ticks < 0) return null;
  if (!data.config || typeof data.config !== 'object') return null;
  if (!Array.isArray(data.config.players) || data.config.players.length < 2) return null;
  if (!Array.isArray(data.log)) return null;

  for (const entry of data.log) {
    if (!entry || !Number.isInteger(entry.t) || entry.t < 0) return null;
    if (!Array.isArray(entry.c)) return null;
    // Command *contents* are not validated here — applyCommand already treats
    // every command as untrusted and ignores what it cannot honour, and that
    // is covered by the robustness suite. Structure is this file's job;
    // meaning is the simulation's.
  }

  // The log must be ordered for commandsAt's early-out to be correct, and a
  // hand-edited file is exactly the case this parser exists for.
  for (let i = 1; i < data.log.length; i++) {
    if (data.log[i].t <= data.log[i - 1].t) return null;
  }

  return data;
}
