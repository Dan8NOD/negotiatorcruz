/**
 * Direct control, as the player meets it.
 *
 * The engine guarantees — the machine moves, obeys terrain, replays — are in
 * test/steering.test.js. What only a browser can check is the wiring: the
 * campaign starts in the cockpit, the keys reach the simulation, the camera
 * actually follows, and handing control back restores the RTS hotkeys rather
 * than leaving the game in a state with no working controls at all.
 */

import { test, expect } from '@playwright/test';
import { BOOT } from './helpers.js';

const PAGE = '/rocketman/web/rocketman.html';

function watchErrors(page) {
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  return errors;
}

async function freshPage(page) {
  const errors = watchErrors(page);
  await page.goto(PAGE);
  await page.evaluate(() => window.localStorage.clear());
  await page.reload();
  return errors;
}

async function startMission(page) {
  await page.click('#playCampaign');
  await page.locator('.mission').first().click();
  await page.click('#deployMission');
  await expect(page.locator('#game')).toBeVisible();
  await page.waitForFunction(() => typeof window.__rocketman === 'function', null, BOOT);
}

const state = (page) => page.evaluate(() => window.__rocketman());

/**
 * Where the hero is, and where the camera is looking.
 *
 * Reads `hero` rather than `driven` on purpose: half these tests care what
 * the pilot does *after* control has been handed back, and `driven` is null
 * by definition then.
 */
const view = (page) =>
  page.evaluate(() => {
    const s = window.__rocketman();
    return { hero: s.hero, camera: s.camera };
  });

/** Hold a key for a while, the way a player does, then let go. */
async function drive(page, key, ms = 1200) {
  await page.keyboard.down(key);
  await page.waitForTimeout(ms);
  await page.keyboard.up(key);
  await page.waitForTimeout(150);
}

test('a campaign mission starts in the cockpit', async ({ page }) => {
  const errors = await freshPage(page);
  await startMission(page);

  const s = await state(page);
  expect(s.driving).toBe(true);
  expect(s.driven).not.toBeNull();
  // The pilot, not just any machine — this is the player character.
  expect(s.driven.pilot).toBeTruthy();

  await expect(page.locator('#controlMode')).toBeVisible();
  await expect(page.locator('#controlName')).toContainText(/\w/);

  expect(errors).toEqual([]);
});

test('arrow keys pan the camera, in the cockpit or out of it', async ({ page }) => {
  // The arrows used to steer the machine while driving and pan the camera
  // otherwise, so the most-used key on the keyboard did two unrelated things
  // depending on a mode you might not have noticed you were in. Every game
  // this one borrows from has one answer to "what do the arrows do", and it
  // is move the view. This asserts the arrows never move the pilot, which is
  // the half that used to be false.
  const errors = await freshPage(page);
  await startMission(page);

  expect((await state(page)).driving).toBe(true);
  const before = await view(page);

  await page.keyboard.down('ArrowDown');
  await page.waitForTimeout(700);
  await page.keyboard.up('ArrowDown');
  await page.waitForTimeout(150);
  const after = await view(page);

  expect(after.camera.y).toBeGreaterThan(before.camera.y + 0.5);
  expect(Math.abs(after.hero.y - before.hero.y)).toBeLessThan(0.05);

  expect(errors).toEqual([]);
});

test('WASD drives the pilot, and opposite keys cancel', async ({ page }) => {
  const errors = await freshPage(page);
  await startMission(page);

  const before = await view(page);
  // Held long enough to leave the corner. A mission starts the pilot near the
  // map edge, where the camera is pinned by its own clamp and cannot follow
  // anyone — so a short hop moves the machine and not the view, and asserting
  // on the view too early tests the clamp rather than the follow.
  await drive(page, 'd', 2600);
  const after = await view(page);
  expect(after.hero.x).toBeGreaterThan(before.hero.x + 0.5);
  // The map moves with the character — the whole point of the cockpit.
  expect(after.camera.x).toBeGreaterThan(before.camera.x + 0.5);

  // And it stops when the key is released, rather than coasting on.
  await page.waitForTimeout(600);
  const later = await view(page);
  expect(Math.abs(later.hero.x - after.hero.x)).toBeLessThan(0.05);

  // Holding both directions at once must not drift either way. Measured
  // while both are already down — the gap between the two keydowns is a
  // legitimate moment of travel and not what this asserts.
  await page.keyboard.down('a');
  await page.keyboard.down('d');
  await page.waitForTimeout(300);
  const held = await view(page);
  await page.waitForTimeout(700);
  const cancelled = await view(page);
  await page.keyboard.up('a');
  await page.keyboard.up('d');
  expect(Math.abs(cancelled.hero.x - held.hero.x)).toBeLessThan(0.05);

  expect(errors).toEqual([]);
});

test('C hands control back, and the RTS hotkeys work again', async ({ page }) => {
  const errors = await freshPage(page);
  await startMission(page);
  expect((await state(page)).driving).toBe(true);

  await page.keyboard.press('c');
  const s = await state(page);
  expect(s.driving).toBe(false);
  expect(s.driven).toBeNull();
  await expect(page.locator('#controlMode')).toBeHidden();

  // `a` and `s` mean attack-move and stop again rather than steering. The
  // hero is still selected, so attack-move sends it walking — and `s` must
  // then halt it, where under direct control `s` would drive it south. Both
  // halves matter: the first proves `a` reached the order layer, the second
  // proves `s` is no longer a movement key.
  await page.mouse.move(1150, 620);
  await page.keyboard.press('a');
  await page.waitForTimeout(700);
  const walking = await view(page);
  await page.waitForTimeout(600);
  const walked = await view(page);
  const travelled = Math.abs(walked.hero.x - walking.hero.x) + Math.abs(walked.hero.y - walking.hero.y);
  expect(travelled).toBeGreaterThan(0.2);

  await page.keyboard.press('s');
  await page.waitForTimeout(300);
  const halted = await view(page);
  await page.waitForTimeout(700);
  const stillHalted = await view(page);
  expect(Math.abs(stillHalted.hero.x - halted.hero.x)).toBeLessThan(0.05);
  expect(Math.abs(stillHalted.hero.y - halted.hero.y)).toBeLessThan(0.05);

  // And C puts us back in the seat.
  await page.keyboard.press('c');
  expect((await state(page)).driving).toBe(true);

  expect(errors).toEqual([]);
});

test('a right-click order takes the machine off the sticks', async ({ page }) => {
  const errors = await freshPage(page);
  await startMission(page);
  expect((await state(page)).driving).toBe(true);

  // Clicking somewhere is an unambiguous "I have let go".
  await page.mouse.click(700, 400, { button: 'right' });
  await page.waitForTimeout(200);
  expect((await state(page)).driving).toBe(false);

  expect(errors).toEqual([]);
});

test('a skirmish starts under ordinary RTS controls', async ({ page }) => {
  const errors = await freshPage(page);
  await page.click('#playSkirmish');
  await page.fill('#seed', '7');
  await page.click('#start');
  await page.waitForFunction(() => typeof window.__rocketman === 'function', null, BOOT);

  // No hero in a skirmish, so nothing is auto-piloted.
  const s = await state(page);
  expect(s.driving).toBe(false);
  await expect(page.locator('#controlMode')).toBeHidden();

  // Arrow keys pan the camera instead — the panner that had never been
  // called at all before this change.
  const before = await view(page);
  await drive(page, 'ArrowRight', 700);
  const after = await view(page);
  expect(after.camera.x).toBeGreaterThan(before.camera.x + 0.5);

  expect(errors).toEqual([]);
});

test('losing focus mid-drive stops the machine', async ({ page }) => {
  const errors = await freshPage(page);
  await startMission(page);

  // Key down, then blur without ever releasing it. Without the blur handler
  // the key stays logically held and the pilot walks off across the map.
  await page.keyboard.down('ArrowRight');
  await page.waitForTimeout(400);
  await page.evaluate(() => window.dispatchEvent(new Event('blur')));
  await page.waitForTimeout(300);

  const settled = await view(page);
  await page.waitForTimeout(700);
  const later = await view(page);
  await page.keyboard.up('ArrowRight');

  expect(Math.abs(later.hero.x - settled.hero.x)).toBeLessThan(0.05);
  expect(errors).toEqual([]);
});
