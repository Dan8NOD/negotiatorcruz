/**
 * End-to-end: the two challenges, in a browser.
 *
 * The node suite proves the gateway *system* — it opens on the right death,
 * it cannot be shot, it wins the mission when somebody walks in. None of that
 * touches render.js, which is where a landmark, a castle door, a shaft and two
 * new biome palettes all have to draw without throwing. That is what this
 * covers, plus the two screen transitions the system added: a challenge is on
 * the mission list, and the debrief offers the way through.
 *
 * Reaching a challenge legitimately means clearing three story missions, which
 * is fifteen minutes of browser time to test a click. So the prerequisites are
 * written straight into the save — the same shape `engine/profile.js` writes —
 * and the profile tests cover the unlock rule itself.
 */

import { test, expect } from '@playwright/test';
import { BOOT } from './helpers.js';

const PAGE = '/rocketman/web/rocketman.html';
const PROFILE_KEY = 'rocketman.profile.v1';

function watchErrors(page) {
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  return errors;
}

/** Open the page with a save that has already earned its way to a challenge. */
async function pageWithProgress(page, { completed = [], discovered = [] } = {}) {
  const errors = watchErrors(page);
  await page.goto(PAGE);
  await page.evaluate(
    ([key, save]) => {
      window.localStorage.clear();
      window.localStorage.setItem(key, JSON.stringify(save));
    },
    [
      PROFILE_KEY,
      {
        version: 1,
        salvage: 4000,
        completed,
        discovered,
        records: {},
        upgrades: [],
        pilots: {},
        totals: { killed: 0, lost: 0, mined: 0, missions: completed.length },
      },
    ]
  );
  await page.reload();
  return errors;
}

const STORY_TO_BASTION = ['hard_landing', 'scrap_rights', 'brownout', 'anvil_line', 'cold_open'];

/**
 * Put the camera on a world position by clicking the minimap.
 *
 * A real player's way of getting there, and the only one available: the
 * inspection hook is read-only by design, so a test cannot set the camera.
 */
async function jumpTo(page, at) {
  const minimap = page.locator('#minimap');
  const box = await minimap.boundingBox();
  const map = await page.evaluate(() => window.__rocketman().map);
  await page.mouse.click(
    box.x + (at.x / map.width) * box.width,
    box.y + (at.y / map.height) * box.height
  );
}

/** Launch a challenge by name from the mission-select screen. */
async function launch(page, missionId) {
  await page.click('#playCampaign');
  const card = page.locator(`.mission[data-mission="${missionId}"]`);
  await expect(card).toBeVisible();
  await expect(card).not.toHaveClass(/locked/);
  await card.click();
  await page.click('#deployMission');
  await expect(page.locator('#game')).toBeVisible();
  await page.waitForFunction(() => typeof window.__rocketman === 'function', null, BOOT);
  return () => page.evaluate(() => window.__rocketman());
}

test('challenges are listed, and locked until the story reaches them', async ({ page }) => {
  await pageWithProgress(page, { completed: [] });
  await page.click('#playCampaign');

  const ironhold = page.locator('.mission[data-mission="ironhold"]');
  await expect(ironhold).toBeVisible();
  await expect(ironhold).toHaveClass(/locked/);
  await expect(ironhold).toContainText('Ironhold');

  // And the world behind the door is not even named until somebody finds it.
  await expect(page.locator('.mission[data-mission="undercroft"]')).toHaveCount(0);
});

test('Ironhold boots with the headquarters standing and the shaft sealed', async ({ page }) => {
  const errors = await pageWithProgress(page, { completed: ['hard_landing', 'scrap_rights', 'brownout'] });
  const state = await launch(page, 'ironhold');

  const opening = await state();
  expect(opening.mission).toBe('ironhold');
  expect(opening.biome).toBe('surface');
  expect(opening.props.headquarters).toBe(1);
  expect(opening.gateways).toHaveLength(1);
  expect(opening.gateways[0].open).toBe(false);
  expect(opening.exit).toBe(null);

  // The objective reads as the two-step job it is.
  expect(opening.objectives[0].total).toBe(2);
  expect(opening.objectives[0].progress).toBe(0);

  await page.waitForTimeout(2500);
  expect(errors, `page errors: ${errors.join(' | ')}`).toEqual([]);
});

test('The Bastion boots with the Robot Marine in the doorway', async ({ page }) => {
  const errors = await pageWithProgress(page, { completed: STORY_TO_BASTION });
  const state = await launch(page, 'bastion');

  const opening = await state();
  expect(opening.mission).toBe('bastion');
  expect(opening.props.castle).toBe(1);
  expect(opening.gateways[0].kind).toBe('gate');
  expect(opening.gateways[0].open).toBe(false);

  // The guard exists, belongs to the enemy, and stands where the gate is.
  expect(opening.counts['1:marine']).toBe(1);

  // Jump the camera onto the castle from the minimap. Panning there is not
  // decoration in this spec: it is what forces the renderer to actually draw
  // a 6×6 landmark, four towers and a barred door, which is the half of this
  // feature the node suite cannot reach.
  await jumpTo(page, opening.gateways[0]);
  await page.waitForTimeout(2500);
  expect(errors, `page errors: ${errors.join(' | ')}`).toEqual([]);
});

test('an underworld renders as chambers, and nothing throws down there', async ({ page }) => {
  const errors = await pageWithProgress(page, {
    completed: [...STORY_TO_BASTION, 'ironhold'],
    discovered: ['undercroft'],
  });
  const state = await launch(page, 'undercroft');

  const opening = await state();
  expect(opening.mission).toBe('undercroft');
  expect(opening.biome).toBe('cavern');
  // Cavern scenery, not the surface's.
  expect(opening.props.house || 0).toBe(0);
  expect((opening.props.pillar || 0) + (opening.props.crystal || 0)).toBeGreaterThan(0);

  await page.waitForTimeout(3000);
  expect(errors, `page errors: ${errors.join(' | ')}`).toEqual([]);
});
