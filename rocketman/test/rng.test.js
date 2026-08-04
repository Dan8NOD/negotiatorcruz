/**
 * The deterministic RNG.
 *
 * Small file, load-bearing property: everything the simulation promises about
 * replays rests on this being reproducible and restorable.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { createRng } from '../engine/rng.js';

describe('createRng', () => {
  test('the same seed produces the same stream', () => {
    const a = createRng(12345);
    const b = createRng(12345);
    const drawA = Array.from({ length: 200 }, () => a.next());
    const drawB = Array.from({ length: 200 }, () => b.next());
    assert.deepEqual(drawA, drawB);
  });

  test('different seeds diverge', () => {
    const a = createRng(1);
    const b = createRng(2);
    assert.notDeepEqual(
      Array.from({ length: 50 }, () => a.next()),
      Array.from({ length: 50 }, () => b.next())
    );
  });

  test('values stay in [0, 1)', () => {
    const rng = createRng(7);
    for (let i = 0; i < 5000; i++) {
      const v = rng.next();
      assert.ok(v >= 0 && v < 1, `out of range: ${v}`);
    }
  });

  test('int stays inside its bound', () => {
    const rng = createRng(9);
    for (let i = 0; i < 5000; i++) {
      const v = rng.int(10);
      assert.ok(Number.isInteger(v) && v >= 0 && v < 10, `out of range: ${v}`);
    }
  });

  test('range respects its bounds', () => {
    const rng = createRng(11);
    for (let i = 0; i < 2000; i++) {
      const v = rng.range(-3, 5);
      assert.ok(v >= -3 && v < 5, `out of range: ${v}`);
    }
  });

  test('pick returns an element, and undefined for an empty array', () => {
    const rng = createRng(13);
    const options = ['a', 'b', 'c'];
    for (let i = 0; i < 100; i++) assert.ok(options.includes(rng.pick(options)));
    assert.equal(rng.pick([]), undefined);
  });

  test('chance honours its probability', () => {
    const rng = createRng(17);
    let hits = 0;
    const trials = 20000;
    for (let i = 0; i < trials; i++) if (rng.chance(0.25)) hits++;
    const rate = hits / trials;
    assert.ok(Math.abs(rate - 0.25) < 0.02, `expected ~25%, got ${(rate * 100).toFixed(1)}%`);
    assert.equal(rng.chance(0), false, 'chance(0) must never fire');
    assert.equal(rng.chance(1), true, 'chance(1) must always fire');
  });

  test('state can be captured and restored', () => {
    const rng = createRng(19);
    for (let i = 0; i < 37; i++) rng.next();

    const snapshot = rng.state();
    const expected = Array.from({ length: 20 }, () => rng.next());

    rng.restore(snapshot);
    assert.deepEqual(
      Array.from({ length: 20 }, () => rng.next()),
      expected
    );
  });

  test('a restored generator matches a fresh one seeded the same way', () => {
    const a = createRng(23);
    const b = createRng(999);
    b.restore(a.state());
    assert.equal(a.next(), b.next());
  });

  test('does not immediately repeat itself', () => {
    const rng = createRng(29);
    const seen = new Set();
    for (let i = 0; i < 10000; i++) seen.add(rng.next());
    assert.ok(seen.size > 9900, `only ${seen.size} distinct values in 10000 draws`);
  });
});
