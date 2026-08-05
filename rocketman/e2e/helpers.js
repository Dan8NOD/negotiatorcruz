/**
 * Shared browser-test scaffolding.
 *
 * Anything two specs both need to *do* to the game — as opposed to assert
 * about it — belongs here, so a change to how the game is played is one edit
 * rather than a hunt for the copies.
 */

import { expect } from '@playwright/test';

export const PAGE = '/rocketman/web/rocketman.html';

/**
 * How long a match may take to boot before the test gives up.
 *
 * Playwright's default here is the whole test timeout, which meant a game
 * that failed to start cost four minutes to find out — and when a startup
 * bug hits every campaign spec at once, that is 22 tests × 240s × a retry:
 * the browser job took **1.4 hours** to report a fault that reproduces in
 * under two seconds.
 *
 * A boot that has not happened in fifteen seconds has not happened. Failing
 * fast is worth more than the tiny chance a loaded runner needs longer,
 * because the thing being waited for is `window.__rocketman` existing at
 * all — and when startup throws, no amount of waiting will conjure it.
 */
export const BOOT = { timeout: 15000 };

/** World cell size in pixels, from engine/content.js. */
const CELL = 24;

/**
 * March the crew across the map until the mission resolves.
 *
 * Two hard-won properties, both learned by watching this fail.
 *
 * The loop is bounded by wall-clock rather than a round count, because at ×4
 * the simulation advances as fast as the machine renders — a fixed round
 * count passes on a fast laptop and starves on a loaded CI runner.
 *
 * And every round re-acquires the crew and re-aims. The one-shot version
 * secretly rode on its first order: whether the crew clipped the listening
 * posts' engagement range on the way past was a coin flip decided by which
 * tick the click landed on.
 *
 * The aim is computed from the camera rather than being a fixed screen pixel.
 * A fixed pixel encodes a *direction* — and because the viewport is wider
 * than it is tall, the fixed point this loop used for months was a 2:1
 * x-biased vector at a target sitting on the 1:1 diagonal. On a small map the
 * crew blundered into the objective before the drift mattered. On a doubled
 * map they walk to the right-hand edge and inch down it, and the mission
 * never ends. Aiming at where the enemy actually is makes the loop
 * independent of both the map size and the window shape.
 */
export async function marchToVictory(page, { budgetMs = 150000 } = {}) {
  // Campaign missions start in the cockpit, where `a` steers the pilot rather
  // than issuing an attack-move. C hands control back to the RTS scheme.
  await page.keyboard.press('c');
  await page.keyboard.press('+');
  await page.keyboard.press('+');

  const viewport = page.viewportSize() || { width: 1280, height: 720 };
  const deadline = Date.now() + budgetMs;

  while (Date.now() < deadline) {
    // Tab selects an army unit and centres the camera on it, so the box
    // select below always has the crew on screen.
    await page.keyboard.press('Tab');
    await page.mouse.move(200, 150);
    await page.mouse.down();
    await page.mouse.move(viewport.width - 60, viewport.height - 80, { steps: 6 });
    await page.mouse.up();

    const aim = await enemyCornerOnScreen(page, viewport);
    await page.mouse.move(aim.x, aim.y);
    // Attack-move, not move: a plain move walks politely past a listening
    // post it was sent to within a leash-length of.
    await page.keyboard.press('a');
    await page.waitForTimeout(2500);

    const state = await page.evaluate(() => (window.__rocketman ? window.__rocketman() : null));
    if (!state || state.over) return true;
  }
  return false;
}

/**
 * Where the enemy corner is on screen right now, clamped into the viewport
 * along the line to it so the direction survives the clamp.
 *
 * Uses the renderer's own transform — `(world - camera) * CELL * zoom` — read
 * off the inspection hook, so it stays correct at any zoom or map size.
 */
async function enemyCornerOnScreen(page, viewport) {
  const { camera, map } = await page.evaluate(() => {
    const s = window.__rocketman();
    return { camera: s.camera, map: s.map };
  });

  // The starts are inset from opposing corners; the enemy is the far one.
  const inset = Math.round(Math.min(map.width, map.height) * 0.16);
  const scale = CELL * camera.zoom;
  const target = {
    x: (map.width - 1 - inset - camera.x) * scale,
    y: (map.height - 1 - inset - camera.y) * scale,
  };

  // Clamp along the ray from the screen centre, so a target off-screen still
  // produces an order pointing straight at it.
  const cx = viewport.width / 2;
  const cy = viewport.height / 2;
  const dx = target.x - cx;
  const dy = target.y - cy;
  const margin = 60;
  const limit = Math.min(
    dx === 0 ? Infinity : (viewport.width / 2 - margin) / Math.abs(dx),
    dy === 0 ? Infinity : (viewport.height / 2 - margin) / Math.abs(dy),
    1
  );
  return { x: cx + dx * limit, y: cy + dy * limit };
}

/** Fail loudly rather than falling through to a confusing assertion later. */
export async function expectMissionComplete(page, won) {
  expect(won, 'the crew never finished the mission inside the budget').toBe(true);
  await expect(page.locator('#debrief h2')).toContainText('Mission complete', { timeout: 20000 });
}
