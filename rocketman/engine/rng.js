/**
 * Deterministic pseudo-random numbers.
 *
 * Every random decision in the simulation goes through one of these. Nothing
 * in engine/ is allowed to call Math.random(), because two machines running
 * the same seed and the same command stream must produce identical worlds —
 * that is what makes replays, desync detection and (later) lockstep
 * multiplayer possible at all. The renderer may use Math.random() freely for
 * cosmetic sparks; those never feed back into state.
 *
 * mulberry32: 32-bit state, and — the reason it is here rather than something
 * fancier — four lines of integer math that port to Swift without an argument
 * about float rounding.
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
