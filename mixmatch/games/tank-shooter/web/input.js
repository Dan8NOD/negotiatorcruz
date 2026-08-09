/**
 * NOD Tank Shooter — input.
 *
 * Turns whatever the device offers into the one shape the simulation accepts:
 * `{ moveX, moveY, aim, fire, boost }`. Nothing downstream knows or cares
 * whether that came from a keyboard, a mouse, or two thumbs.
 *
 * That boundary is not tidiness. It is why `sim.test.js` can play the game
 * with a scripted bot, and it is why adding a gamepad later is a file with no
 * consequences.
 *
 * ## Touch
 *
 * Two virtual sticks, and the right one fires while it is held — a separate
 * fire button on a phone means either aiming or shooting, never both. The
 * sticks are *floating*: each appears wherever the thumb lands on its half of
 * the screen rather than at a fixed spot, because a fixed stick on a phone is
 * a stick you have to look at.
 */

export function createInput(canvas, renderer) {
  const keys = new Set();
  const state = { moveX: 0, moveY: 0, aim: 0, fire: false, boost: false };

  /** Where the mouse last was, in screen space. */
  let pointer = { x: 0, y: 0, down: false };

  /** Active touch sticks, keyed by pointerId. */
  const sticks = new Map();
  let touchUsed = false;

  const KEY_VECTORS = {
    KeyW: [0, -1],
    ArrowUp: [0, -1],
    KeyS: [0, 1],
    ArrowDown: [0, 1],
    KeyA: [-1, 0],
    ArrowLeft: [-1, 0],
    KeyD: [1, 0],
    ArrowRight: [1, 0],
  };

  /* --------------------------------------------------------------- keyboard */

  function onKeyDown(e) {
    // Space and the arrows scroll the page. A game that scrolls the page when
    // you dodge is a game nobody finishes the first round of.
    if (KEY_VECTORS[e.code] || e.code === 'Space') e.preventDefault();
    keys.add(e.code);
  }
  function onKeyUp(e) {
    keys.delete(e.code);
  }

  /* ----------------------------------------------------------------- mouse */

  function onPointerMove(e) {
    if (e.pointerType === 'touch') return;
    const rect = canvas.getBoundingClientRect();
    pointer.x = e.clientX - rect.left;
    pointer.y = e.clientY - rect.top;
  }

  function onPointerDown(e) {
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    if (e.pointerType === 'touch') {
      touchUsed = true;
      sticks.set(e.pointerId, { originX: x, originY: y, x, y, left: x < rect.width / 2 });
      // Before the capture, not after. `setPointerCapture` throws if the
      // pointer is already gone — a fast tap, a pointer iOS cancelled out from
      // under us — and an exception here used to skip the preventDefault,
      // which is the call that stops the page scrolling under the player. The
      // capture is an optimisation; not scrolling is the requirement.
      e.preventDefault();
      try {
        canvas.setPointerCapture(e.pointerId);
      } catch {
        // Nothing to do: the stick still tracks through the window listeners.
      }
      return;
    }
    pointer.down = true;
    pointer.x = x;
    pointer.y = y;
  }

  function onTouchMove(e) {
    const stick = sticks.get(e.pointerId);
    if (!stick) return;
    const rect = canvas.getBoundingClientRect();
    stick.x = e.clientX - rect.left;
    stick.y = e.clientY - rect.top;
    e.preventDefault();
  }

  function onPointerUp(e) {
    if (sticks.delete(e.pointerId)) return;
    pointer.down = false;
  }

  /* ------------------------------------------------------------------ read */

  /**
   * The input for this tick.
   *
   * Called once per simulation step, so it must be cheap and must not mutate
   * anything a second call would see differently.
   */
  function read(world) {
    // Once a thumb has landed this is a touch device and it stays one, even
    // between touches. Switching back to the desktop reader whenever both
    // thumbs lift would aim at `pointer`, which on a phone no mouse has ever
    // moved is still {0, 0} — so the turret whips to the top-left corner of
    // the arena every time the player stops steering, which is constantly.
    if (touchUsed) return readTouch(world);
    return readDesktop(world);
  }

  function readDesktop(world) {
    let mx = 0;
    let my = 0;
    for (const code of keys) {
      const v = KEY_VECTORS[code];
      if (v) {
        mx += v[0];
        my += v[1];
      }
    }

    const world_ = renderer.screenToWorld(pointer.x, pointer.y);
    state.moveX = mx;
    state.moveY = my;
    state.aim = Math.atan2(world_.y - world.tank.y, world_.x - world.tank.x);
    state.fire = pointer.down || keys.has('Space');
    state.boost = keys.has('ShiftLeft') || keys.has('ShiftRight');
    return state;
  }

  const DEAD_ZONE = 14;
  const FULL_THROW = 62;

  function readTouch(world) {
    // With no thumbs down this returns "stopped, not shooting, still facing
    // where you left it" — `state.aim` is deliberately not cleared. A tank that
    // holds its facing between touches is one the player can let go of to look
    // at the screen; one that recentres is one that has to be re-aimed after
    // every dodge.
    state.moveX = 0;
    state.moveY = 0;
    state.fire = false;
    state.boost = false;

    for (const stick of sticks.values()) {
      const dx = stick.x - stick.originX;
      const dy = stick.y - stick.originY;
      const mag = Math.sqrt(dx * dx + dy * dy);
      if (mag < DEAD_ZONE) {
        // The right stick still fires when barely moved — a thumb resting on
        // the fire side is a player asking to shoot at whatever they last
        // aimed at, and refusing that reads as the button not working.
        if (!stick.left) state.fire = true;
        continue;
      }
      const angle = Math.atan2(dy, dx);

      if (stick.left) {
        const throw_ = Math.min(1, (mag - DEAD_ZONE) / (FULL_THROW - DEAD_ZONE));
        state.moveX = Math.cos(angle) * throw_;
        state.moveY = Math.sin(angle) * throw_;
        // Push the left stick past full throw to boost. No third thumb needed,
        // and "shove harder to go faster" is the gesture people already try.
        state.boost = mag > FULL_THROW * 1.9;
      } else {
        state.aim = angle;
        state.fire = true;
      }
    }
    return state;
  }

  /** Whether to draw the touch overlay. Set by the first touch, never unset. */
  function usingTouch() {
    return touchUsed;
  }

  /** Live stick positions, for the renderer to draw. */
  function stickState() {
    return [...sticks.values()];
  }

  function attach() {
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    // Losing focus mid-key leaves the tank driving into a wall forever.
    window.addEventListener('blur', () => keys.clear());
    canvas.addEventListener('pointermove', onPointerMove);
    canvas.addEventListener('pointermove', onTouchMove);
    canvas.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('pointerup', onPointerUp);
    window.addEventListener('pointercancel', onPointerUp);
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  function detach() {
    window.removeEventListener('keydown', onKeyDown);
    window.removeEventListener('keyup', onKeyUp);
    keys.clear();
    sticks.clear();
  }

  return { attach, detach, read, usingTouch, stickState };
}
