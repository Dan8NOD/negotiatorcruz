/**
 * The crew, as the player meets them: the roster bar, Skyfall, and an
 * unannounced pilot walking into a mission.
 *
 * The engine guarantees are in test/crew.test.js. What only a browser can
 * check is that these are reachable — a bottom bar that selects and centres,
 * a second ability button that fires the right slot, and an arrival that
 * announces itself and shows up in the roster rather than landing silently
 * off-screen.
 */

import { test, expect } from '@playwright/test';

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

async function startMission(page, index = 1) {
  await page.click('#playCampaign');
  await page.locator('.mission').nth(index - 1).click();
  await page.click('#deployMission');
  await expect(page.locator('#game')).toBeVisible();
  await page.waitForFunction(() => typeof window.__rocketman === 'function');
}

const state = (page) => page.evaluate(() => window.__rocketman());

test('the roster bar lists the crew and jumps the camera to them', async ({ page }) => {
  const errors = await freshPage(page);
  await startMission(page);

  const bar = page.locator('#roster');
  await expect(bar).toBeVisible();
  // Ash deploys in mission one, so her chip must be there.
  const pilot = page.locator('.rosterChip.pilot').first();
  await expect(pilot).toBeVisible();
  await expect(pilot).toContainText(/\w/);

  // Non-hero machines are grouped by type with a count.
  await expect(page.locator('.rosterChip:not(.pilot)').first()).toContainText('×');

  // Clicking a chip selects that machine and moves the map to it.
  await page.keyboard.press('c'); // out of the cockpit, so the camera is free
  await page.mouse.move(200, 150);
  await page.mouse.down();
  await page.mouse.move(1300, 640, { steps: 4 });
  await page.mouse.up();
  await page.waitForTimeout(200);

  const before = await state(page);
  await page.locator('.rosterChip:not(.pilot)').first().click();
  await page.waitForTimeout(300);
  const after = await state(page);

  expect(after.selection.length).toBeGreaterThan(0);
  const moved =
    Math.abs(after.camera.x - before.camera.x) + Math.abs(after.camera.y - before.camera.y);
  expect(moved).toBeGreaterThan(0.01);

  expect(errors).toEqual([]);
});

test('the All button selects every combat machine', async ({ page }) => {
  const errors = await freshPage(page);
  await startMission(page);
  await page.keyboard.press('c');

  await page.click('#selectAll');
  await page.waitForTimeout(250);

  const s = await state(page);
  // Mission one deploys Ash plus two Vireos and no economy.
  expect(s.selection.length).toBeGreaterThanOrEqual(3);
  await expect(page.locator('#toast')).toContainText(/machines? selected/);

  expect(errors).toEqual([]);
});

test('a pilot has two ability buttons, and Skyfall crosses the map', async ({ page }) => {
  const errors = await freshPage(page);
  await startMission(page);

  // The hero is already selected — a campaign mission starts in her cockpit.
  const commands = page.locator('#commands');
  await expect(commands).toContainText('Crew');
  await expect(commands).toContainText('Jump Jets');
  await expect(commands).toContainText('Skyfall');

  const before = await state(page);
  const from = { x: before.hero.x, y: before.hero.y };

  // Arm Skyfall and pick a point far across the map.
  await page.keyboard.press('g');
  await expect(page.locator('#toast')).toContainText('Skyfall');
  await page.mouse.click(1300, 200);

  // The leap takes 1.5s of simulation; give it room to land.
  await page.waitForTimeout(3000);
  const after = await state(page);
  const travelled = Math.hypot(after.hero.x - from.x, after.hero.y - from.y);
  expect(travelled).toBeGreaterThan(8);

  expect(errors).toEqual([]);
});

test('an unannounced pilot arrives mid-mission and joins the roster', async ({ page }) => {
  test.setTimeout(180000);
  const errors = await freshPage(page);

  // The briefing must not name her — that is the whole point of a surprise.
  await page.click('#playCampaign');
  await page.locator('.mission').first().click();
  await expect(page.locator('.briefCrew')).toBeVisible();
  await expect(page.locator('.briefCrew')).not.toContainText('Halcyon');
  await page.click('#deployMission');
  await page.waitForFunction(() => typeof window.__rocketman === 'function');

  const heroesAtStart = await page.locator('.rosterChip.pilot').count();

  // She is scheduled for tick 800. Run at speed rather than waiting 40s.
  await page.keyboard.press('c');
  await page.keyboard.press('+');
  await page.keyboard.press('+');
  await page.waitForFunction(() => window.__rocketman().tick > 830, null, { timeout: 90000 });
  await page.waitForTimeout(600);

  // She announced herself, and she is on the bar.
  await expect(page.locator('.rosterChip.pilot')).toHaveCount(heroesAtStart + 1);
  await expect(page.locator('#roster')).toContainText('Vey');

  expect(errors).toEqual([]);
});
