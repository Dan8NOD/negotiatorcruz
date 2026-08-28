/**
 * Browser suite for the Timer tab.
 *
 * The engine's 48 unit tests prove the simulation; none of them can see the
 * page. The first real bug this tab shipped was CSS — `.mmt-over{display:flex}`
 * beating the `hidden` attribute, so "Round over" sat on top of a live game
 * while every unit test stayed green. This suite exists to catch that class of
 * bug, so it deliberately tests through the page: real clicks, real frames,
 * real pixels.
 *
 * It runs against BOTH deliverables:
 *   - /mixmatch/web/timer-tab.html — the module source developers edit
 *   - /mixmatch/ios/MixMatch.swiftpm/Resources/index.html — the generated page
 *     the iPad app actually ships
 * A bug in the build script that broke only the generated artifact would pass
 * every test that looked at the source.
 */

'use strict';

const { test, expect } = require('@playwright/test');

const PAGES = [
  { name: 'module source', url: '/mixmatch/web/timer-tab.html' },
  { name: 'iPad app page', url: '/mixmatch/ios/MixMatch.swiftpm/Resources/index.html' },
];

/** Gold shot pixels in the top half of the field. The tank also turns gold
 *  while firing, but the tank lives in the bottom tenth — anything gold up
 *  high is a shot in flight, which is the observable truth of "the gun ran". */
async function shotPixelsAloft(page) {
  return page.locator('#mmt-canvas').evaluate((c) => {
    const ctx = c.getContext('2d');
    const d = ctx.getImageData(0, 0, c.width, Math.floor(c.height / 2)).data;
    let hits = 0;
    for (let i = 0; i < d.length; i += 4) {
      // #c9a84c ±12 per channel
      if (Math.abs(d[i] - 201) < 12 && Math.abs(d[i + 1] - 168) < 12 && Math.abs(d[i + 2] - 76) < 12) hits++;
    }
    return hits;
  });
}

async function startArcadeDrill(page) {
  await page.click('.mmt-preset[data-preset="drill"]');
  await page.click('.mmt-mode[data-mode="arcade"]');
  await page.click('#mmt-go');
}

for (const { name, url } of PAGES) {
  test.describe(name, () => {
    test.beforeEach(async ({ page }) => {
      const errors = [];
      page.on('pageerror', (e) => errors.push(e.message));
      page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
      page.errors = errors;
      await page.goto(url);
    });

    test.afterEach(async ({ page }) => {
      expect(page.errors, 'the page must load and run without console errors').toEqual([]);
    });

    test('the end-of-round overlay is not visible during a live round', async ({ page }) => {
      // THE regression. `hidden` lost to `display:flex` once already.
      await expect(page.locator('#mmt-over')).toBeHidden();
      await startArcadeDrill(page);
      await page.waitForTimeout(2500);
      await expect(page.locator('#mmt-over')).toBeHidden();
      await expect(page.locator('#mmt-clock')).not.toHaveText('1:00');
    });

    test('nothing fires until a finger is down, and firing stops when it lifts', async ({ page }) => {
      await startArcadeDrill(page);
      await page.waitForTimeout(1200);
      expect(await shotPixelsAloft(page), 'idle trigger must put nothing in the air').toBe(0);

      const box = await page.locator('#mmt-canvas').boundingBox();
      await page.mouse.move(box.x + box.width / 2, box.y + box.height * 0.8);
      await page.mouse.down();
      await page.waitForTimeout(700);
      expect(await shotPixelsAloft(page), 'a held trigger must fire').toBeGreaterThan(0);

      await page.mouse.up();
      // Longest flight from the barrel to off-screen is under a second.
      await page.waitForTimeout(1300);
      expect(await shotPixelsAloft(page), 'released trigger: the sky empties and stays empty').toBe(0);
    });

    test('the clock counts, holds on pause, and survives the pause untouched', async ({ page }) => {
      await page.click('.mmt-preset[data-preset="stage"]');
      await expect(page.locator('#mmt-clock')).toHaveText('3:00');
      await page.click('#mmt-go');
      await expect(page.locator('#mmt-clock')).not.toHaveText('3:00');

      await page.click('#mmt-go'); // pause
      await expect(page.locator('#mmt-go')).toHaveText('Resume');
      const held = await page.locator('#mmt-clock').textContent();
      await page.waitForTimeout(1500);
      await expect(page.locator('#mmt-clock')).toHaveText(held);

      await page.click('#mmt-go'); // resume
      await expect(page.locator('#mmt-clock')).not.toHaveText(held);
    });

    test('timer mode shows no battlefield', async ({ page }) => {
      await expect(page.locator('#mmt-field')).toBeHidden();
      await page.click('.mmt-mode[data-mode="arcade"]');
      await expect(page.locator('#mmt-field')).toBeVisible();
      await page.click('.mmt-mode[data-mode="timer"]');
      await expect(page.locator('#mmt-field')).toBeHidden();
    });

    test('preset and mode survive a reload', async ({ page }) => {
      await page.click('.mmt-preset[data-preset="session"]');
      await page.click('.mmt-mode[data-mode="arcade"]');
      await page.reload();
      await expect(page.locator('.mmt-preset[data-preset="session"]')).toHaveClass(/on/);
      await expect(page.locator('.mmt-mode[data-mode="arcade"]')).toHaveClass(/on/);
      await expect(page.locator('#mmt-clock')).toHaveText('12:00');
    });

    test('best scores are kept per round length, not globally', async ({ page }) => {
      // Seed two bests directly; the display logic is what's under test, and
      // earning a 12-minute best honestly would take 12 minutes.
      await page.evaluate(() => {
        localStorage.setItem('mm.timer.v1', JSON.stringify({
          mode: 'arcade', presetId: 'drill', bests: { drill: 120, session: 4200 },
        }));
      });
      await page.reload();
      await expect(page.locator('#mmt-foot')).toContainText('Best: 120');
      await page.click('.mmt-preset[data-preset="session"]');
      await expect(page.locator('#mmt-foot')).toContainText('Best: 4200');
      await page.click('.mmt-preset[data-preset="stage"]');
      await expect(page.locator('#mmt-foot')).toContainText('Best: 0');
    });

    test('switching away mid-round pauses instead of burning the clock', async ({ page }) => {
      await startArcadeDrill(page);
      await page.waitForTimeout(1200);
      await page.evaluate(() => window.MMTimerTab.onHide());
      await expect(page.locator('#mmt-go')).toHaveText('Resume');
      const held = await page.locator('#mmt-clock').textContent();
      await page.waitForTimeout(1500);
      await expect(page.locator('#mmt-clock')).toHaveText(held);
    });
  });
}

/*
 * Pomodoro.
 *
 * Driven with Playwright's clock rather than by waiting out 25 real minutes,
 * and with `fastForward` rather than `runFor`: fast-forwarding fires one
 * animation frame with a jumped timestamp, which is both fast and the exact
 * code path a backgrounded iPad takes. `runFor` would fire all 90,000
 * intervening frames and time out.
 *
 * Run against the generated page only. The cycle logic has 29 unit tests; what
 * needs a browser is that the page is *wired* to it — that the chip, the pips,
 * the buttons and the clock say what the machine says.
 */
test.describe('pomodoro', () => {
  test.beforeEach(async ({ page }) => {
    await page.clock.install();
    await page.goto(PAGES[1].url);
    await page.click('.mmt-mode[data-mode="pomodoro"]');
  });

  test('hides the round presets, which it does not use', async ({ page }) => {
    // 25/5/15 is the technique, not a preference. Four buttons that silently
    // do nothing would be worse than none.
    await expect(page.locator('#mmt-presets')).toBeHidden();
    await expect(page.locator('#mmt-pom')).toBeVisible();
    await expect(page.locator('#mmt-phase')).toHaveText('Focus');
    await expect(page.locator('#mmt-clock')).toHaveText('25:00');
    await expect(page.locator('.mmt-pip')).toHaveCount(4);
  });

  test('runs a whole set: three short breaks, then a long one', async ({ page }) => {
    await page.click('#mmt-go');
    const phases = [];

    for (let i = 0; i < 4; i++) {
      await page.clock.fastForward('26:00');                     // focus completes
      phases.push((await page.locator('#mmt-phase').textContent()).trim());
      await expect(page.locator('.mmt-pip.done')).toHaveCount(i + 1);
      // A break starts itself — rest is not something to forget to take.
      await expect(page.locator('#mmt-go')).toHaveText('Pause');

      await page.clock.fastForward(i === 3 ? '16:00' : '06:00'); // break completes
      // The next focus never starts itself.
      await expect(page.locator('#mmt-go')).toHaveText('Start next focus');
      await expect(page.locator('#mmt-clock')).toHaveText('25:00');
      if (i < 3) await page.click('#mmt-go');
    }

    expect(phases).toEqual(['Break', 'Break', 'Break', 'Long break']);
    // The set starts over.
    await expect(page.locator('.mmt-pip.done')).toHaveCount(0);
  });

  test('a break can be skipped; a focus can only be voided', async ({ page }) => {
    await expect(page.locator('#mmt-skip')).toBeHidden();
    await page.click('#mmt-go');
    await expect(page.locator('#mmt-skip')).toBeHidden();
    await expect(page.locator('#mmt-reset')).toHaveText('Void');

    await page.clock.fastForward('26:00');
    await expect(page.locator('#mmt-skip')).toBeVisible();
    await page.click('#mmt-skip');

    await expect(page.locator('#mmt-phase')).toHaveText('Focus');
    await expect(page.locator('#mmt-go')).toHaveText('Start next focus');
    await expect(page.locator('.mmt-pip.done')).toHaveCount(1);
  });

  test('voiding a focus does not bank it', async ({ page }) => {
    // The rule that makes the count worth anything.
    await page.click('#mmt-go');
    await page.clock.fastForward('24:00');
    await expect(page.locator('.mmt-pip.done')).toHaveCount(0);

    await page.click('#mmt-reset');
    await expect(page.locator('#mmt-clock')).toHaveText('25:00');
    await expect(page.locator('#mmt-phase')).toHaveText('Focus');
    await expect(page.locator('.mmt-pip.done')).toHaveCount(0);
    await expect(page.locator('#mmt-go')).toHaveText('Start');
  });

  test('leaving the tab does not pause a pomodoro', async ({ page }) => {
    // Deliberately unlike the round timer. A kitchen timer does not stop
    // because you turned around, and the 25 minutes are the point.
    await page.click('#mmt-go');
    await page.clock.fastForward('05:00');
    const before = await page.locator('#mmt-clock').textContent();

    await page.evaluate(() => window.MMTimerTab.onHide());
    await page.clock.fastForward('05:00');
    await expect(page.locator('#mmt-clock')).not.toHaveText(before);
    await expect(page.locator('#mmt-go')).toHaveText('Pause');
  });

  test('pausing holds the clock without voiding the pomodoro', async ({ page }) => {
    await page.click('#mmt-go');
    await page.clock.fastForward('05:00');
    await page.click('#mmt-go');
    await expect(page.locator('#mmt-go')).toHaveText('Resume');

    const held = await page.locator('#mmt-clock').textContent();
    await page.clock.fastForward('10:00');
    await expect(page.locator('#mmt-clock')).toHaveText(held);

    await page.click('#mmt-go');
    await page.clock.fastForward('21:00');
    await expect(page.locator('.mmt-pip.done')).toHaveCount(1);
  });

  test('the mode survives a reload', async ({ page }) => {
    await page.reload();
    await expect(page.locator('.mmt-mode[data-mode="pomodoro"]')).toHaveClass(/on/);
    await expect(page.locator('#mmt-clock')).toHaveText('25:00');
    await expect(page.locator('#mmt-presets')).toBeHidden();
  });
});

// One full round, played to the buzzer, on the artifact the iPad ships. Run
// once rather than per-page: it costs a real minute, and the round-end path is
// identical generated code on both pages.
test('a one-minute drill runs to the buzzer and ends itself', async ({ page }) => {
  await page.goto(PAGES[1].url);
  await startArcadeDrill(page);

  const box = await page.locator('#mmt-canvas').boundingBox();
  await page.mouse.move(box.x + box.width * 0.4, box.y + box.height * 0.8);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.6, box.y + box.height * 0.8, { steps: 10 });
  await page.mouse.up();

  await expect(page.locator('#mmt-over')).toBeVisible({ timeout: 70_000 });
  await expect(page.locator('#mmt-clock')).toHaveText('0:00');
  await expect(page.locator('#mmt-over-body')).toContainText('Score');
  await expect(page.locator('#mmt-go')).toHaveText('Start');

  // "Go again" must produce a fresh, running round.
  await page.click('#mmt-again');
  await expect(page.locator('#mmt-over')).toBeHidden();
  await expect(page.locator('#mmt-go')).toHaveText('Pause');
});
