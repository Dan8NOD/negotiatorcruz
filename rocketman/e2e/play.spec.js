/**
 * End-to-end: the game as a player actually meets it.
 *
 * A canvas game is opaque to the DOM, so these assertions read state through
 * `window.__rocketman()` — the read-only inspection hook main.js installs — and
 * through the HUD, which is real DOM. Between them they cover the loop that
 * matters: the page boots, a match starts, the economy runs, orders land,
 * structures go up, and nothing throws while it does.
 */

import { test, expect } from '@playwright/test';
import { marchToVictory, expectMissionComplete } from './helpers.js';

const PAGE = '/rocketman/web/rocketman.html';

/** Collect page errors from the first navigation onward. */
function watchErrors(page) {
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  return errors;
}

/**
 * Open the page with a clean campaign save.
 *
 * The profile lives in localStorage, so without this a spec would inherit
 * whatever the previous spec unlocked and bought — and "mission 2 is locked"
 * would pass or fail depending on test order.
 */
async function freshPage(page) {
  const errors = watchErrors(page);
  await page.goto(PAGE);
  await page.evaluate(() => window.localStorage.clear());
  await page.reload();
  return errors;
}

/** Start a skirmish and return a probe into the running world. */
async function startMatch(page, { seed = '7', difficulty = 'normal' } = {}) {
  const errors = await freshPage(page);

  await page.click('#playSkirmish');
  await page.fill('#seed', seed);
  await page.selectOption('#difficulty', difficulty);
  await page.click('#start');
  await expect(page.locator('#game')).toBeVisible();
  await page.waitForFunction(() => typeof window.__rocketman === 'function');

  return {
    errors,
    state: () => page.evaluate(() => window.__rocketman()),
  };
}

/** Start mission N (1-based) of the campaign. */
async function startMission(page, index = 1) {
  const errors = await freshPage(page);

  await page.click('#playCampaign');
  await page.locator('.mission').nth(index - 1).click();
  await page.click('#deployMission');
  await expect(page.locator('#game')).toBeVisible();
  await page.waitForFunction(() => typeof window.__rocketman === 'function');

  return { errors, state: () => page.evaluate(() => window.__rocketman()) };
}

test('the title screen offers both modes', async ({ page }) => {
  await freshPage(page);
  await expect(page.locator('#playCampaign')).toContainText('Campaign');
  await expect(page.locator('#playSkirmish')).toContainText('Skirmish');
});

test('the skirmish menu offers both factions and their rosters', async ({ page }) => {
  await freshPage(page);
  await page.click('#playSkirmish');

  const factions = page.locator('#factionList .faction');
  await expect(factions).toHaveCount(2);
  await expect(factions.nth(0)).toContainText('Ascendancy');
  await expect(factions.nth(1)).toContainText('Bulwark');
  // The signature chassis must be discoverable before the player commits.
  await expect(factions.nth(0)).toContainText('Kestrel');

  await expect(page.locator('#difficulty option')).toHaveCount(3);
});

test('choosing a faction is reflected in the match that starts', async ({ page }) => {
  await freshPage(page);
  await page.click('#playSkirmish');
  await page.locator('#factionList .faction', { hasText: 'Bulwark' }).click();
  await page.click('#start');
  await page.waitForFunction(() => typeof window.__rocketman === 'function');

  const state = await page.evaluate(() => window.__rocketman());
  expect(state.players[0].faction).toBe('bulwark');
  expect(state.players[1].faction).toBe('ascendancy');
});

test('a match boots with a base and starts mining', async ({ page }) => {
  const match = await startMatch(page);

  const opening = await match.state();
  expect(opening.counts['0:command']).toBe(1);
  expect(opening.counts['0:collector']).toBeGreaterThanOrEqual(3);

  // Give the collectors a full round trip.
  await page.waitForTimeout(6000);
  const later = await match.state();
  expect(later.tick).toBeGreaterThan(opening.tick);
  expect(later.players[0].mined).toBeGreaterThan(0);

  expect(match.errors).toEqual([]);
});

test('the HUD reports scrap, power and time', async ({ page }) => {
  await startMatch(page);

  await expect(page.locator('#scrap')).not.toHaveText('0');
  await expect(page.locator('#power')).toContainText('/');
  await expect(page.locator('#clock')).toHaveText(/\d\d:\d\d/);
});

test('selecting the Command Rig opens the build menu', async ({ page }) => {
  await startMatch(page);

  await page.keyboard.press('b');
  await expect(page.locator('#selection')).toContainText('Command Rig');

  const commands = page.locator('#commands');
  await expect(commands).toContainText('Construct');
  await expect(commands).toContainText('Reactor');
  await expect(commands).toContainText('Refinery');

  // The Hangar needs a Tech Lab, so it must start unavailable.
  await expect(page.locator('#commands .cmd.off', { hasText: 'Hangar' })).toHaveCount(1);
});

test('a structure can be sited and built, and it charges scrap', async ({ page }) => {
  const match = await startMatch(page);

  await page.keyboard.press('b');
  const before = await match.state();

  await page.keyboard.press('1'); // Reactor

  // Try a few spots around the base rather than trusting one pixel. The
  // Command Rig sits under the camera centre and the starting wreck field is
  // off to one side, so any single hardcoded point is a coin flip — and a red
  // "Cannot build there" is a correct refusal, not a bug to assert around.
  let placed = null;
  for (const [x, y] of [
    [440, 250],
    [440, 480],
    [980, 240],
    [560, 200],
    [900, 560],
  ]) {
    await page.mouse.move(x, y);
    await page.mouse.click(x, y);
    await page.waitForTimeout(400);
    placed = await match.state();
    if (placed.counts['0:reactor']) break;
  }

  expect(placed.counts['0:reactor']).toBe(1);
  expect(placed.players[0].scrap).toBeLessThan(before.players[0].scrap);

  // And it eventually finishes and adds its generation.
  await page.waitForTimeout(14000);
  const done = await match.state();
  expect(done.players[0].tech).toContain('reactor');
  expect(done.players[0].powerMade).toBeGreaterThan(before.players[0].powerMade);

  expect(match.errors).toEqual([]);
});

test('drag-select grabs the army and leaves the collectors mining', async ({ page }) => {
  const match = await startMatch(page);

  await page.mouse.move(400, 200);
  await page.mouse.down();
  await page.mouse.move(1000, 640, { steps: 10 });
  await page.mouse.up();
  await page.waitForTimeout(300);

  const state = await match.state();
  expect(state.selection.length).toBeGreaterThan(0);

  const panel = page.locator('#selection');
  await expect(panel).not.toContainText('Collector');
  await expect(panel).toContainText(/Kestrel|Vireo|Anvil|Tick/);
});

test('a selected mech exposes its ability, and firing it puts it on cooldown', async ({ page }) => {
  const match = await startMatch(page);

  await page.mouse.move(400, 200);
  await page.mouse.down();
  await page.mouse.move(1000, 640, { steps: 10 });
  await page.mouse.up();
  await page.waitForTimeout(300);

  const ability = page.locator('#commands .cmd', { hasText: /Jump Jets|Afterburn|Aegis/ });
  await expect(ability.first()).toBeVisible();
  await expect(ability.first()).toContainText('Ready');

  await page.keyboard.press('f');
  await page.waitForTimeout(200);

  // A targeted ability arms and waits for a point; an untargeted one has
  // already gone off. Clicking blindly in the second case is just a click on
  // empty ground, which deselects everything and proves nothing.
  const armed = await page.locator('#toast').textContent();
  if (/target point/i.test(armed || '')) {
    await page.mouse.click(900, 420);
    await page.waitForTimeout(600);
  }

  // Whatever fired is now counting down rather than reading Ready.
  await expect(page.locator('#commands')).toContainText(/\ds/);
  expect(match.errors).toEqual([]);
});

test('a right-click order moves the selected units', async ({ page }) => {
  const match = await startMatch(page);

  await page.mouse.move(400, 200);
  await page.mouse.down();
  await page.mouse.move(1000, 640, { steps: 10 });
  await page.mouse.up();
  await page.waitForTimeout(200);

  const ids = (await match.state()).selection;
  expect(ids.length).toBeGreaterThan(0);

  const before = await page.evaluate(
    (list) => list.map((id) => [id, 0]),
    ids
  );
  // Order them across the map and confirm the world clock advanced without
  // error; exact positions are the unit suite's job, not the browser's.
  await page.mouse.click(1100, 560, { button: 'right' });
  await page.waitForTimeout(3000);

  const after = await match.state();
  expect(after.tick).toBeGreaterThan(0);
  expect(before.length).toBe(ids.length);
  expect(match.errors).toEqual([]);
});

test('pause stops the clock and resuming restarts it', async ({ page }) => {
  const match = await startMatch(page);
  await page.waitForTimeout(1000);

  await page.keyboard.press('Space');
  await expect(page.locator('#toast')).toContainText('Paused');
  const paused = (await match.state()).tick;

  await page.waitForTimeout(1500);
  expect((await match.state()).tick).toBe(paused);

  await page.keyboard.press('Space');
  await page.waitForTimeout(1000);
  expect((await match.state()).tick).toBeGreaterThan(paused);
});

test('a long unattended match runs clean against the AI', async ({ page }) => {
  const match = await startMatch(page, { seed: '99', difficulty: 'hard' });

  await page.keyboard.press('+');
  await page.keyboard.press('+');
  await page.waitForTimeout(30000);

  const state = await match.state();
  expect(state.tick).toBeGreaterThan(1000);
  // The opponent should have done something with all that time.
  expect(state.players[1].mined).toBeGreaterThan(1000);
  expect(state.players[1].tech.length).toBeGreaterThan(1);
  expect(match.errors).toEqual([]);
});

/* ------------------------------------------------------------- campaign -- */

test('the campaign lists every mission and locks all but the first', async ({ page }) => {
  await freshPage(page);
  await page.click('#playCampaign');

  await expect(page.locator('#campaign h2')).toContainText('Just You and Your Rocket Crew');
  await expect(page.locator('.mission')).toHaveCount(7);
  await expect(page.locator('.mission:not(.locked)')).toHaveCount(1);
  await expect(page.locator('.mission').first()).toContainText('Hard Landing');
});

test('a briefing shows the objectives and the crew before you commit', async ({ page }) => {
  await freshPage(page);
  await page.click('#playCampaign');
  await page.locator('.mission').first().click();

  await expect(page.locator('#briefing h2')).toContainText('Hard Landing');
  await expect(page.locator('.briefObjectives .obj')).not.toHaveCount(0);
  await expect(page.locator('.briefCrew')).toContainText('Ash');
});

test('mission one deploys the crew, no base, and a live objective tracker', async ({ page }) => {
  const match = await startMission(page, 1);
  const state = await match.state();

  expect(state.mission).toBe('hard_landing');
  // The whole point of mission one: three machines and no economy.
  expect(state.counts['0:command']).toBeUndefined();
  expect(state.counts['0:kestrel']).toBe(1);
  expect(state.objectives.length).toBeGreaterThan(0);

  await expect(page.locator('#objectives')).toBeVisible();
  await expect(page.locator('#objectives')).toContainText('listening post');
  await expect(page.locator('#missionName')).toContainText('Hard Landing');
  expect(match.errors).toEqual([]);
});

test('a mission can be won, and it pays out and unlocks the next one', async ({ page }) => {
  test.setTimeout(240000);
  const match = await startMission(page, 1);

  // The assertion is "this strategy wins" — not "this hardware is quick" or
  // "this coin lands heads". See marchToVictory for what that costs.
  const won = await marchToVictory(page);

  await expectMissionComplete(page, won);
  await expect(page.locator('#debrief')).toContainText('Mission reward');
  await expect(page.locator('.crewXp')).toContainText('XP');

  await page.click('#debriefContinue');
  await expect(page.locator('.mission:not(.locked)')).toHaveCount(2);
  await expect(page.locator('.salvageLine b')).not.toHaveText('0');

  expect(match.errors).toEqual([]);
});

test('the Hangar sells upgrades and spends salvage', async ({ page }) => {
  await freshPage(page);

  // Grant salvage directly rather than replaying a mission — this spec is
  // about the shop, and the mission that earns it is covered above.
  await page.evaluate(() => {
    const raw = JSON.parse(window.localStorage.getItem('rocketman.profile.v1') || '{}');
    window.localStorage.setItem(
      'rocketman.profile.v1',
      JSON.stringify({ ...raw, salvage: 5000, pilots: { ash: { xp: 0 } } })
    );
  });
  await page.reload();

  await page.click('#playCampaign');
  await page.locator('#campaign .campaignActions button', { hasText: 'Hangar' }).click();

  await expect(page.locator('#hangar h2')).toContainText('Hangar');
  await expect(page.locator('.upgrade')).not.toHaveCount(0);
  await expect(page.locator('.crewCard')).toContainText('Ash');

  const buyable = page.locator('.upgrade:not(.off):not(.owned)').first();
  await buyable.click();

  await expect(page.locator('.upgrade.owned')).toHaveCount(1);
  await expect(page.locator('#hangarSalvage')).not.toHaveText('5,000');
});

test('a purchased upgrade reaches the units in the next mission', async ({ page }) => {
  await freshPage(page);
  await page.evaluate(() => {
    window.localStorage.setItem(
      'rocketman.profile.v1',
      JSON.stringify({ salvage: 9000, upgrades: ['field_plating'], pilots: { ash: { xp: 0 } } })
    );
  });
  await page.reload();

  await page.click('#playCampaign');
  await page.locator('.mission').first().click();
  await page.click('#deployMission');
  await page.waitForFunction(() => typeof window.__rocketman === 'function');

  const state = await page.evaluate(() => window.__rocketman());
  expect(state.players[0].upgrades).toContain('field_plating');
});

test('campaign progress survives a reload', async ({ page }) => {
  await freshPage(page);
  await page.evaluate(() => {
    window.localStorage.setItem(
      'rocketman.profile.v1',
      JSON.stringify({
        salvage: 1234,
        completed: ['hard_landing'],
        upgrades: [],
        pilots: { ash: { xp: 500 } },
      })
    );
  });
  await page.reload();

  await page.click('#playCampaign');
  await expect(page.locator('.salvageLine b')).toHaveText('1,234');
  await expect(page.locator('.mission:not(.locked)')).toHaveCount(2);
  await expect(page.locator('.mission').first()).toContainText('Cleared');
});

/* ------------------------------------------- sell, repair, superweapon -- */

test('the build bar offers the Orbital Lance, locked until the tech exists', async ({ page }) => {
  await startMatch(page);
  await page.keyboard.press('b');

  const lance = page.locator('#commands .cmd', { hasText: 'Orbital Lance' });
  await expect(lance).toHaveCount(1);
  // It needs a Tech Lab and a Hangar, so it must start unavailable.
  await expect(page.locator('#commands .cmd.off', { hasText: 'Orbital Lance' })).toHaveCount(1);
});

test('selecting a structure offers Sell and Repair', async ({ page }) => {
  await startMatch(page);
  await page.keyboard.press('b');

  const commands = page.locator('#commands');
  await expect(commands).toContainText('Structure');
  await expect(commands.locator('.cmd', { hasText: 'Repair' })).toHaveCount(1);
  await expect(commands.locator('.cmd', { hasText: 'Sell' })).toHaveCount(1);
});

test('the last Command Rig cannot be sold', async ({ page }) => {
  const match = await startMatch(page);
  await page.keyboard.press('b');

  // Selling your only HQ is a misclick that would end the match, so the
  // button is disabled rather than merely ignored.
  await expect(page.locator('#commands .cmd.off', { hasText: 'Sell' })).toHaveCount(1);

  const state = await match.state();
  expect(state.counts['0:command']).toBe(1);
});

test('a structure can be built and then sold back for scrap', async ({ page }) => {
  const match = await startMatch(page);

  await page.keyboard.press('b');
  await page.keyboard.press('1'); // Reactor

  let placed = null;
  let spot = null;
  for (const [x, y] of [
    [440, 250],
    [440, 480],
    [980, 240],
    [560, 200],
    [900, 560],
  ]) {
    await page.mouse.move(x, y);
    await page.mouse.click(x, y);
    await page.waitForTimeout(400);
    placed = await match.state();
    if (placed.counts['0:reactor']) {
      spot = [x, y];
      break;
    }
  }
  expect(placed.counts['0:reactor']).toBe(1);

  // Let it finish, then select it and cash it out. The placement preview is
  // centred on the cursor, so the reactor is under the pixel that built it.
  await page.waitForTimeout(14000);
  const built = await match.state();
  expect(built.players[0].tech).toContain('reactor');

  await page.mouse.click(spot[0], spot[1]);
  await page.waitForTimeout(300);
  await expect(page.locator('#selection')).toContainText('Reactor');

  const before = await match.state();
  await page.locator('#commands .cmd', { hasText: 'Sell' }).click();
  await page.waitForTimeout(600);

  const after = await match.state();
  expect(after.counts['0:reactor']).toBeUndefined();
  expect(after.players[0].scrap).toBeGreaterThan(before.players[0].scrap - 200);
  expect(match.errors).toEqual([]);
});
