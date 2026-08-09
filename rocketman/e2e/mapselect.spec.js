/**
 * End-to-end: choosing the battlefield before a skirmish.
 *
 * The node suite proves the generator honours a requested character and that
 * asking for nothing still builds yesterday's map. What it cannot prove is
 * that the *menu* is wired to any of it — a picker that reads its value from
 * the wrong element, or a config key that never reaches `createWorld`, fails
 * silently and looks exactly like a working feature: the game starts, a map
 * appears, and it is simply not the one that was asked for.
 *
 * So this drives the real menu and reads the character back off the world.
 */

import { test, expect } from '@playwright/test';
import { PAGE, BOOT } from './helpers.js';
import { MAP_CHARACTER_IDS } from '../engine/grid.js';

function watchErrors(page) {
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  return errors;
}

/** Open the skirmish setup screen from a cold boot. */
async function openSkirmish(page) {
  await page.goto(PAGE);
  await page.locator('#playSkirmish').click();
  await expect(page.locator('#mapCharacter')).toBeVisible();
}

/** Deploy, and report the battlefield the world actually got. */
async function deployAndReadCharacter(page, seed) {
  await page.fill('#seed', String(seed));
  await page.locator('#start').click();
  await page.waitForFunction(() => !!window.__rocketman, null, BOOT);
  return page.evaluate(() => window.__rocketman().map.character);
}

test('the menu offers every battlefield the generator can build', async ({ page }) => {
  await openSkirmish(page);

  const values = await page
    .locator('#mapCharacter option')
    .evaluateAll((options) => options.map((o) => o.value));

  // The blank is "Surprise me"; the rest must be the engine's own list, in
  // its own order, or the menu has grown a copy that can drift.
  expect(values[0]).toBe('');
  expect(values.slice(1)).toEqual(MAP_CHARACTER_IDS);
});

test('the battlefield you pick is the one that gets built', async ({ page }) => {
  const errors = watchErrors(page);
  await openSkirmish(page);

  await page.selectOption('#mapCharacter', 'delta');
  // The hint is the only thing telling the player what they just chose, so a
  // silent one is a picker with no labels.
  await expect(page.locator('#mapCharacterHint')).not.toBeEmpty();

  expect(await deployAndReadCharacter(page, 4242)).toBe('delta');
  expect(errors, `console errors: ${errors.join(' | ')}`).toEqual([]);
});

test('a different pick on the same seed builds a different battlefield', async ({ page }) => {
  // Same seed twice. If the choice were recorded but never read, the seed
  // would decide both times and these would match.
  await openSkirmish(page);
  await page.selectOption('#mapCharacter', 'sprawl');
  expect(await deployAndReadCharacter(page, 777)).toBe('sprawl');

  await openSkirmish(page);
  await page.selectOption('#mapCharacter', 'pastoral');
  expect(await deployAndReadCharacter(page, 777)).toBe('pastoral');
});

test('surprise me leaves the battlefield to the seed', async ({ page }) => {
  await openSkirmish(page);
  await expect(page.locator('#mapCharacter')).toHaveValue('');

  const character = await deployAndReadCharacter(page, 4242);
  expect(MAP_CHARACTER_IDS).toContain(character);
});
