/**
 * Input, driven without a browser.
 *
 * `createInput` is the one file in the game that a phone exercises differently
 * from a desktop, and it was the one file with no tests — the twenty-seed bot
 * in `sim.test.js` feeds the simulation plain objects and never goes near this.
 * That gap is exactly where the aim-snap below lived.
 *
 * The shims here are the smallest thing that satisfies `attach()`: something to
 * register listeners on, and a rect to measure pointers against. `read()` is
 * pure once the handlers have run, so the assertions are about state rather
 * than about the DOM.
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { createInput } from '../web/input.js';

/* =================================================================== shims */

const RECT = { left: 0, top: 0, width: 800, height: 600 };

/** A node that records its listeners so a test can fire them by name. */
function fakeNode() {
  const listeners = new Map();
  return {
    listeners,
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(fn);
    },
    removeEventListener(type, fn) {
      const fns = listeners.get(type);
      if (fns) listeners.set(type, fns.filter((f) => f !== fn));
    },
    emit(type, event) {
      for (const fn of listeners.get(type) ?? []) fn(event);
    },
  };
}

function fakeCanvas() {
  const node = fakeNode();
  node.getBoundingClientRect = () => RECT;
  node.setPointerCapture = () => {};
  return node;
}

/**
 * A renderer stand-in whose world space is screen space, so an assertion about
 * aim can be written in the coordinates the test already used for the pointer.
 */
function fakeRenderer() {
  return { screenToWorld: (x, y) => ({ x, y }) };
}

/** The tank sits mid-arena; every angle below is measured from here. */
function world() {
  return { tank: { x: 400, y: 300 } };
}

function touch(id, x, y) {
  return { pointerId: id, pointerType: 'touch', clientX: x, clientY: y, preventDefault() {} };
}

/**
 * Lift a thumb.
 *
 * `pointerup` and `pointercancel` are bound to the window rather than to the
 * canvas — deliberately, so that a thumb dragged off the edge of the glass
 * still ends its stick. Routing these through the canvas would leave the stick
 * held and quietly pass tests that meant to assert the opposite.
 */
function lift(id, x, y) {
  globalThis.window.emit('pointerup', touch(id, x, y));
}

let canvas;
let input;
let originalWindow;

beforeEach(() => {
  originalWindow = globalThis.window;
  globalThis.window = fakeNode();
  canvas = fakeCanvas();
  input = createInput(canvas, fakeRenderer());
  input.attach();
});

afterEach(() => {
  globalThis.window = originalWindow;
});

/* =================================================================== tests */

describe('touch sticks', () => {
  test('the left stick drives and the right stick aims and fires', () => {
    // Left thumb pushed straight up, right thumb pushed straight right.
    canvas.emit('pointerdown', touch(1, 100, 300));
    canvas.emit('pointermove', touch(1, 100, 200));
    canvas.emit('pointerdown', touch(2, 600, 300));
    canvas.emit('pointermove', touch(2, 700, 300));

    const state = input.read(world());
    assert.ok(state.moveY < -0.9, `expected full throw up, got ${state.moveY}`);
    assert.ok(Math.abs(state.moveX) < 0.001);
    assert.equal(Math.round(state.aim * 100) / 100, 0);
    assert.equal(state.fire, true);
  });

  test('a thumb resting on the right half fires without aiming', () => {
    canvas.emit('pointerdown', touch(1, 600, 300));
    assert.equal(input.read(world()).fire, true);
  });

  test('shoving the left stick past full throw boosts', () => {
    canvas.emit('pointerdown', touch(1, 200, 300));
    canvas.emit('pointermove', touch(1, 200, 140));
    assert.equal(input.read(world()).boost, true);
  });
});

describe('lifting both thumbs', () => {
  /**
   * The bug this file was written for.
   *
   * `read()` used to switch back to the desktop reader whenever no stick was
   * down, and the desktop reader aims at the last mouse position — which on a
   * phone is the {0, 0} it was initialised with. So every time the player let
   * go to reposition, the turret snapped to the top-left of the arena. It is
   * invisible on a desktop and constant on an iPhone.
   */
  test('holds its facing instead of snapping to the top-left corner', () => {
    // Aim right, then let go of everything.
    canvas.emit('pointerdown', touch(2, 600, 300));
    canvas.emit('pointermove', touch(2, 700, 300));
    const aimed = input.read(world()).aim;
    lift(2, 700, 300);

    const after = input.read(world());
    assert.equal(after.aim, aimed, 'aim moved after the thumbs came off the glass');

    // The corner the old code snapped to, so a regression fails loudly rather
    // than merely differing.
    const toTopLeft = Math.atan2(0 - 300, 0 - 400);
    assert.notEqual(Math.round(after.aim * 100), Math.round(toTopLeft * 100));
  });

  test('stops driving, boosting and firing', () => {
    canvas.emit('pointerdown', touch(1, 100, 300));
    canvas.emit('pointermove', touch(1, 100, 140));
    canvas.emit('pointerdown', touch(2, 600, 300));
    assert.equal(input.read(world()).fire, true);

    lift(1, 100, 140);
    lift(2, 600, 300);

    const idle = input.read(world());
    assert.equal(idle.moveX, 0);
    assert.equal(idle.moveY, 0);
    assert.equal(idle.fire, false);
    assert.equal(idle.boost, false);
  });

  test('a cancelled pointer releases its stick', () => {
    // iOS cancels pointers for its own reasons — a call, the app switcher, a
    // palm. A stick left behind by one is a tank driving into a wall forever.
    canvas.emit('pointerdown', touch(1, 100, 300));
    canvas.emit('pointermove', touch(1, 100, 200));
    globalThis.window.emit('pointercancel', touch(1, 100, 200));

    assert.equal(input.read(world()).moveY, 0);
  });
});

describe('desktop', () => {
  test('aims at the mouse until a thumb has ever touched the screen', () => {
    canvas.emit('pointermove', { pointerType: 'mouse', clientX: 400, clientY: 100, preventDefault() {} });
    const state = input.read(world());
    // Straight up from the tank is -pi/2.
    assert.equal(Math.round(state.aim * 100), Math.round((-Math.PI / 2) * 100));
    assert.equal(state.fire, false);
  });

  test('a mouse move after a touch does not take the aim back', () => {
    // A phone that reports a stray mouse event, or a laptop with a touchscreen
    // mid-round, must not hand aiming back to a pointer nobody is using.
    canvas.emit('pointerdown', touch(1, 600, 300));
    canvas.emit('pointermove', touch(1, 700, 300));
    const aimed = input.read(world()).aim;

    canvas.emit('pointermove', { pointerType: 'mouse', clientX: 400, clientY: 100, preventDefault() {} });
    assert.equal(input.read(world()).aim, aimed);
  });
});
