/**
 * The game on a Fire HD tablet.
 *
 * The Fire OS build is a WebView around exactly these files (see
 * `rocketman/android/`), so everything the shell depends on is a property of
 * the page and can be proved here, without a device in the room. Three things
 * matter and none of them are covered by the phone suite:
 *
 *   1. **Back.** Android hands the hardware button to the shell, which asks the
 *      page `window.rocketmanBack()` and closes the app if the answer is false.
 *      That contract is the only bridge between Java and the game, so it is the
 *      only thing that can silently rot.
 *   2. **The tablet viewport.** A Fire HD is landscape, roughly twice the CSS
 *      width of the phone the mobile suite emulates, and coarse-pointered. The
 *      touch controls key off pointer capability rather than screen size, and a
 *      big tablet is exactly the case where those two disagree.
 *   3. **localStorage.** The campaign lives there. The shell goes to real
 *      trouble to serve the game from an https origin rather than file://
 *      precisely so this keeps working; a test that the profile survives a
 *      reload is what makes that trouble legible.
 */

import { test, expect } from '@playwright/test';

const PAGE = '/rocketman/web/rocketman.html';

/*
 * Fire HD 10 (2021 and later): 1920x1200 physical at a devicePixelRatio of 1.5,
 * so the page sees 1280x800 CSS pixels. The Fire HD 8 lands at 1280x800
 * physical and the Fire Max 11 at 2000x1200 — this sits in the middle of the
 * family and is the most common Fire tablet in the field.
 */
test.use({
  viewport: { width: 1280, height: 800 },
  deviceScaleFactor: 1.5,
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

async function fresh(page) {
  await page.goto(PAGE);
  await page.evaluate(() => window.localStorage.clear());
  await page.reload();
  await expect(page.locator('#title')).toBeVisible();
}

const back = (page) => page.evaluate(() => window.rocketmanBack());

test.describe('Fire OS shell contract', () => {
  test('the page exposes the back bridge the shell calls', async ({ page }) => {
    await fresh(page);

    // The shell reaches in through evaluateJavascript, so a global is the
    // interface — a module export would be unreachable from Java.
    expect(await page.evaluate(() => typeof window.rocketmanBack)).toBe('function');
  });

  test('back returns false on the title screen so the app can close', async ({ page }) => {
    await fresh(page);

    // The title screen is the top of the stack. Answering true here would trap
    // the player in an app they cannot leave with the button Fire OS gives them.
    expect(await back(page)).toBe(false);
    await expect(page.locator('#title')).toBeVisible();
  });

  test('back walks the skirmish screen home and then releases', async ({ page }) => {
    await fresh(page);

    await page.tap('#playSkirmish');
    await expect(page.locator('#skirmish')).toBeVisible();

    expect(await back(page)).toBe(true);
    await expect(page.locator('#title')).toBeVisible();

    // And now that we are home again, the next press belongs to the shell.
    expect(await back(page)).toBe(false);
  });

  test('back leaves the briefing, then the campaign', async ({ page }) => {
    await fresh(page);

    await page.tap('#playCampaign');
    await expect(page.locator('#campaign')).toBeVisible();

    await page.locator('.mission').first().tap();
    await expect(page.locator('#briefing')).toBeVisible();

    expect(await back(page)).toBe(true);
    await expect(page.locator('#campaign')).toBeVisible();

    expect(await back(page)).toBe(true);
    await expect(page.locator('#title')).toBeVisible();
  });

  test('back out of a live match abandons it rather than quitting the app', async ({ page }) => {
    const errors = watchErrors(page);
    await fresh(page);

    await page.tap('#playCampaign');
    await page.locator('.mission').first().tap();
    await page.tap('#deployMission');
    await page.waitForFunction(() => typeof window.__rocketman === 'function');
    await expect(page.locator('#game')).toBeVisible();

    // Consumed, so the shell does not close the app mid-mission — and it lands
    // on the campaign screen, which is where Abandon goes.
    expect(await back(page)).toBe(true);
    await expect(page.locator('#campaign')).toBeVisible();

    expect(errors).toEqual([]);
  });

  test('the touch scheme appears on a tablet viewport', async ({ page }) => {
    const errors = watchErrors(page);
    await fresh(page);

    await page.tap('#playCampaign');
    await page.locator('.mission').first().tap();
    await page.tap('#deployMission');
    await page.waitForFunction(() => typeof window.__rocketman === 'function');

    // A campaign mission starts in the cockpit, so the stick is live. On a
    // 1280px-wide landscape screen a width-based check would have decided this
    // was a desktop and handed the player a mouse-only UI.
    await expect(page.locator('#stick')).toBeVisible();
    await expect(page.locator('#touchActions')).toBeVisible();

    expect(errors).toEqual([]);
  });

  test('the idle hint describes touch controls, not a mouse', async ({ page }) => {
    await fresh(page);

    await page.tap('#playSkirmish');
    await page.tap('#start');
    await page.waitForFunction(() => typeof window.__rocketman === 'function');

    // Nothing selected yet, so the selection panel is showing its opening
    // instruction — the first sentence a new player reads. On a Fire tablet
    // there is no left-drag and no right-click to follow.
    const hint = page.locator('#selection .hint').first();
    await expect(hint).toBeVisible();
    await expect(hint).toContainText('Tap');
    await expect(hint).not.toContainText('Right-click');
    await expect(hint).not.toContainText('Left-drag');
  });

  test('the campaign profile survives a reload', async ({ page }) => {
    await fresh(page);

    // Visiting a briefing recruits that mission's pilots into the profile and
    // persists it — the cheapest real write the campaign makes.
    await page.tap('#playCampaign');
    await page.locator('.mission').first().tap();
    await expect(page.locator('#briefing')).toBeVisible();

    const saved = await page.evaluate(() =>
      window.localStorage.getItem('rocketman.profile.v1')
    );
    expect(saved).toBeTruthy();

    await page.reload();
    const afterReload = await page.evaluate(() =>
      window.localStorage.getItem('rocketman.profile.v1')
    );

    // This is the assertion that justifies GameAssetServer existing at all. On
    // a file:// origin the WebView hands the page an opaque origin, this comes
    // back null, and the campaign quietly forgets everything.
    expect(afterReload).toBe(saved);
  });

  test('the battlefield fills a tablet screen without a scrollbar', async ({ page }) => {
    await fresh(page);

    await page.tap('#playCampaign');
    await page.locator('.mission').first().tap();
    await page.tap('#deployMission');
    await page.waitForFunction(() => typeof window.__rocketman === 'function');

    // The shell runs edge to edge with the system bars hidden. A page that
    // overflows would put a scrollbar over the battlefield and eat pan
    // gestures at the margin.
    const overflows = await page.evaluate(() => ({
      x: document.documentElement.scrollWidth > window.innerWidth,
      y: document.documentElement.scrollHeight > window.innerHeight,
    }));
    expect(overflows).toEqual({ x: false, y: false });
  });
});
