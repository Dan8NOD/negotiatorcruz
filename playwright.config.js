/**
 * Playwright configuration for the end-to-end suite.
 *
 * The site has no build step, so the suite runs against the real files via
 * test/helpers/static-server.js, which reproduces Vercel's `cleanUrls`
 * routing. Nothing here talks to Supabase — /api/lead is stubbed per test with
 * page.route(), so the e2e layer covers the browser half of the form and the
 * unit suite covers the server half.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { defineConfig, devices } = require('@playwright/test');

/**
 * Some CI images ship a pre-downloaded Chromium whose revision doesn't match
 * the one this Playwright version expects. When that happens, fall back to
 * whatever build is actually on disk instead of failing to launch. On a normal
 * machine (or after `npx playwright install`) this returns undefined and
 * Playwright picks its own browser.
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
const PORT = Number(process.env.PORT) || 4321;

module.exports = defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 2 : undefined,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',

  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    ...(executablePath ? { launchOptions: { executablePath } } : {}),
  },

  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'], ...(executablePath ? { launchOptions: { executablePath } } : {}) },
    },
  ],

  webServer: {
    command: `node test/helpers/static-server.js`,
    url: `http://127.0.0.1:${PORT}`,
    reuseExistingServer: !process.env.CI,
    stdout: 'ignore',
    env: { PORT: String(PORT) },
  },
});
