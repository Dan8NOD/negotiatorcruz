/**
 * Generate the Amazon Appstore listing assets from the game itself.
 *
 * A store listing needs an icon and screenshots, and both are otherwise made by
 * hand: rasterising a logo in some image editor, and thumbing through the game
 * on a tablet with the screenshot chord. Both are also the assets most likely
 * to drift — a listing still showing a HUD from three versions ago is the
 * normal state of an indie store page.
 *
 * So they are generated, from the real game, at the real device resolution,
 * by driving the same Chromium the e2e suite uses. Re-run it after a UI change
 * and the listing is current again.
 *
 *   node rocketman/android/tools/store-assets.mjs
 *
 * Output lands in `rocketman/android/store/`, sized to Amazon's requirements:
 *
 *   icon-512.png          512x512   the listing icon
 *   screenshot-*.png      1920x1200 Fire HD 10 native; Amazon wants 3-10 shots
 *                                   of at least 1024x600 for tablets
 *
 * The one asset this cannot make is the 1024x500 feature graphic, which is a
 * marketing composition rather than a screenshot. See android/README.md.
 */

import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..', '..');
const outDir = join(here, '..', 'store');

const PORT = Number(process.env.PORT) || 4323;
const BASE = `http://127.0.0.1:${PORT}`;
const PAGE = `${BASE}/rocketman/web/rocketman.html`;

/* Fire HD 10 native panel. Screenshots are captured at the real pixel count
 * rather than upscaled, so the HUD is crisp in the listing. */
const DEVICE = { width: 1280, height: 800 };
const SCALE = 1.5; // 1280x800 CSS at dpr 1.5 = 1920x1200 actual

/**
 * The launcher icon at listing size.
 *
 * Deliberately the same geometry as
 * `app/src/main/res/drawable/ic_launcher_foreground.xml`, on the same gradient
 * plate as `ic_launcher_background.xml` — the store icon and the icon on the
 * home screen should not be two different drawings that happen to look alike.
 */
const ICON_SVG = `
<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 108 108">
  <defs>
    <linearGradient id="plate" x1="54" y1="0" x2="54" y2="108" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#16202B"/>
      <stop offset="1" stop-color="#080B10"/>
    </linearGradient>
  </defs>
  <rect width="108" height="108" fill="url(#plate)"/>
  <path d="M54 23.2 L70.8 56.8 L54 68 L37.2 56.8 Z" fill="#4FB3FF"/>
  <path d="M45.6 70.8 L62.4 70.8 L54 84.8 Z" fill="#FF8A4C"/>
</svg>`;

function startServer() {
  const server = spawn('node', ['test/helpers/static-server.js'], {
    cwd: repoRoot,
    env: { ...process.env, PORT: String(PORT) },
    stdio: 'ignore',
  });
  return server;
}

async function waitForServer(page) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const response = await page.request.get(BASE, { timeout: 1000 });
      if (response.ok() || response.status() === 404) return;
    } catch {
      /* not up yet */
    }
    await page.waitForTimeout(250);
  }
  throw new Error(`static server never came up on ${BASE}`);
}

/** Playwright ships a Chromium; some images pre-stage a different revision. */
function preinstalledChromium() {
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (!root || !existsSync(root)) return undefined;
  const candidates = readdirSync(root)
    .filter((d) => /^chromium-\d+$/.test(d))
    .sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]))
    .map((d) => join(root, d, 'chrome-linux', 'chrome'))
    .filter((p) => existsSync(p));
  return candidates[0];
}

async function main() {
  mkdirSync(outDir, { recursive: true });

  const server = startServer();
  const executablePath = preinstalledChromium();
  const browser = await chromium.launch(executablePath ? { executablePath } : {});

  try {
    const context = await browser.newContext({
      viewport: DEVICE,
      deviceScaleFactor: SCALE,
      isMobile: true,
      hasTouch: true,
    });
    const page = await context.newPage();
    await waitForServer(page);

    /* ------------------------------------------------------------- icon -- */

    const iconPage = await browser.newPage({ viewport: { width: 512, height: 512 } });
    await iconPage.setContent(
      `<body style="margin:0">${ICON_SVG}</body>`,
      { waitUntil: 'load' }
    );
    const icon = await iconPage.locator('svg').screenshot({ omitBackground: false });
    writeFileSync(join(outDir, 'icon-512.png'), icon);
    await iconPage.close();
    console.log('icon-512.png');

    /* ------------------------------------------------------ screenshots -- */

    const shot = async (name) => {
      const buffer = await page.screenshot();
      writeFileSync(join(outDir, `screenshot-${name}.png`), buffer);
      console.log(`screenshot-${name}.png`);
    };

    await page.goto(PAGE);
    await page.evaluate(() => window.localStorage.clear());
    await page.reload();
    await page.locator('#title').waitFor({ state: 'visible' });
    await shot('1-title');

    await page.tap('#playCampaign');
    await page.locator('#campaign').waitFor({ state: 'visible' });
    await shot('2-campaign');

    await page.locator('.mission').first().tap();
    await page.locator('#briefing').waitFor({ state: 'visible' });
    await shot('3-briefing');

    await page.tap('#deployMission');
    await page.waitForFunction(() => typeof window.__rocketman === 'function');
    // Let the mission actually start moving: a screenshot of tick zero is three
    // machines standing still on an empty map, which sells nothing.
    await page.waitForTimeout(9000);
    await shot('4-mission');

    // Skirmish reaches a built-up base far faster than the campaign does, and
    // a base with a power grid is what a screenshot of an RTS should show.
    await page.goto(PAGE);
    await page.locator('#title').waitFor({ state: 'visible' });
    await page.tap('#playSkirmish');
    await page.locator('#skirmish').waitFor({ state: 'visible' });
    await page.tap('#start');
    await page.waitForFunction(() => typeof window.__rocketman === 'function');
    await page.waitForTimeout(25000);
    await shot('5-skirmish');

    await context.close();
  } finally {
    await browser.close();
    server.kill();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
