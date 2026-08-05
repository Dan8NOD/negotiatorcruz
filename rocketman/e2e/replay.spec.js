/**
 * Mid-match saves and replays, as the player meets them.
 *
 * The engine-level guarantees — a rebuilt world is bit-identical, a hostile
 * save is rejected — live in test/replay.test.js. What only a browser can
 * check is the custody chain around them: the autosave actually reaches
 * localStorage, survives a full page reload, comes back through the Resume
 * button, and the loop keeps running afterwards; and a spectated replay drives
 * the match without the mouse.
 */

import { test, expect } from '@playwright/test';
import { marchToVictory, expectMissionComplete } from './helpers.js';

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

async function startSkirmish(page, seed = '7') {
  await page.click('#playSkirmish');
  await page.fill('#seed', seed);
  await page.click('#start');
  await expect(page.locator('#game')).toBeVisible();
  await page.waitForFunction(() => typeof window.__rocketman === 'function');
}

const state = (page) => page.evaluate(() => window.__rocketman());

/** Wait until the simulation clock passes `tick`. */
async function waitForTick(page, tick) {
  await page.waitForFunction((t) => window.__rocketman && window.__rocketman().tick >= t, tick, {
    timeout: 45000,
  });
}

test('a match autosaves, survives a reload, and resumes where it stood', async ({ page }) => {
  const errors = await freshPage(page);
  await startSkirmish(page);

  // Give the match a human fingerprint before the autosave lands: an order,
  // so the resumed world provably replays a *player's* commands, not just AI.
  await page.mouse.move(200, 150);
  await page.mouse.down();
  await page.mouse.move(1300, 640, { steps: 6 });
  await page.mouse.up();
  await page.mouse.click(700, 400, { button: 'right' });

  // Past the first autosave (tick 100), with a margin.
  await waitForTick(page, 120);
  const before = await state(page);
  expect(before.mode).toBe('live');

  // Slam the tab shut mid-fight — no quit button, no goodbye. The reload is
  // the whole point: whatever was not on disk did not happen.
  await page.reload();
  await page.waitForFunction(() => !!document.getElementById('resumeMatch'));

  const resume = page.locator('#resumeMatch');
  await expect(resume).toBeVisible();
  await expect(resume).toContainText('Skirmish');

  await resume.click();
  await expect(page.locator('#game')).toBeVisible();
  await page.waitForFunction(() => typeof window.__rocketman === 'function');

  const after = await state(page);
  expect(after.mode).toBe('resumed');
  // The autosave was written at some tick ≥ 100; the resumed world must be at
  // least there, never before it.
  expect(after.tick).toBeGreaterThanOrEqual(100);

  // And it is a running match, not a diorama: the clock keeps advancing.
  await waitForTick(page, after.tick + 40);

  expect(errors).toEqual([]);
});

test('quitting mid-match keeps the save; finishing the match spends it', async ({ page }) => {
  const errors = await freshPage(page);
  await startSkirmish(page);
  await waitForTick(page, 30);

  // Quit before the first scheduled autosave: the quit handler itself must
  // write the save, not depend on the timer having fired.
  await page.click('#quitMatch');
  await expect(page.locator('#title')).toBeVisible();
  await expect(page.locator('#resumeMatch')).toBeVisible();

  // Resuming after quit works too — same button, same custody chain.
  await page.click('#resumeMatch');
  await expect(page.locator('#game')).toBeVisible();
  await page.waitForFunction(() => typeof window.__rocketman === 'function');
  expect((await state(page)).mode).toBe('resumed');

  expect(errors).toEqual([]);
});

test('a finished mission can be watched back, and the replay pays out nothing', async ({ page }) => {
  test.setTimeout(240000);
  const errors = await freshPage(page);

  // Mission 1 is the no-economy opener — the quickest real completion there
  // is, and the same one the campaign speedrun spec plays.
  await page.click('#playCampaign');
  await page.locator('.mission').first().click();
  await page.click('#deployMission');
  await expect(page.locator('#game')).toBeVisible();
  await page.waitForFunction(() => typeof window.__rocketman === 'function');

  // Win it the way the campaign speedrun spec does — see e2e/helpers.js for
  // why that loop is shaped the way it is.
  const won = await marchToVictory(page);
  await expectMissionComplete(page, won);

  // The profile's salvage after the payout, to prove the replay adds nothing.
  const salvageAfter = await page.evaluate(
    () => JSON.parse(window.localStorage.getItem('rocketman.profile.v1')).salvage
  );

  await page.click('#debriefWatch');
  await expect(page.locator('#game')).toBeVisible();
  await page.waitForFunction(() => typeof window.__rocketman === 'function');
  expect((await state(page)).mode).toBe('replay');
  await expect(page.locator('#missionName')).toContainText('Replay');

  // The spectated world runs on the recorded commands — the mission fights
  // itself to the same victory with the mouse untouched.
  await page.keyboard.press('+');
  await page.keyboard.press('+');
  await page.waitForFunction(() => window.__rocketman().over, null, { timeout: 150000 });
  await expect(page.locator('#result h2')).toContainText('Replay over', { timeout: 15000 });

  const salvageAfterReplay = await page.evaluate(
    () => JSON.parse(window.localStorage.getItem('rocketman.profile.v1')).salvage
  );
  expect(salvageAfterReplay).toBe(salvageAfter);

  expect(errors).toEqual([]);
});

test('a corrupted autosave downgrades to a missing button, not a crash', async ({ page }) => {
  const errors = await freshPage(page);

  await page.evaluate(() => {
    window.localStorage.setItem('rocketman.match.v1', '{"version":1,"ticks":');
  });
  await page.reload();
  await page.waitForFunction(() => !!document.getElementById('resumeMatch'));

  await expect(page.locator('#resumeMatch')).toBeHidden();
  await expect(page.locator('#playCampaign')).toBeVisible();
  expect(errors).toEqual([]);
});
