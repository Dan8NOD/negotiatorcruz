/**
 * Playwright configuration for Rocketman's browser suite.
 *
 * Deliberately separate from the site's `playwright.config.js`. The game is a
 * side project staged in this repository (see rocketman/README.md); folding its
 * specs into the site's `testDir` would make negotiatorcruz.com's CI fail
 * because a mech pathed badly, which is not a trade anyone should accept.
 *
 * It reuses the site's static server because that server already serves the
 * whole repository root, so `/rocketman/web/rocketman.html` and its relative
 * ES-module imports resolve exactly as they would from a plain file host.
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
const PORT = Number(process.env.PORT) || 4322;
const launchOptions = executablePath ? { launchOptions: { executablePath } } : {};

module.exports = defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  // A real-time game needs wall-clock time to prove anything happened.
  timeout: 90_000,
  reporter: process.env.CI ? [['list']] : 'list',

  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    viewport: { width: 1440, height: 900 },
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    ...launchOptions,
  },

  projects: [
    {
      name: 'chromium',
      // The viewport goes *after* the device preset. Spreading Desktop Chrome
      // last would silently reinstate its 1280×720 and quietly discard the
      // size above — which changes where every canvas click lands.
      use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 }, ...launchOptions },
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
