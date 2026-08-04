/**
 * Sound — synthesised, spatial, and entirely outside the simulation.
 *
 * The engine already narrates everything that happens as events (`fire`,
 * `impact`, `shieldBreak`, `promoted`, …) for the renderer's sake; this module
 * is nothing but a second listener on that same stream. It never touches world
 * state and the simulation never waits for it, so it sits on the presentation
 * side of the determinism wall along with the sparks.
 *
 * Everything is synthesised with WebAudio primitives — oscillators, filtered
 * noise, envelopes — rather than samples. Zero asset files, zero network
 * fetches, and a coherent palette: this game looks like vectors, it may as
 * well sound like an oscilloscope.
 *
 * Browsers refuse audio before a user gesture, so the context is created lazily
 * on the first pointer/key event and every path in here survives having no
 * context at all (headless test runs, ancient webviews, autoplay refusal).
 */

const MASTER_VOLUME = 0.22;
const MUTE_KEY = 'rocketman.muted.v1';

export function createSound() {
  let ctx = null;
  let master = null;
  let muted = readMuted();

  /** Per-event-type budget: how many may sound in one frame, and a floor
   *  between repeats — twenty mechs firing at once is a battle, not a rave. */
  const limits = {
    fire: { perFrame: 3, gapMs: 45, last: 0 },
    impact: { perFrame: 2, gapMs: 60, last: 0 },
    explosion: { perFrame: 3, gapMs: 30, last: 0 },
    shieldBreak: { perFrame: 2, gapMs: 80, last: 0 },
    deposit: { perFrame: 1, gapMs: 350, last: 0 },
    leapStart: { perFrame: 2, gapMs: 90, last: 0 },
  };

  function readMuted() {
    try {
      return window.localStorage.getItem(MUTE_KEY) === '1';
    } catch {
      return false;
    }
  }

  function ensureContext() {
    if (ctx || muted) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    try {
      ctx = new AC();
      master = ctx.createGain();
      master.gain.value = MASTER_VOLUME;
      master.connect(ctx.destination);
    } catch {
      ctx = null;
    }
  }

  // The unlock gesture. `once` would drop the listener after a click that
  // happened while muted, so these stay attached and self-noop instead.
  const unlock = () => {
    ensureContext();
    if (ctx && ctx.state === 'suspended') ctx.resume().catch(() => {});
  };
  window.addEventListener('pointerdown', unlock);
  window.addEventListener('keydown', unlock);

  /* ------------------------------------------------------------ synths -- */

  /** One oscillator with a pitch ramp and an exponential decay. */
  function tone({ freq, to = freq, type = 'square', dur = 0.08, gain = 1, pan = 0, delay = 0 }) {
    const t0 = ctx.currentTime + delay;
    const osc = ctx.createOscillator();
    const env = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t0);
    if (to !== freq) osc.frequency.exponentialRampToValueAtTime(Math.max(1, to), t0 + dur);
    env.gain.setValueAtTime(gain, t0);
    env.gain.exponentialRampToValueAtTime(0.001, t0 + dur);
    osc.connect(env);
    connectSpatial(env, pan, t0, dur + 0.05);
    osc.start(t0);
    osc.stop(t0 + dur + 0.05);
  }

  /** A burst of filtered noise — impacts, explosions, static. */
  function noise({ dur = 0.2, freq = 800, q = 1, gain = 1, pan = 0, drop = true, delay = 0 }) {
    const t0 = ctx.currentTime + delay;
    const samples = Math.max(1, Math.floor(ctx.sampleRate * dur));
    const buffer = ctx.createBuffer(1, samples, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    // Math.random is fine here: this is presentation, on the far side of the
    // determinism wall — the same wall that lets the renderer throw sparks.
    for (let i = 0; i < samples; i++) data[i] = Math.random() * 2 - 1;

    const src = ctx.createBufferSource();
    src.buffer = buffer;
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(freq, t0);
    if (drop) filter.frequency.exponentialRampToValueAtTime(Math.max(40, freq / 8), t0 + dur);
    filter.Q.value = q;
    const env = ctx.createGain();
    env.gain.setValueAtTime(gain, t0);
    env.gain.exponentialRampToValueAtTime(0.001, t0 + dur);
    src.connect(filter);
    filter.connect(env);
    connectSpatial(env, pan, t0, dur + 0.05);
    src.start(t0);
    src.stop(t0 + dur + 0.05);
  }

  function connectSpatial(node, pan, t0, dur) {
    if (ctx.createStereoPanner && pan !== 0) {
      const panner = ctx.createStereoPanner();
      panner.pan.setValueAtTime(Math.max(-1, Math.min(1, pan)), t0);
      node.connect(panner);
      panner.connect(master);
    } else {
      node.connect(master);
    }
    void dur;
  }

  /** A little rising arpeggio — promotions, unlocks, good news. */
  function chime(base, steps, pan = 0) {
    for (let i = 0; i < steps; i++) {
      tone({ freq: base * Math.pow(1.5, i), type: 'triangle', dur: 0.11, gain: 0.7, pan, delay: i * 0.07 });
    }
  }

  /* ----------------------------------------------------------- mapping -- */

  /**
   * Where on the stereo field and how loud, given where the camera is.
   * Off-screen events fade with distance and vanish beyond earshot rather than
   * cutting off at the viewport edge — hearing a fight start just off-screen
   * is real information, and losing it made scouting feel deaf.
   */
  function locate(renderer, x, y) {
    if (x === undefined) return { pan: 0, vol: 1 };
    const s = renderer.worldToScreen(x, y);
    const w = renderer.viewWidth();
    const h = renderer.viewHeight();
    const pan = Math.max(-1, Math.min(1, (s.x / w) * 2 - 1)) * 0.7;
    const dx = s.x < 0 ? -s.x : s.x > w ? s.x - w : 0;
    const dy = s.y < 0 ? -s.y : s.y > h ? s.y - h : 0;
    const off = Math.sqrt(dx * dx + dy * dy);
    if (off <= 0) return { pan, vol: 1 };
    if (off > 900) return null;
    return { pan, vol: 1 - off / 900 };
  }

  function allow(type, now) {
    const limit = limits[type];
    if (!limit) return true;
    if (now - limit.last < limit.gapMs) return false;
    if (limit.count === undefined || limit.frame !== now) {
      limit.frame = now;
      limit.count = 0;
    }
    if (limit.count >= limit.perFrame) return false;
    limit.count++;
    limit.last = now;
    return true;
  }

  /**
   * Play one tick's worth of events. `viewerId` scopes the interface sounds —
   * the enemy's deposits are none of the player's ears' business, while both
   * sides' explosions are simply *there*, wherever they happened.
   */
  function consume(events, world, renderer, viewerId) {
    if (muted || !ctx || ctx.state !== 'running') return;
    const now = performance.now();

    for (const ev of events) {
      const at = locate(renderer, ev.x, ev.y);
      if (!at) continue;
      const { pan, vol } = at;

      switch (ev.type) {
        case 'fire':
          if (!allow('fire', now)) break;
          tone({ freq: 900, to: 240, type: 'square', dur: 0.05, gain: 0.35 * vol, pan });
          break;
        case 'impact':
          if (!allow('impact', now)) break;
          noise({ dur: 0.08, freq: 1400, gain: 0.3 * vol, pan });
          break;
        case 'explosion': {
          if (!allow('explosion', now)) break;
          const big = !!ev.big;
          noise({ dur: big ? 0.7 : 0.3, freq: big ? 500 : 900, gain: (big ? 1.0 : 0.55) * vol, pan });
          tone({ freq: big ? 90 : 130, to: 40, type: 'sine', dur: big ? 0.5 : 0.25, gain: 0.8 * vol, pan });
          break;
        }
        case 'shieldBreak':
          if (!allow('shieldBreak', now)) break;
          tone({ freq: 2200, to: 300, type: 'sawtooth', dur: 0.18, gain: 0.4 * vol, pan });
          break;
        case 'emp':
        case 'empBurst':
          tone({ freq: 60, to: 55, type: 'sine', dur: 0.5, gain: 0.9 * vol, pan });
          tone({ freq: 1800, to: 100, type: 'sawtooth', dur: 0.4, gain: 0.25 * vol, pan });
          break;
        case 'leapStart':
          if (!allow('leapStart', now)) break;
          noise({ dur: 0.25, freq: 600, gain: 0.3 * vol, pan, drop: false });
          break;
        case 'deposit':
          if (world.entities.get(ev.id)?.player !== viewerId) break;
          if (!allow('deposit', now)) break;
          tone({ freq: 1050, type: 'triangle', dur: 0.05, gain: 0.4, pan });
          tone({ freq: 1550, type: 'triangle', dur: 0.06, gain: 0.4, pan, delay: 0.06 });
          break;
        case 'promoted':
          if (world.entities.get(ev.id)?.player === viewerId) chime(500, 3, pan);
          break;
        case 'placed':
          if (ev.player === viewerId) noise({ dur: 0.15, freq: 300, gain: 0.5, pan, drop: false });
          break;
        case 'produced':
          if (ev.player === viewerId) tone({ freq: 350, to: 520, type: 'triangle', dur: 0.1, gain: 0.5, pan });
          break;
        case 'sold':
          if (ev.player === viewerId) chime(700, 2, pan);
          break;
        case 'superweaponReady':
          if (ev.player === viewerId) chime(400, 4, 0);
          break;
        case 'superweaponFired':
          // Everyone hears a Lance fire, wherever the camera is. That is the
          // telegraph doing its job.
          tone({ freq: 200, to: 1400, type: 'sawtooth', dur: 1.0, gain: 0.5, pan: 0 });
          break;
        case 'superweapon':
          noise({ dur: 1.1, freq: 400, gain: 1.2 * (vol || 1), pan });
          tone({ freq: 70, to: 35, type: 'sine', dur: 0.9, gain: 1.0, pan });
          break;
        case 'gameOver':
          if (ev.winner === viewerId) chime(440, 5, 0);
          else tone({ freq: 220, to: 90, type: 'sawtooth', dur: 1.2, gain: 0.6, pan: 0 });
          break;
        default:
          break;
      }
    }
  }

  function toggleMute() {
    muted = !muted;
    try {
      window.localStorage.setItem(MUTE_KEY, muted ? '1' : '0');
    } catch {
      /* preference just does not persist */
    }
    if (!muted) unlock();
    return muted;
  }

  return {
    consume,
    toggleMute,
    get muted() {
      return muted;
    },
  };
}
