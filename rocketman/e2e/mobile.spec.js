/**
 * The game on a phone.
 *
 * Rocketman is going to iOS, and none of its original input exists there:
 * drag-select, right-click and hotkeys are all mouse-and-keyboard. These
 * assertions cover the second control scheme and the layout that makes room
 * for it — the battlefield filling the screen, and the panels floating over
 * it rather than taking a third of it.
 */

import { test, expect } from '@playwright/test';

const PAGE = '/rocketman/web/rocketman.html';

// iPhone-class landscape. Landscape because that is how a strategy game is
// held, and because portrait on a phone leaves no horizontal battlefield.
//
// Set explicitly rather than spreading a `devices` preset: those carry
// `defaultBrowserType: 'webkit'`, which fights the chromium project this
// suite runs under and fails the launch outright.
test.use({
  viewport: { width: 852, height: 393 },
  deviceScaleFactor: 3,
  isMobile: true,
  hasTouch: true,
});

function watchErrors(page) {
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  return errors;
}

async function startMission(page) {
  await page.goto(PAGE);
  await page.evaluate(() => window.localStorage.clear());
  await page.reload();
  await page.tap('#playCampaign');
  await page.locator('.mission').first().tap();
  await page.tap('#deployMission');
  await page.waitForFunction(() => typeof window.__rocketman === 'function');
}

const state = (page) => page.evaluate(() => window.__rocketman());

/**
 * A real touch drag on the canvas.
 *
 * `page.mouse` dispatches `pointerType: 'mouse'`, which the touch layer
 * deliberately ignores — driving it with the mouse would silently exercise
 * the desktop box-select path and prove nothing about touch. Playwright's
 * touchscreen API only offers `tap`, so the drag is dispatched directly.
 */
async function touchDrag(page, from, to, steps = 8) {
  await page.evaluate(
    async ({ from, to, steps }) => {
      const el = document.getElementById('view');
      const rect = el.getBoundingClientRect();
      const fire = (type, x, y) =>
        el.dispatchEvent(
          new PointerEvent(type, {
            pointerId: 1,
            pointerType: 'touch',
            isPrimary: true,
            clientX: rect.left + x,
            clientY: rect.top + y,
            bubbles: true,
            cancelable: true,
          })
        );
      fire('pointerdown', from.x, from.y);
      for (let i = 1; i <= steps; i++) {
        const t = i / steps;
        fire('pointermove', from.x + (to.x - from.x) * t, from.y + (to.y - from.y) * t);
        await new Promise((r) => setTimeout(r, 16));
      }
      fire('pointerup', to.x, to.y);
    },
    { from, to, steps }
  );
}

test('the battlefield fills the screen', async ({ page }) => {
  const errors = watchErrors(page);
  await startMission(page);

  // The canvas is the viewport, not a row in a grid with the HUD below it.
  const canvas = await page.locator('#view').boundingBox();
  const vp = page.viewportSize();
  expect(canvas.width).toBeGreaterThanOrEqual(vp.width - 1);
  expect(canvas.height).toBeGreaterThanOrEqual(vp.height - 1);

  // And the panels float on top rather than displacing it.
  for (const id of ['#topbar', '#roster', '#minimapWrap']) {
    const box = await page.locator(id).boundingBox();
    expect(box.y).toBeLessThan(vp.height);
    expect(box.height).toBeLessThan(vp.height * 0.34);
  }

  expect(errors).toEqual([]);
});

test('touch controls appear, and only on touch', async ({ page }) => {
  const errors = watchErrors(page);
  await startMission(page);

  // A campaign mission starts in the cockpit, so the stick is live.
  await expect(page.locator('#stick')).toBeVisible();
  await expect(page.locator('#touchActions')).toBeVisible();
  await expect(page.locator('#btnSkyfall')).toContainText('Skyfall');

  // Thumb-sized: Apple's guidance is 44pt, and these are the controls a
  // player uses under pressure.
  for (const id of ['#btnAbility', '#btnSkyfall', '#btnAttack']) {
    const box = await page.locator(id).boundingBox();
    expect(box.width).toBeGreaterThanOrEqual(44);
    expect(box.height).toBeGreaterThanOrEqual(44);
  }

  expect(errors).toEqual([]);
});

test('the thumbstick drives the pilot', async ({ page }) => {
  const errors = watchErrors(page);
  await startMission(page);

  const before = await state(page);
  const stick = await page.locator('#stick').boundingBox();
  const cx = stick.x + stick.width / 2;
  const cy = stick.y + stick.height / 2;

  // Push the stick right and hold it there.
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx + 40, cy, { steps: 4 });
  await page.waitForTimeout(1500);
  await page.mouse.up();
  await page.waitForTimeout(200);

  const after = await state(page);
  expect(after.hero.x).toBeGreaterThan(before.hero.x + 0.4);

  // Releasing stops it, rather than leaving the pilot walking off the map.
  const stopped = await state(page);
  await page.waitForTimeout(700);
  expect(Math.abs((await state(page)).hero.x - stopped.hero.x)).toBeLessThan(0.05);

  expect(errors).toEqual([]);
});

test('a drag pans the map, and does not order anything', async ({ page }) => {
  const errors = watchErrors(page);
  await startMission(page);

  // Centre the view so the pan has room in both directions — the camera
  // clamps at the map edge, and a mission starts you in a corner.
  await page.locator('.rosterChip').first().tap();
  await page.waitForTimeout(300);

  const before = await state(page);
  // Drag the world leftward: the camera moves right to follow it.
  await touchDrag(page, { x: 620, y: 200 }, { x: 300, y: 200 });
  await page.waitForTimeout(250);

  const after = await state(page);
  expect(after.camera.x).toBeGreaterThan(before.camera.x + 1);
  // A pan is not an order: nothing was told to walk to where the finger left.
  expect(after.hero.x).toBeCloseTo(before.hero.x, 1);

  expect(errors).toEqual([]);
});

test('a tap orders, where a drag did not', async ({ page }) => {
  const errors = watchErrors(page);
  await startMission(page);
  // Out of the cockpit — a driven machine ignores move orders by design.
  await page.keyboard.press('c');
  await page.locator('.rosterChip').first().tap();
  await page.waitForTimeout(250);

  const before = await state(page);
  await page.touchscreen.tap(560, 210);
  await page.waitForTimeout(1600);

  const after = await state(page);
  const moved = Math.hypot(after.hero.x - before.hero.x, after.hero.y - before.hero.y);
  expect(moved).toBeGreaterThan(0.3);

  expect(errors).toEqual([]);
});

test('an order does not strand you outside the cockpit', async ({ page }) => {
  // Found in review. The stick used to be hidden whenever you were not
  // driving, and touching the stick is the *only* way into the cockpit on a
  // phone — `C` does not exist there. So the first tap-to-move, long press or
  // Attack button ended direct control for the rest of the mission, with no
  // affordance left to get it back.
  const errors = watchErrors(page);
  await startMission(page);
  expect((await state(page)).driving).toBe(true);

  // Any order drops direct control, by design.
  await page.touchscreen.tap(560, 210);
  await page.waitForTimeout(300);
  expect((await state(page)).driving).toBe(false);

  // The stick must still be there — dimmed, but present and pressable.
  const stick = page.locator('#stick');
  await expect(stick).toBeVisible();
  await expect(stick).toHaveClass(/idle/);

  // And touching it puts you back in the seat.
  const box = await stick.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 38, box.y + box.height / 2, { steps: 3 });
  await page.waitForTimeout(900);
  await page.mouse.up();

  const after = await state(page);
  expect(after.driving).toBe(true);
  await expect(stick).not.toHaveClass(/idle/);

  expect(errors).toEqual([]);
});

test('the roster bar is reachable and jumps the camera', async ({ page }) => {
  const errors = watchErrors(page);
  await startMission(page);

  const chip = page.locator('.rosterChip').first();
  await expect(chip).toBeVisible();
  const box = await chip.boundingBox();
  // Reachable rather than clipped off the edge of a phone screen.
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(page.viewportSize().width);

  await chip.tap();
  await page.waitForTimeout(250);
  expect((await state(page)).selection.length).toBeGreaterThan(0);

  expect(errors).toEqual([]);
});
