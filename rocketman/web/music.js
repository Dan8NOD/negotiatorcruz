/**
 * The score.
 *
 * Sound effects are information — a cue tells the player something happened
 * somewhere. Music is not, and the difference drives every decision in here:
 * a wrong sound effect is a lie, and a wrong piece of music is only ever
 * awkward. So this module is allowed to be lazy in ways `samples.js` is not.
 * It loads one track at a time, it never blocks anything, and when a track is
 * missing the game simply plays no music rather than falling back to
 * synthesised music, which is not a thing that should exist.
 *
 * ## The state machine, and why it will not flap
 *
 * The game hands this module a desired state every frame — `calm`, `battle`,
 * `desperate` — computed from what is currently happening. Followed literally
 * that produces a score that lurches: two frames of contact during a scouting
 * run would kick the battle bed in and out inside a second, and the player
 * would learn to hear the music as noise.
 *
 * Two rules fix it, and they are deliberately asymmetric:
 *
 *   - **Up one step at a time, immediately.** A skirmish escalates `calm` to
 *     `battle`, never straight to `desperate`. Arriving late to a fight is
 *     scoring the wrong scene, so there is no delay on the way up.
 *   - **Down only after the cooldown, one step at a time.** A lull of four
 *     seconds is not the end of a battle. `MUSIC_COOLDOWN` seconds of nothing
 *     happening is, and even then the score walks back down rather than
 *     dropping out.
 *
 * The stepping is a pure function so the suite can drive a whole mission
 * through it — escalation, lulls, the lot — without an AudioContext, which is
 * the only way this is testable at all.
 */

import { MUSIC_STATES, MUSIC_FADE, MUSIC_COOLDOWN, MUSIC_DUCK } from './audio-cues.js';

/**
 * Where the score should be next, given where it is and what the game wants.
 *
 * Pure. `now` and `since` are milliseconds; `since` is when the current state
 * was last reinforced by the game asking for it or higher.
 *
 * @param {string} current
 * @param {string} wanted
 * @param {number} now
 * @param {number} since
 * @param {number} [cooldownMs]
 * @returns {string} the state to be in — possibly the one already playing
 */
export function stepState(current, wanted, now, since, cooldownMs = MUSIC_COOLDOWN * 1000) {
  const cur = MUSIC_STATES[current];
  const want = MUSIC_STATES[wanted];
  if (!cur || !want) return current;

  // The end-of-mission states are not part of the intensity ladder. They are
  // asked for once, they play once, and nothing steps out of them.
  if (!want.loop) return wanted;
  if (!cur.loop) return current;

  if (want.intensity > cur.intensity) {
    return nameAt(cur.intensity + 1) || wanted;
  }
  if (want.intensity < cur.intensity) {
    if (now - since < cooldownMs) return current;
    return nameAt(cur.intensity - 1) || wanted;
  }
  return current;
}

function nameAt(intensity) {
  for (const [name, spec] of Object.entries(MUSIC_STATES)) {
    if (spec.loop && spec.intensity === intensity) return name;
  }
  return null;
}

/**
 * Which state the world is asking for, read off the events of one tick.
 *
 * Pure, and takes plain data rather than the world object, so a test can drive
 * it with a handful of fake events. `mine` decides whose losses count as
 * desperation: the player's, and only the player's.
 *
 * @param {Array<{type: string, player?: number, kind?: string}>} events
 * @param {number} viewerId
 * @returns {string|null} a state, or null if this tick says nothing
 */
export function stateFromEvents(events, viewerId) {
  let wanted = null;
  for (const ev of events) {
    switch (ev.type) {
      case 'missionEnd':
        return ev.result === 'won' ? 'victory' : 'defeat';
      case 'gameOver':
        return ev.winner === viewerId ? 'victory' : 'defeat';
      // Losing a structure, or being on the wrong end of the Lance, is the
      // definition of the top bed. Nothing else reaches it.
      //
      // Whose Lance it is decides everything here. Theirs is the most
      // frightening thing in the game and the score should say so; yours is
      // the best moment you have had all mission, and scoring it as
      // desperation would tell the player they are losing at the exact
      // instant they are winning.
      case 'superweaponFired':
        if (ev.player !== viewerId) wanted = 'desperate';
        else if (wanted !== 'desperate') wanted = 'battle';
        break;
      case 'death':
        if (ev.kind === 'building' && ev.player === viewerId) wanted = 'desperate';
        else if (wanted !== 'desperate') wanted = 'battle';
        break;
      case 'fire':
      case 'impact':
      case 'explosion':
      case 'shieldBreak':
        if (wanted !== 'desperate') wanted = 'battle';
        break;
      default:
        break;
    }
  }
  return wanted;
}

/* ================================================================ the player */

const MUSIC_VOLUME_KEY = 'rocketman.music.v1';

/**
 * Play the score over a bus of its own.
 *
 * @param {BaseAudioContext} ctx
 * @param {{
 *   destination: AudioNode,
 *   base?: string,
 *   fetchImpl?: typeof fetch,
 *   ext?: string,
 *   rand?: () => number,
 *   storage?: Storage|null,
 * }} options
 */
export function createMusic(ctx, options) {
  const {
    destination,
    base = './audio/',
    fetchImpl = typeof fetch === 'function' ? fetch.bind(globalThis) : null,
    ext = 'webm',
    rand = Math.random,
    storage = safeStorage(),
  } = options;

  /** state -> track descriptors from the manifest. */
  let tracks = {};
  /** url -> AudioBuffer, once decoded. One track's worth at a time. */
  const buffers = new Map();

  let bus = null;
  let duckGain = null;
  let volume = readVolume();

  /** The source currently playing, and the state it belongs to. */
  let playing = null;
  let state = null;
  let since = 0;
  let loadToken = 0;

  function safeStorage() {
    try {
      return window.localStorage;
    } catch {
      return null;
    }
  }

  function readVolume() {
    try {
      const v = parseFloat(storage && storage.getItem(MUSIC_VOLUME_KEY));
      // Music sits under the effects by default. A score mixed level with the
      // guns is a score the player turns off.
      return Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0.55;
    } catch {
      return 0.55;
    }
  }

  function ensureBus() {
    if (bus) return;
    // Two gains in series: one the player owns, one the game owns. Ducking a
    // blast must not overwrite the volume the player chose, and restoring
    // after the duck must not undo a change they made mid-duck.
    duckGain = ctx.createGain();
    duckGain.gain.value = 1;
    duckGain.connect(destination);

    bus = ctx.createGain();
    bus.gain.value = 0;
    bus.connect(duckGain);
  }

  /**
   * Read the manifest's music section. Safe to call with no manifest at all.
   *
   * Re-enters the current state on the way out, and that is not tidiness. The
   * manifest fetch is deliberately not awaited by anything, so the title screen
   * has already asked for `menu` by the time it lands — and `go` for a state
   * with no tracks does nothing and returns. Without the re-entry, the first
   * state ever requested is the one state that never plays, which on a normal
   * boot is the menu bed, which is the first music anyone would hear.
   */
  function adopt(manifest) {
    tracks = (manifest && manifest.music) || {};
    if (state && !playing) {
      const pending = state;
      state = null;
      go(pending);
    }
    return Object.keys(tracks).length;
  }

  async function fetchTrack(file) {
    if (buffers.has(file)) return buffers.get(file);
    if (!fetchImpl) return null;
    try {
      const url = /^(?:[a-z]+:)?\/\//i.test(file) || file.startsWith('data:') ? file : base + file;
      const res = await fetchImpl(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const raw = await res.arrayBuffer();
      const buffer = await new Promise((resolve, reject) => {
        const ret = ctx.decodeAudioData(raw, resolve, reject);
        if (ret && typeof ret.then === 'function') ret.then(resolve, reject);
      });
      // One bed, one end sting, and whatever is fading out. Past that, drop
      // the oldest: a decoded three-minute track is thirty megabytes of PCM
      // and a long campaign session would otherwise accumulate all of them.
      if (buffers.size >= 3) buffers.delete(buffers.keys().next().value);
      buffers.set(file, buffer);
      return buffer;
    } catch {
      return null;
    }
  }

  function pickTrack(name) {
    const list = tracks[name];
    if (!list || !list.length) return null;
    return list[Math.floor(rand() * list.length)];
  }

  /**
   * Move to a state, crossfading.
   *
   * Awaits a fetch, so two rapid calls could land out of order and leave the
   * loser playing. `loadToken` is the guard: a call that finishes loading
   * after a newer one started simply drops what it loaded.
   */
  async function go(name) {
    if (!MUSIC_STATES[name] || name === state) return;
    const token = ++loadToken;
    const track = pickTrack(name);
    state = name;
    since = ctx.currentTime * 1000;

    if (!track) {
      // Nothing recorded for this state. Fade out what is playing rather than
      // leaving the previous bed under a scene it does not belong to.
      fadeOut(MUSIC_FADE.down);
      return;
    }

    const buffer = await fetchTrack(track.file || track);
    if (token !== loadToken || !buffer) return;

    ensureBus();
    const spec = MUSIC_STATES[name];
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    if (spec.loop) {
      src.loop = true;
      // Loop points from the pack tool, which finds them by analysis rather
      // than by hoping the track happens to end where it began.
      if (track.loopStart !== undefined) src.loopStart = track.loopStart;
      if (track.loopEnd !== undefined) src.loopEnd = track.loopEnd;
    }

    const gain = ctx.createGain();
    gain.gain.value = 0;
    src.connect(gain);
    gain.connect(bus);

    const t0 = ctx.currentTime;
    const rise = spec.loop ? MUSIC_FADE.up : 0.05;
    gain.gain.setValueAtTime(0.0001, t0);
    gain.gain.linearRampToValueAtTime(1, t0 + rise);

    fadeOut(MUSIC_FADE.down);
    src.start(t0);
    playing = { src, gain };
    bus.gain.cancelScheduledValues(t0);
    bus.gain.setValueAtTime(bus.gain.value, t0);
    bus.gain.linearRampToValueAtTime(volume, t0 + rise);
  }

  function fadeOut(seconds) {
    const old = playing;
    playing = null;
    if (!old) return;
    const t0 = ctx.currentTime;
    old.gain.gain.cancelScheduledValues(t0);
    old.gain.gain.setValueAtTime(old.gain.gain.value, t0);
    old.gain.gain.linearRampToValueAtTime(0.0001, t0 + seconds);
    try {
      old.src.stop(t0 + seconds + 0.1);
    } catch {
      /* already stopped */
    }
  }

  /**
   * Pull the score down under something loud, and let it back up.
   *
   * The release is four times the attack because a duck you can hear
   * recovering is a duck the player notices, and a duck the player notices is
   * worse than no duck.
   */
  function duck(amount = MUSIC_DUCK.amount, seconds = MUSIC_DUCK.seconds) {
    if (!duckGain) return;
    const t0 = ctx.currentTime;
    const floor = Math.max(0.05, 1 - amount);
    duckGain.gain.cancelScheduledValues(t0);
    duckGain.gain.setValueAtTime(duckGain.gain.value, t0);
    duckGain.gain.linearRampToValueAtTime(floor, t0 + 0.08);
    duckGain.gain.setValueAtTime(floor, t0 + seconds * 0.25);
    duckGain.gain.linearRampToValueAtTime(1, t0 + seconds);
  }

  /**
   * The per-tick entry point: what the game wants, filtered through the
   * anti-flap rules. Returns the state actually in force.
   */
  function update(wanted, now = Date.now()) {
    if (!wanted || !state) {
      if (wanted && !state) go(wanted);
      return state;
    }
    const next = stepState(state, wanted, now, since);
    if (next !== state) go(next);
    else if (MUSIC_STATES[wanted].intensity >= MUSIC_STATES[state].intensity) since = now;
    return state;
  }

  function setVolume(v) {
    volume = Math.max(0, Math.min(1, Number.isFinite(v) ? v : 0.55));
    try {
      if (storage) storage.setItem(MUSIC_VOLUME_KEY, String(volume));
    } catch {
      /* preference just does not persist */
    }
    if (bus && playing) {
      const t0 = ctx.currentTime;
      bus.gain.cancelScheduledValues(t0);
      bus.gain.setValueAtTime(bus.gain.value, t0);
      bus.gain.linearRampToValueAtTime(volume, t0 + 0.15);
    } else if (bus && !playing) {
      bus.gain.value = 0;
    }
    return volume;
  }

  function stop() {
    fadeOut(0.6);
    state = null;
  }

  function stats() {
    return {
      state,
      volume,
      states: Object.keys(tracks).length,
      cached: buffers.size,
      playing: !!playing,
    };
  }

  return {
    adopt,
    go,
    update,
    duck,
    stop,
    setVolume,
    stats,
    get volume() {
      return volume;
    },
    get state() {
      return state;
    },
  };
}
