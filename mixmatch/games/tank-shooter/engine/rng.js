/**
 * Deterministic pseudo-random numbers.
 *
 * Every random decision in the simulation goes through one of these. Nothing
 * in engine/ is allowed to call Math.random(), because a run has to be
 * reproducible from its seed alone. The renderer may use Math.random() freely
 * for cosmetic sparks; those never feed back into state.
 *
 * In an arcade that charges a token a play, determinism is not a nicety. A
 * disputed run — "it spawned three wardens at once and ate my token" — is
 * answerable if the seed reproduces the run exactly, and is otherwise one
 * person's word against a leaderboard. It is also the only way a score can be
 * checked server-side later without trusting the client's arithmetic.
 *
 * mulberry32: 32-bit state, four lines of integer math. Lifted verbatim from
 * `rocketman/engine/rng.js` rather than imported, because these are two
 * separate games that happen to agree, and a shared module would make a change
 * to one of them a change to both.
 */

/**
 * @param {number} seed 32-bit unsigned seed.
 */
export function createRng(seed) {
  let s = seed >>> 0;

  /** Uniform float in [0, 1). */
  function next() {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  return {
    next,
    /** Integer in [0, n). */
    int(n) {
      return Math.floor(next() * n);
    },
    /** Float in [lo, hi). */
    range(lo, hi) {
      return lo + next() * (hi - lo);
    },
    /** True with probability p. */
    chance(p) {
      return next() < p;
    },
    /** Uniform element, or undefined for an empty array. */
    pick(arr) {
      return arr.length === 0 ? undefined : arr[Math.floor(next() * arr.length)];
    },
    /** Serialisable state, for savegames and replay checkpoints. */
    state() {
      return s >>> 0;
    },
    restore(value) {
      s = value >>> 0;
    },
  };
}
