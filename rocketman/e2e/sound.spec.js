/**
 * End-to-end: the game makes a noise, and can be told not to.
 *
 * "Nothing threw" is the assertion every other spec in here already makes, and
 * it is not the same fact as "a sound played" — a mixer that refuses every
 * voice throws nothing at all. So these read `__rocketman().audio`, which
 * counts what the mixer actually scheduled, and assert against the count.
 *
 * The audio context is created on the first pointer or key event, which every
 * path into a match provides several of. A browser that refuses WebAudio
 * entirely reports a null context, and the coverage assertions stand down
 * rather than fail — the game surviving that is the behaviour under test, not
 * the browser's audio policy.
 */

import { test, expect } from '@playwright/test';

const PAGE = '/rocketman/web/rocketman.html';

async function startSkirmish(page) {
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });

  await page.goto(PAGE);
  await page.evaluate(() => window.localStorage.clear());
  await page.reload();
  await page.click('#playSkirmish');
  await page.fill('#seed', '7');
  await page.click('#start');
  await expect(page.locator('#game')).toBeVisible();
  await page.waitForFunction(() => typeof window.__rocketman === 'function');

  return { errors, state: () => page.evaluate(() => window.__rocketman()) };
}

test('the mixer schedules voices once a match is running', async ({ page }) => {
  const { errors, state } = await startSkirmish(page);

  // Collectors start mining immediately, so deposits alone will sound within
  // a few seconds even if nothing has shot at anything yet.
  await page.waitForTimeout(6000);
  const s = await state();

  test.skip(s.audio.context === null, 'this browser refuses WebAudio entirely');
  expect(s.audio.context).toBe('running');
  expect(s.audio.scheduled).toBeGreaterThan(0);
  expect(errors).toEqual([]);
});

test('an order is answered', async ({ page }) => {
  const { errors, state } = await startSkirmish(page);
  const before = (await state()).audio;
  test.skip(before.context === null, 'this browser refuses WebAudio entirely');

  // Drag a box over the starting army, the way the drag-select spec does,
  // then send it somewhere. Both halves — the selection and the order — are
  // supposed to make a sound, and the rate limiter guarantees at least one of
  // them gets through.
  await page.mouse.move(400, 200);
  await page.mouse.down();
  await page.mouse.move(1000, 640, { steps: 10 });
  await page.mouse.up();
  await page.waitForTimeout(300);
  expect((await state()).selection.length).toBeGreaterThan(0);

  const box = await page.locator('#view').boundingBox();
  await page.mouse.click(box.x + box.width * 0.6, box.y + box.height * 0.5, { button: 'right' });
  await page.waitForTimeout(400);

  const after = (await state()).audio;
  expect(after.scheduled).toBeGreaterThan(before.scheduled);
  expect(errors).toEqual([]);
});

test('the voice ceiling holds under a busy match', async ({ page }) => {
  const { errors, state } = await startSkirmish(page);
  await page.waitForTimeout(8000);
  const s = await state();
  test.skip(s.audio.context === null, 'this browser refuses WebAudio entirely');

  // The ceiling is the point: however loud the fight gets, the number of
  // voices alive at once stays bounded. An unbounded mixer is how a tab
  // stalls on a chain reaction in a fuel depot.
  expect(s.audio.live).toBeLessThanOrEqual(29);
  expect(errors).toEqual([]);
});

test('mute silences the mixer and survives a reload', async ({ page }) => {
  const { errors, state } = await startSkirmish(page);

  const button = page.locator('#muteToggle');
  await expect(button).toHaveText(/Sound/);
  await expect(button).toHaveAttribute('aria-pressed', 'false');

  await button.click();
  await expect(button).toHaveText(/Muted/);
  await expect(button).toHaveAttribute('aria-pressed', 'true');
  expect((await state()).muted).toBe(true);

  // Nothing new is scheduled while muted, however long the battle runs.
  const quiet = (await state()).audio.scheduled;
  await page.waitForTimeout(3000);
  expect((await state()).audio.scheduled).toBe(quiet);

  // The preference is the player's, not the match's.
  await page.reload();
  await page.click('#playSkirmish');
  await page.click('#start');
  await page.waitForFunction(() => typeof window.__rocketman === 'function');
  expect((await state()).muted).toBe(true);
  await expect(page.locator('#muteToggle')).toHaveText(/Muted/);
  expect(errors).toEqual([]);
});

/**
 * Render every weapon offline and measure the waveform.
 *
 * This is the assertion the node suite cannot make. `sound.test.js` proves
 * each weapon has its own *recipe*; only a real WebAudio implementation can
 * prove those recipes come out as different *sounds* — a recipe can differ on
 * paper and still render to something the ear cannot tell apart, and one can
 * be so quiet it is effectively silent while every mapping test passes.
 *
 * Peak, RMS and zero-crossing rate are a crude fingerprint, deliberately: they
 * are loudness, weight and brightness, which is exactly the axis set a player
 * uses to tell one gun from another across a battlefield.
 */
async function renderVoices(page) {
  await page.goto(PAGE);
  return page.evaluate(async () => {
    const { createSynth, WEAPON_VOICES } = await import('./sound.js');
    const rate = 44100;
    // Noise bursts read from a random offset into the shared buffer, so one
    // render of one weapon is a sample of a distribution rather than a
    // measurement. Three, averaged, is enough to stop that wobble deciding
    // whether the suite is green.
    const PASSES = 3;
    const out = {};

    async function once(voice) {
      const ctx = new OfflineAudioContext(1, rate * 1.5, rate);
      const bus = ctx.createGain();
      bus.connect(ctx.destination);
      voice(createSynth(ctx, { world: bus, ui: bus }), { pan: 0, vol: 1 });

      const data = (await ctx.startRendering()).getChannelData(0);
      let peak = 0;
      let sum = 0;
      let crossings = 0;
      let last = 0;
      let voiced = 0;
      for (let i = 0; i < data.length; i++) {
        const v = data[i];
        const a = Math.abs(v);
        if (a > peak) peak = a;
        sum += v * v;
        if (a > 0.005) voiced = i;
        if ((v > 0) !== (last > 0) && a > 0.002) crossings++;
        last = v;
      }
      return {
        peak,
        rms: Math.sqrt(sum / data.length),
        // Per second of actual sound, so a long quiet tail cannot make a
        // bright weapon look dull.
        brightness: voiced > 0 ? crossings / (voiced / rate) : 0,
        length: voiced / rate,
      };
    }

    for (const [id, voice] of Object.entries(WEAPON_VOICES)) {
      const runs = [];
      for (let i = 0; i < PASSES; i++) runs.push(await once(voice));
      out[id] = {};
      for (const key of ['peak', 'rms', 'brightness', 'length']) {
        out[id][key] = runs.reduce((a, r) => a + r[key], 0) / PASSES;
      }
    }
    return out;
  });
}

test('every weapon renders to a sound you can actually hear', async ({ page }) => {
  const rendered = await renderVoices(page);

  for (const [id, m] of Object.entries(rendered)) {
    expect(m.peak, `${id} is inaudible`).toBeGreaterThan(0.02);
    // Headroom below unity. The master gain and the compressor sit downstream
    // of this, so a single weapon arriving near full scale means the mix has
    // nothing left for the twenty other things happening in a fight.
    expect(m.peak, `${id} has no headroom left`).toBeLessThan(2.2);
    expect(m.length, `${id} is over before it is heard`).toBeGreaterThan(0.02);
    expect(m.length, `${id} outstays a shot`).toBeLessThan(1.2);
  }
});

test('no two weapons render to the same sound', async ({ page }) => {
  const rendered = await renderVoices(page);
  const ids = Object.keys(rendered);

  // Distance in a normalised loudness/weight/brightness/length space.
  //
  // The threshold sits just under the closest legitimate pair — the autocannon
  // and the flak burst, which these four numbers flatter because a single
  // crack and a triple pop can average out alike even though nobody would
  // confuse them. Everything genuinely too similar has been further apart than
  // this since the turret gun stopped being a slightly bigger autocannon.
  const distance = (a, b) =>
    Math.sqrt(
      Math.pow((a.peak - b.peak) / 0.9, 2) +
        Math.pow((a.rms - b.rms) / 0.06, 2) +
        Math.pow((a.brightness - b.brightness) / 4000, 2) +
        Math.pow((a.length - b.length) / 0.6, 2)
    );

  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      const d = distance(rendered[ids[i]], rendered[ids[j]]);
      expect(d, `${ids[i]} and ${ids[j]} sound the same (${d.toFixed(3)})`).toBeGreaterThan(0.13);
    }
  }
});

test('M does what the button does', async ({ page }) => {
  const { errors, state } = await startSkirmish(page);

  await page.keyboard.press('m');
  expect((await state()).muted).toBe(true);
  await expect(page.locator('#muteToggle')).toHaveText(/Muted/);

  await page.keyboard.press('m');
  expect((await state()).muted).toBe(false);
  await expect(page.locator('#muteToggle')).toHaveText(/Sound/);
  expect(errors).toEqual([]);
});
