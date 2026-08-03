/**
 * The contact form — the browser half of the site's only conversion path.
 *
 * /api/lead is stubbed in every test so nothing here depends on Supabase or a
 * network. What's under test is the script inlined at the bottom of
 * contact.html: what it sends, what it shows, and whether it can be
 * double-submitted.
 */

'use strict';

const { test, expect } = require('@playwright/test');

/** Stub /api/lead with a JSON reply, capturing the request payloads. */
async function stubLead(page, { status = 200, body = { ok: true }, raw } = {}) {
  const requests = [];

  await page.route('**/api/lead', async (route) => {
    requests.push(route.request().postDataJSON());
    await route.fulfill({
      status,
      contentType: raw ? 'text/html' : 'application/json',
      body: raw ?? JSON.stringify(body),
    });
  });

  return requests;
}

async function fillRequired(page, over = {}) {
  const values = { name: 'Dana Reyes', email: 'dana@example.com', ...over };
  await page.fill('#f-name', values.name);
  await page.fill('#f-email', values.email);
}

test.describe('successful submission', () => {
  test('confirms, clears the form, and locks the button against re-sends', async ({ page }) => {
    await stubLead(page);
    await page.goto('/contact');

    await fillRequired(page);
    await page.fill('#f-message', 'We stall the moment price comes up.');
    await page.click('#lead-submit');

    const msg = page.locator('#lead-msg');
    await expect(msg).toHaveClass(/ok/);
    await expect(msg).toContainText('Got it — thanks.');
    await expect(msg).toContainText('calendly.com/negotiatorsondemand/corporate-training');

    // The button deliberately stays disabled so a double-click can't send twice.
    const button = page.locator('#lead-submit');
    await expect(button).toBeDisabled();
    await expect(button).toHaveText('Sent ✓');

    await expect(page.locator('#f-name')).toHaveValue('');
    await expect(page.locator('#f-message')).toHaveValue('');
  });

  test('sends every field the handler reads, plus page and referrer', async ({ page }) => {
    const requests = await stubLead(page);
    await page.goto('/contact?offer=keynote');

    await fillRequired(page);
    await page.fill('#f-phone', '+1 312 555 0142');
    await page.fill('#f-company', 'Acme Corp');
    await page.fill('#f-team', '12 reps');
    await page.fill('#f-timeline', 'Q4 kickoff');
    await page.fill('#f-message', 'Price objections.');
    await page.click('#lead-submit');

    await expect(page.locator('#lead-msg')).toHaveClass(/ok/);
    expect(requests).toHaveLength(1);

    expect(requests[0]).toMatchObject({
      name: 'Dana Reyes',
      email: 'dana@example.com',
      phone: '+1 312 555 0142',
      company: 'Acme Corp',
      team_size: '12 reps',
      timeline: 'Q4 kickoff',
      offer: 'keynote',
      message: 'Price objections.',
      page: '/contact?offer=keynote',
    });
    expect(requests[0]).toHaveProperty('referrer');
  });

  test('sends the honeypot field empty for a real visitor', async ({ page }) => {
    const requests = await stubLead(page);
    await page.goto('/contact');

    await fillRequired(page);
    await page.click('#lead-submit');
    await expect(page.locator('#lead-msg')).toHaveClass(/ok/);

    expect(requests[0].company_website).toBe('');
  });

  test('a double click only produces one request', async ({ page }) => {
    const requests = await stubLead(page);
    await page.goto('/contact');

    await fillRequired(page);
    await page.dblclick('#lead-submit');

    await expect(page.locator('#lead-msg')).toHaveClass(/ok/);
    expect(requests).toHaveLength(1);
  });
});

test.describe('client-side validation', () => {
  test('an empty form is rejected without hitting the network', async ({ page }) => {
    const requests = await stubLead(page);
    await page.goto('/contact');

    await page.click('#lead-submit');

    const msg = page.locator('#lead-msg');
    await expect(msg).toHaveClass(/err/);
    await expect(msg).toHaveText('Name and email are required.');
    expect(requests).toHaveLength(0);
  });

  test('a missing email is rejected', async ({ page }) => {
    const requests = await stubLead(page);
    await page.goto('/contact');

    await page.fill('#f-name', 'Dana Reyes');
    await page.click('#lead-submit');

    await expect(page.locator('#lead-msg')).toHaveClass(/err/);
    expect(requests).toHaveLength(0);
  });

  test('the button stays usable after a validation failure', async ({ page }) => {
    await stubLead(page);
    await page.goto('/contact');

    await page.click('#lead-submit');
    await expect(page.locator('#lead-submit')).toBeEnabled();

    await fillRequired(page);
    await page.click('#lead-submit');
    await expect(page.locator('#lead-msg')).toHaveClass(/ok/);
  });
});

test.describe('failure handling', () => {
  test('surfaces the server error and offers the email fallback', async ({ page }) => {
    await stubLead(page, {
      status: 400,
      body: { ok: false, error: "That email address doesn't look right." },
    });
    await page.goto('/contact');

    await fillRequired(page);
    await page.click('#lead-submit');

    const msg = page.locator('#lead-msg');
    await expect(msg).toHaveClass(/err/);
    await expect(msg).toContainText("That email address doesn't look right.");
    await expect(msg).toContainText('negotiationsondemand@gmail.com');
  });

  test('re-enables the button so the visitor can retry', async ({ page }) => {
    await stubLead(page, { status: 502, body: { ok: false, error: 'Something broke on our end.' } });
    await page.goto('/contact');

    await fillRequired(page);
    await page.click('#lead-submit');

    await expect(page.locator('#lead-msg')).toHaveClass(/err/);
    const button = page.locator('#lead-submit');
    await expect(button).toBeEnabled();
    await expect(button).toHaveText('Send it →');
    // The form must not be cleared on failure, or the visitor has to retype
    // everything they just lost.
    await expect(page.locator('#f-name')).toHaveValue('Dana Reyes');
  });

  test('survives a non-JSON response instead of throwing', async ({ page }) => {
    // The handler is supposed to answer JSON, but a platform-level error page
    // is HTML. The script falls back to the HTTP status.
    await stubLead(page, { status: 502, raw: '<html><body>Bad Gateway</body></html>' });
    await page.goto('/contact');

    await fillRequired(page);
    await page.click('#lead-submit');

    const msg = page.locator('#lead-msg');
    await expect(msg).toHaveClass(/err/);
    await expect(msg).toContainText("didn't go through");
    await expect(msg).toContainText('negotiationsondemand@gmail.com');
  });

  test('a 200 with a non-JSON body is still treated as success', async ({ page }) => {
    await stubLead(page, { status: 200, raw: 'OK' });
    await page.goto('/contact');

    await fillRequired(page);
    await page.click('#lead-submit');

    await expect(page.locator('#lead-msg')).toHaveClass(/ok/);
  });

  test('a dropped connection reports a network error, not silence', async ({ page }) => {
    await page.route('**/api/lead', (route) => route.abort('failed'));
    await page.goto('/contact');

    await fillRequired(page);
    await page.click('#lead-submit');

    const msg = page.locator('#lead-msg');
    await expect(msg).toHaveClass(/err/);
    await expect(msg).toContainText("Network error");
    await expect(page.locator('#lead-submit')).toBeEnabled();
  });
});

test.describe('the ?offer= deep link', () => {
  for (const offer of ['keynote', 'half-day', 'multi-day', 'one-day', 'negotiator-hour']) {
    test(`?offer=${offer} preselects that option`, async ({ page }) => {
      await page.goto(`/contact?offer=${offer}`);
      await expect(page.locator('#f-offer')).toHaveValue(offer);
    });
  }

  test('an unknown offer leaves the default in place', async ({ page }) => {
    await page.goto('/contact?offer=not-a-real-offer');
    await expect(page.locator('#f-offer')).toHaveValue('');
  });

  test('no offer parameter leaves the default in place', async ({ page }) => {
    await page.goto('/contact');
    await expect(page.locator('#f-offer')).toHaveValue('');
  });

  test('the CTA links elsewhere on the site actually land preselected', async ({ page }) => {
    // Walks the real link from /speaking rather than trusting the href.
    await page.goto('/speaking');
    const cta = page.locator('a[href*="contact?offer="]').first();
    const offer = new URL(await cta.getAttribute('href'), 'http://x').searchParams.get('offer');

    await cta.click();
    await expect(page).toHaveURL(new RegExp(`/contact\\?offer=${offer}`));
    await expect(page.locator('#f-offer')).toHaveValue(offer);
  });
});

test.describe('the honeypot', () => {
  test('sits off-screen rather than being display:none', async ({ page }) => {
    // The trap only works if a bot still "sees" a fillable field, so the input
    // must stay rendered. It is pushed out of the viewport instead — asserting
    // toBeHidden() here would be asserting the honeypot is broken.
    await page.goto('/contact');

    const box = await page.locator('#f-hp').boundingBox();
    expect(box, 'the honeypot must remain rendered').not.toBeNull();
    expect(box.x + box.width).toBeLessThan(0);
  });

  test('is kept out of the tab order and the accessibility tree', async ({ page }) => {
    await page.goto('/contact');

    await expect(page.locator('#f-hp')).toHaveAttribute('tabindex', '-1');

    const wrapper = page.locator('#f-hp').locator('xpath=ancestor::div[@aria-hidden="true"]');
    await expect(wrapper).toHaveCount(1);
  });

  test('is never reached by tabbing through the form', async ({ page }) => {
    await page.goto('/contact');
    await page.focus('#f-name');

    for (let i = 0; i < 12; i++) {
      await page.keyboard.press('Tab');
      const id = await page.evaluate(() => document.activeElement && document.activeElement.id);
      expect(id).not.toBe('f-hp');
    }
  });
});
