/**
 * NOD Tank Shooter — the loop and the shell around it.
 *
 * Three responsibilities and no more: run the fixed-timestep loop, keep the
 * HUD in step with the world, and hand a finished run to whoever is listening.
 *
 * ## The token hook
 *
 * This game does not know what a token is, does not talk to a balance, and has
 * no auth. It announces a finished run on `window.__nodArcade` and stops
 * caring. Whatever embeds it — the Mix & Match arcade, a static page, a test —
 * decides whether that costs anything.
 *
 * That is deliberate. `mixmatch/config/tokens.js` already says an arcade play
 * is one token and `arcade_play` is still 'planned'; a game that reached for a
 * balance itself would be a second place where that price lives, and the whole
 * point of that module is that there is exactly one.
 */

import { createWorld, step, runResult } from '../engine/sim.js';
import { TICKS_PER_SECOND, TANK, GUNS, WAVES } from '../engine/content.js';
import { createRenderer } from './render.js';
import { createInput } from './input.js';

const MS_PER_TICK = 1000 / TICKS_PER_SECOND;
const $ = (id) => document.getElementById(id);

const canvas = $('arena');
const renderer = createRenderer(canvas);
const input = createInput(canvas, renderer);

let run = null;

/* ==================================================================== the run */

function startRun(seed) {
  if (run) stopRun();

  const world = createWorld({ seed });
  const active = { world, stopped: false, last: performance.now(), accumulator: 0 };
  run = active;

  input.attach();
  // Show first, measure second. A hidden element has no layout, so sizing the
  // canvas before revealing it gives a width of zero — which produces a zoom
  // of zero, an arena scaled to nothing, and a game that runs perfectly while
  // drawing an empty screen. Nothing throws, so only a screenshot finds it.
  show('game');
  renderer.resize();

  function frame(now) {
    if (active.stopped) return;

    let elapsed = now - active.last;
    active.last = now;
    // A tab that was in the background hands back a gap of minutes. Simulating
    // it would spawn twenty waves into an empty arena and end the run before
    // the player has looked at it; clamping loses time, which is correct.
    if (elapsed > 250) elapsed = 250;
    active.accumulator += elapsed;

    while (active.accumulator >= MS_PER_TICK && !world.over) {
      step(world, input.read(world));
      renderer.consumeEvents(world.events);
      active.accumulator -= MS_PER_TICK;
    }

    renderer.draw(world, Math.min(elapsed, 100) / 1000);
    drawOverlay(world);
    updateHud(world);

    if (world.over) {
      finish(world);
      return;
    }
    requestAnimationFrame(frame);
  }

  requestAnimationFrame(frame);
}

function stopRun() {
  if (!run) return;
  run.stopped = true;
  input.detach();
  run = null;
}

function finish(world) {
  const result = runResult(world);
  stopRun();

  $('finalScore').textContent = result.score.toLocaleString('en-US');
  $('finalWave').textContent = result.wave;
  $('finalKills').textContent = result.kills;
  $('finalAccuracy').textContent = `${result.accuracy}%`;
  $('finalTime').textContent = `${result.seconds}s`;
  $('finalSeed').textContent = result.seed;
  show('over');

  // The arcade's cue to settle a token, record a score, or do nothing at all.
  // Fired after the screen is up, so a slow listener cannot delay the player
  // seeing their own result.
  const hook = window.__nodArcade;
  if (hook && typeof hook.onRunComplete === 'function') {
    try {
      hook.onRunComplete(result);
    } catch (err) {
      // A broken embedder must not take the game down with it. The player has
      // already finished their round; whether it was recorded is not their
      // problem to be shown a stack trace about.
      console.error('nod-arcade: onRunComplete threw', err);
    }
  }
}

/* ==================================================================== the HUD */

let lastWave = -1;
let lastGun = null;

function updateHud(world) {
  const t = world.tank;
  const health = Math.max(0, Math.round(t.health));
  $('health').style.width = `${(health / TANK.maxHealth) * 100}%`;
  $('healthText').textContent = health;
  $('score').textContent = world.score.toLocaleString('en-US');

  if (world.wave !== lastWave) {
    lastWave = world.wave;
    $('wave').textContent = world.wave || '—';
  }
  if (t.gun !== lastGun) {
    lastGun = t.gun;
    $('gun').textContent = GUNS[t.gun].label;
  }

  // The boost is the only cooldown the player has to time, so it is the only
  // one that gets a readout.
  const ready = t.boostCooldown === 0;
  $('boost').classList.toggle('ready', ready);
  $('boost').style.setProperty('--fill', `${(1 - t.boostCooldown / TANK.boost.cooldown) * 100}%`);
}

/**
 * The touch sticks, drawn over the arena in screen space.
 *
 * Outside the renderer's world transform on purpose: these are fingers, not
 * things in the arena, and they must not pan, scale or shake with it.
 */
function drawOverlay(world) {
  if (!input.usingTouch()) return;
  const ctx = canvas.getContext('2d');
  ctx.save();
  for (const stick of input.stickState()) {
    ctx.strokeStyle = stick.left ? 'rgba(79,209,197,0.5)' : 'rgba(255,224,138,0.5)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(stick.originX, stick.originY, 54, 0, Math.PI * 2);
    ctx.stroke();

    const dx = stick.x - stick.originX;
    const dy = stick.y - stick.originY;
    const mag = Math.min(54, Math.sqrt(dx * dx + dy * dy)) || 0;
    const angle = Math.atan2(dy, dx);
    ctx.fillStyle = stick.left ? 'rgba(79,209,197,0.85)' : 'rgba(255,224,138,0.85)';
    ctx.beginPath();
    ctx.arc(stick.originX + Math.cos(angle) * mag, stick.originY + Math.sin(angle) * mag, 22, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

/* ================================================================== the shell */

const SCREENS = ['title', 'game', 'over'];

function show(name) {
  for (const id of SCREENS) {
    const node = $(id);
    if (node) node.hidden = id !== name;
  }
}

/** A fresh seed per run, or whatever the URL pinned. */
function seedForRun() {
  const pinned = new URLSearchParams(location.search).get('seed');
  if (pinned && Number.isFinite(Number(pinned))) return Number(pinned) >>> 0;
  return (Date.now() ^ (Math.random() * 0xffffffff)) >>> 0;
}

/**
 * Keep the canvas fitted to whatever the viewport just became.
 *
 * `orientationchange` is the awkward one: iOS fires it while the rotation is
 * still animating and reports the dimensions it is leaving, so a resize handled
 * on the event alone fits the arena to the *old* orientation and leaves it
 * there until something else happens to trigger a second one. Re-fitting on the
 * next frame and again once it has settled costs two canvas resizes per
 * rotation, which nobody can measure, and is the difference between a game that
 * fills a rotated phone and one that occupies a third of it.
 */
function fitToViewport() {
  renderer.resize();
  requestAnimationFrame(() => renderer.resize());
  setTimeout(() => renderer.resize(), 300);
}

function boot() {
  $('start').addEventListener('click', () => startRun(seedForRun()));
  $('again').addEventListener('click', () => startRun(seedForRun()));
  $('retrySeed').addEventListener('click', () => {
    // Same arena, same wave rolls. The only honest way to compare two attempts,
    // and the reason the seed is on the end screen at all.
    const seed = Number($('finalSeed').textContent) >>> 0;
    startRun(seed);
  });
  window.addEventListener('resize', () => renderer.resize());
  window.addEventListener('orientationchange', fitToViewport);
  // Fires when Safari's toolbars slide away mid-round, which `resize` does not
  // reliably report on iOS.
  window.visualViewport?.addEventListener('resize', () => renderer.resize());

  /*
   * Safari on iOS ignores `user-scalable=no` — deliberately, so that a badly
   * built page can still be zoomed into. That is the right default for a page
   * and the wrong one for this: a twin-stick game is *two thumbs on the glass
   * at once*, which is precisely the shape of a pinch, so playing normally
   * zooms the arena away and there is no gesture to undo it with.
   *
   * `touch-action: none` covers the canvas. These cover the rest of the
   * document, and they are Safari-only events that no other browser fires.
   */
  for (const type of ['gesturestart', 'gesturechange', 'gestureend']) {
    document.addEventListener(type, (e) => e.preventDefault());
  }
  // Two taps in quick succession on the HUD or a button is still a zoom on
  // older iOS, where `touch-action: manipulation` is not honoured.
  let lastTouchEnd = 0;
  document.addEventListener(
    'touchend',
    (e) => {
      const now = Date.now();
      if (now - lastTouchEnd < 300) e.preventDefault();
      lastTouchEnd = now;
    },
    { passive: false },
  );

  fitToViewport();
  show('title');

  /**
   * A small read-only window for tests and for whatever embeds this.
   *
   * Same idea as `window.__rocketman` next door: "the page did not throw" is
   * not the same fact as "the game is running", and only a number can tell
   * them apart.
   */
  window.__tankShooter = () =>
    run
      ? {
          tick: run.world.tick,
          wave: run.world.wave,
          score: run.world.score,
          health: run.world.tank.health,
          hostiles: run.world.hostiles.length,
          gun: run.world.tank.gun,
          over: run.world.over,
          seed: run.world.seed,
          maxAlive: WAVES.maxAlive,
        }
      : null;
}

boot();
