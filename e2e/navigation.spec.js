/**
 * Mobile navigation and the scroll-reveal fallback (assets/site.js).
 *
 * The nav is the only interactive widget on five of the six pages, and its
 * whole accessibility contract — aria-expanded, Escape, focus return — lives
 * in JavaScript with nothing asserting it.
 */

'use strict';

const { test, expect } = require('@playwright/test');

const ROUTES = ['/', '/system', '/speaking', '/academy', '/about', '/contact'];

test.describe('mobile nav', () => {
  // .nav-toggle only appears under the 900px breakpoint in site.css.
  test.use({ viewport: { width: 390, height: 844 } });

  test('opens and closes on tap, tracking aria-expanded', async ({ page }) => {
    await page.goto('/');

    const toggle = page.locator('.nav-toggle');
    const links = page.locator('.nav-links');

    await expect(toggle).toBeVisible();
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(links).toBeHidden();

    await toggle.click();
    await expect(links).toBeVisible();
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await expect(toggle).toHaveText('✕');

    await toggle.click();
    await expect(links).toBeHidden();
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(toggle).toHaveText('☰');
  });

  test('closes after following a link, so the panel never covers the target', async ({ page }) => {
    await page.goto('/');

    await page.locator('.nav-toggle').click();
    await expect(page.locator('.nav-links')).toBeVisible();

    await page.locator('.nav-links a[href="/about"]').click();
    await expect(page).toHaveURL(/\/about$/);
    await expect(page.locator('.nav-toggle')).toHaveAttribute('aria-expanded', 'false');
  });

  test('Escape closes the menu and returns focus to the toggle', async ({ page }) => {
    await page.goto('/');

    const toggle = page.locator('.nav-toggle');
    await toggle.click();
    await expect(page.locator('.nav-links')).toBeVisible();

    await page.keyboard.press('Escape');

    await expect(page.locator('.nav-links')).toBeHidden();
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(toggle).toBeFocused();
  });

  test('Escape does nothing when the menu is already closed', async ({ page }) => {
    await page.goto('/');

    await page.keyboard.press('Escape');
    await expect(page.locator('.nav-links')).toBeHidden();
    await expect(page.locator('.nav-toggle')).toHaveAttribute('aria-expanded', 'false');
  });

  test('every page ships a working toggle', async ({ page }) => {
    for (const route of ROUTES) {
      await page.goto(route);
      const toggle = page.locator('.nav-toggle');

      await expect(toggle, `${route} has no visible nav toggle`).toBeVisible();
      await toggle.click();
      await expect(page.locator('.nav-links'), `${route} nav did not open`).toBeVisible();
    }
  });
});

test.describe('desktop nav', () => {
  test('shows the links inline and hides the hamburger', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto('/');

    await expect(page.locator('.nav-toggle')).toBeHidden();
    await expect(page.locator('.nav-links')).toBeVisible();
  });
});

test.describe('site navigation', () => {
  test('every nav link reaches a real page', async ({ page }) => {
    await page.goto('/');

    const hrefs = await page
      .locator('.nav-links a[href^="/"]')
      .evaluateAll((els) => els.map((e) => e.getAttribute('href')));

    expect(hrefs.length).toBeGreaterThan(0);

    for (const href of hrefs) {
      const response = await page.goto(href);
      expect(response.status(), `${href} did not return 200`).toBe(200);
      await expect(page.locator('h1')).toBeVisible();
    }
  });

  test('the deployed security headers are present on every route', async ({ page }) => {
    for (const route of ROUTES) {
      const response = await page.goto(route);
      const headers = response.headers();

      expect(headers['x-content-type-options'], route).toBe('nosniff');
      expect(headers['x-frame-options'], route).toBe('SAMEORIGIN');
      expect(headers['referrer-policy'], route).toBe('strict-origin-when-cross-origin');
    }
  });

  test('an unknown route 404s rather than serving a page', async ({ page }) => {
    const response = await page.goto('/definitely-not-a-page');
    expect(response.status()).toBe(404);
  });
});

test.describe('scroll reveal', () => {
  test('content becomes visible once scrolled into view', async ({ page }) => {
    await page.goto('/system');

    const revealed = page.locator('.rv.in').first();
    await expect(revealed).toBeVisible();
  });

  test('reduced motion shows everything immediately', async ({ page }) => {
    // The guard in site.js matters: without it, a reduced-motion visitor whose
    // IntersectionObserver never fires would see a blank page.
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto('/system');

    const counts = await page.evaluate(() => ({
      total: document.querySelectorAll('.rv').length,
      shown: document.querySelectorAll('.rv.in').length,
    }));

    expect(counts.total).toBeGreaterThan(0);
    expect(counts.shown).toBe(counts.total);
  });

  test('no pointer-glow layer is injected under reduced motion', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto('/');

    // site.js returns early before creating the glow element.
    const injected = await page.evaluate(
      () => [...document.body.children].filter((el) => el.tagName === 'DIV' && el.style.borderRadius === '50%').length
    );
    expect(injected).toBe(0);
  });
});

test.describe('no-JavaScript fallback', () => {
  test.use({ javaScriptEnabled: false });

  test('the pages still render their content', async ({ page }) => {
    for (const route of ROUTES) {
      await page.goto(route);
      await expect(page.locator('h1'), `${route} rendered nothing without JS`).toBeVisible();
      await expect(page.locator('.footer')).toBeVisible();
    }
  });
});
