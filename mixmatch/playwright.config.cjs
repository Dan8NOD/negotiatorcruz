/**
 * Playwright configuration for the Mix & Match browser suite.
 *
 * Deliberately separate from the site's `playwright.config.js`, for the same
 * reason rocketman's is: mixmatch/ is a product staged in this repository, and
 * folding its specs into the site's testDir would let a game bug turn
 * negotiatorcruz.com's build red.
 *
 * Why this suite exists at all, when the engine already has 48 unit tests: the
 * first real bug the Timer tab shipped was `.mmt-over{display:flex}` beating
 * the `hidden` attribute, so "Round over" sat on top of a live game. The
 * engine was perfect; the page was wrong. Only a browser can catch that class
 * of bug, so the page gets a browser watching it.
 *
 * Reuses the site's static server, which serves the repository root, so
 * `/mixmatch/web/timer-tab.html` and its ES-module import resolve exactly as
 * they would on a plain static host.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { defineConfig, devices } = require('@playwright/test');

/**
 * Some CI images ship a pre-downloaded Chromium whose revision doesn't match
 * the one this Playwright version expects. Fall back to whatever build is
 * actually on disk rather than failing to launch. Mirrors the root config.
 */
function preinstalledChromium() {
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (!root || !fs.existsSync(root)) return undefined;

  const candidates = fs
    .readdirSync(root)
    .filter((d) => /^chromium-\d+$/.test(d))
    .sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]))
    .map((d) => path.join(root, d, 'chrome-linux', 'chrome'))
    .filter((p) => fs.existsSync(p));

  return candidates[0];
}

const executablePath = preinstalledChromium();
const PORT = Number(process.env.PORT) || 4323;
const launchOptions = executablePath ? { launchOptions: { executablePath } } : {};

module.exports = defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  // Rounds are played in real time; a 1-minute drill needs a minute.
  timeout: 120_000,
  reporter: process.env.CI ? [['list']] : 'list',

  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    ...launchOptions,
  },

  projects: [
    {
      // The shipping target is a tablet, so the suite runs at iPad Pro 11"
      // logical size with touch on — not at a desktop default that no real
      // user of this tab will ever have.
      name: 'ipad',
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 834, height: 1194 },
        deviceScaleFactor: 2,
        hasTouch: true,
        ...launchOptions,
      },
    },
  ],

  webServer: {
    command: 'node test/helpers/static-server.js',
    cwd: path.resolve(__dirname, '..'),
    url: `http://127.0.0.1:${PORT}`,
    reuseExistingServer: !process.env.CI,
    stdout: 'ignore',
    env: { PORT: String(PORT) },
  },
});
