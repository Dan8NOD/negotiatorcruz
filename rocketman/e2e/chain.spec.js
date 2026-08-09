/**
 * End-to-end: a gateway loads the next plate.
 *
 * The node suite proves the chain's *arithmetic* — where a door goes, what a
 * run accumulates, that a one-plate run reads like a plain mission. What it
 * cannot reach is the screen flow, which is the whole of the change a player
 * notices: no debrief between two halves of a descent, no briefing, no Deploy
 * button, one card that names where the crew is going and then the next map.
 *
 * So there are two tests here, and they cover the two halves of that.
 *
 * The slow one plays Ironhold for real, takes the shaft, and lets the card
 * carry the game into the Undercroft **without touching the keyboard**. That
 * is deliberate: a card that only advances when pressed is a card that strands
 * a player who waits, and waiting is what most people do the first time a
 * screen they have never seen appears. It is worth its minute — every failure
 * mode of this feature is a missing screen or a stuck one, and no assertion on
 * a data structure can see either.
 *
 * The fast one drives the card itself: what it says, and that the whole
 * surface advances it, which is the only affordance a phone gets.
 *
 * Reaching Ironhold legitimately means clearing three story missions, so the
 * prerequisites are written straight into the save the way `challenges.spec.js`
 * does. The crew is written in fully upgraded for the same reason a test uses a
 * fixture rather than a play-through: the point being proved is that the door
 * chains, not that the fight is winnable at any particular strength — and the
 * campaign-completable test in the node suite already owns that question.
 */

import { test, expect } from '@playwright/test';
import { BOOT } from './helpers.js';
import { CELL } from '../engine/content.js';
import { UPGRADES, PILOTS } from '../engine/progression.js';

const PAGE = '/rocketman/web/rocketman.html';
const PROFILE_KEY = 'rocketman.profile.v1';

// Read off the engine rather than transcribed. A hand-written list of upgrade
// ids would drift the first time one is renamed, and the save-file parser
// drops what it does not recognise *silently* — so the crew would quietly get
// weaker until the fight stopped fitting in the budget, with nothing pointing
// at the cause. The engine is pure ESM and imports into node unchanged.
const EVERY_UPGRADE = Object.keys(UPGRADES);
const VETERAN_CREW = Object.keys(PILOTS);

function watchErrors(page) {
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  return errors;
}

/** Open the page with a save that has already earned its way to Ironhold. */
async function pageWithVeteranCrew(page) {
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
        salvage: 0,
        completed: ['hard_landing', 'scrap_rights', 'brownout'],
        discovered: [],
        records: {},
        upgrades: EVERY_UPGRADE,
        // xp rather than level: profile.js recomputes the level from the
        // experience, so a hand-written level would be discarded on load.
        pilots: Object.fromEntries(VETERAN_CREW.map((id) => [id, { id, xp: 200000 }])),
        totals: { killed: 0, lost: 0, mined: 0, missions: 3 },
      },
    ]
  );
  await page.reload();
  return errors;
}

const state = (page) => page.evaluate(() => (window.__rocketman ? window.__rocketman() : null));

/**
 * Where a world position is on screen right now, clamped into the viewport.
 *
 * The renderer's own transform — `(world - camera) * CELL * zoom` — read off
 * the inspection hook, so it stays correct at any zoom. Same technique as
 * `e2e/helpers.js`, and the same reason: a fixed screen pixel encodes a
 * direction rather than a place.
 */
async function screenPoint(page, wx, wy, viewport) {
  const now = await state(page);
  if (!now) return { x: viewport.width / 2, y: viewport.height / 2 };
  const { camera } = now;
  const scale = CELL * camera.zoom;
  const x = (wx - camera.x) * scale;
  const y = (wy - camera.y) * scale;
  return {
    x: Math.max(40, Math.min(viewport.width - 40, x)),
    y: Math.max(60, Math.min(viewport.height - 240, y)),
  };
}

/** A real player's way to look somewhere: click the minimap. */
async function jumpTo(page, at) {
  const box = await page.locator('#minimap').boundingBox();
  const map = (await state(page)).map;
  await page.mouse.click(
    box.x + (at.x / map.width) * box.width,
    box.y + (at.y / map.height) * box.height
  );
}

test('taking the shaft loads the Undercroft, with one card and no menus', async ({ page }) => {
  test.setTimeout(240000);
  const errors = await pageWithVeteranCrew(page);
  const viewport = page.viewportSize();

  await page.click('#playCampaign');
  await page.locator('.mission[data-mission="ironhold"]').click();
  await page.click('#deployMission');
  // Named rather than bare, because when a match fails to boot the useful
  // fact is always in the console rather than in "a div stayed hidden".
  await expect(page.locator('#game'), `page errors: ${errors.join(' | ')}`).toBeVisible();
  await page.waitForFunction(() => typeof window.__rocketman === 'function', null, BOOT);

  const opening = await state(page);
  expect(opening.mission).toBe('ironhold');
  expect(opening.gateways[0].open).toBe(false);
  const shaft = { x: opening.gateways[0].x, y: opening.gateways[0].y };

  // C hands the keyboard back to the RTS scheme — a campaign mission starts in
  // the cockpit, where every key drives the pilot instead of ordering anyone.
  await page.keyboard.press('c');
  await page.keyboard.press('+');
  await page.keyboard.press('+');

  // Walk the crew to the headquarters, knock it down, then walk into the hole
  // it was built over. Three orders, re-issued each round from the state as it
  // actually is: the same reason `marchToVictory` re-aims rather than trusting
  // its first click.
  const deadline = Date.now() + 180000;
  let finished = null;
  while (Date.now() < deadline && !finished) {
    const now = await state(page);
    if (!now) break;

    await page.click('#selectAll');
    await jumpTo(page, shaft);

    const near = now.hero && Math.hypot(now.hero.x - shaft.x, now.hero.y - shaft.y) < 9;
    // Far off, walk to ground beside the landmark: right-clicking the building
    // itself while it is under fog is an order to move into a wall. Close up,
    // right-click *it* — a prop is never auto-targeted, so demolishing one is
    // always something the player asked for by name. Once the shaft is open
    // the same click is a move order, because input.js deliberately lets a
    // click through a gateway rather than trying to shoot it.
    const aim = now.gateways[0].open || near ? shaft : { x: shaft.x - 5, y: shaft.y - 5 };
    const at = await screenPoint(page, aim.x, aim.y, viewport);
    await page.mouse.click(at.x, at.y, { button: 'right' });

    // Polled rather than slept through, because the match is torn down about a
    // second and a half after it is decided — sleeping past that reads the
    // world's final state as "no world" and loses every assertion below.
    for (let i = 0; i < 11 && !finished; i++) {
      await page.waitForTimeout(200);
      const s = await state(page);
      if (!s) break;
      if (s.over) finished = s;
    }
  }

  expect(finished, 'the crew never got down the shaft').not.toBeNull();
  expect(finished.gateways[0].entered).toBe(true);
  expect(finished.exit.to).toBe('undercroft');

  // The card. It names where they are going and says one line about it — and
  // it is not a debrief: no payout, no objective list, nothing to press.
  const card = page.locator('#transition');
  await expect(card).toBeVisible({ timeout: 20000 });
  await expect(card).toContainText('The Undercroft');
  await expect(card).toContainText('The air coming up is warm.');
  await expect(card).not.toContainText('Mission reward');
  await expect(card).not.toContainText('Salvage');
  await expect(page.locator('#debrief')).toBeHidden();
  await expect(page.locator('#briefing')).toBeHidden();

  // It holds. A card that flicked past before it could be read would be worse
  // than the debrief it replaced.
  await page.waitForTimeout(400);
  await expect(card).toBeVisible();

  // And then it goes on by itself, with nothing pressed: no briefing, no
  // Deploy button, the next plate simply up.
  await expect(page.locator('#game')).toBeVisible({ timeout: 15000 });
  await page.waitForFunction(
    () => window.__rocketman && window.__rocketman().mission === 'undercroft',
    null,
    BOOT
  );

  const below = await state(page);
  expect(below.biome).toBe('cavern');
  expect(below.tick).toBeLessThan(400);
  expect(below.mode).toBe('live');
  await expect(page.locator('#missionName')).toContainText('The Undercroft');

  // The first plate was banked on the way through rather than held until the
  // end of the run, which is what makes a chain safe to reload out of.
  const saved = await page.evaluate(() =>
    JSON.parse(window.localStorage.getItem('rocketman.profile.v1'))
  );
  expect(saved.completed).toContain('ironhold');
  expect(saved.discovered).toContain('undercroft');
  expect(saved.salvage).toBeGreaterThan(0);

  expect(errors, `page errors: ${errors.join(' | ')}`).toEqual([]);
});

test('the card says where the crew is going, and the whole of it is the button', async ({
  page,
}) => {
  // Driven directly rather than through a fight, because what is being checked
  // is the card's own contract — its wording and its one affordance — and
  // hanging that off a match makes it as reliable as the match is long.
  const errors = watchErrors(page);
  await page.goto(PAGE);
  await page.waitForFunction(() => typeof window.rocketmanBack === 'function', null, BOOT);

  const advanced = await page.evaluate(async () => {
    const ui = await import('./campaign-ui.js');
    const taken = [];
    ui.renderTransition(
      { name: 'The Iron Keep', kind: 'gate', flavour: 'A courtyard, and it is lit.' },
      { subtitle: 'Beyond the great door' },
      { onAdvance: () => taken.push('clicked') }
    );
    const root = document.getElementById('transition');
    root.hidden = false;
    root.click();
    return { taken, text: root.textContent, hint: !!document.getElementById('transitionHint') };
  });

  // The verb comes from the gateway's kind, so a shaft says "Descend" and a
  // door says "Enter" without either being written twice.
  expect(advanced.text).toContain('Enter');
  expect(advanced.text).toContain('The Iron Keep');
  expect(advanced.text).toContain('A courtyard, and it is lit.');
  expect(advanced.hint).toBe(true);
  expect(advanced.taken).toEqual(['clicked']);

  await page.evaluate(() => {
    document.getElementById('transition').hidden = true;
  });
  expect(errors, `page errors: ${errors.join(' | ')}`).toEqual([]);
});
