/**
 * Recorded audio, in front of the synthesised palette.
 *
 * `sound.js` can make every noise the game needs out of oscillators, and that
 * remains the fallback in every sense: it is what plays before this module has
 * finished loading, what plays for a cue nobody has recorded yet, what plays
 * when the browser will not decode the format, and what plays in the
 * single-file build where there is nothing to fetch. Nothing in here is
 * allowed to be load-bearing, and the tests hold that line.
 *
 * So the contract is one boolean. `play()` returns true if a recorded take
 * went out and false if it did not, and the caller's fallback is the
 * synthesised recipe it would have run anyway. There is no loading screen, no
 * readiness gate, and no state where the game is waiting on audio — a match
 * started three seconds after the page opens simply gets more oscillator and
 * less microphone for its first few seconds, and then stops doing that.
 *
 * ## Why the takes are shuffled rather than picked at random
 *
 * `Math.random()` over six takes plays the same take twice in a row one time
 * in six, and an autocannon that fires four times a second finds that corner
 * constantly — two identical transients 250 ms apart is the exact artefact
 * recording six takes was meant to remove. A shuffle bag cannot repeat until
 * it has been through the others, and reshuffles with the previous last take
 * held out of first place, so the seam between bags cannot repeat either.
 *
 * That decision is a pure function and lives here as one, so `audio.test.js`
 * can prove it without an AudioContext.
 */

import { CUES } from './audio-cues.js';

/* ================================================================ shuffling */

/**
 * A bag of take indices that deals every take before repeating any.
 *
 * `rand` is injected so the suite can drive it with a sequence rather than
 * chance. It is `Math.random` in the game, which is fine: this is presentation,
 * on the far side of the determinism wall that lets the renderer throw sparks.
 *
 * @param {number} count how many takes exist for this cue
 * @param {() => number} rand
 */
export function createShuffleBag(count, rand = Math.random) {
  let bag = [];
  let last = -1;

  function refill() {
    bag = Array.from({ length: count }, (_, i) => i);
    // Fisher-Yates.
    for (let i = bag.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [bag[i], bag[j]] = [bag[j], bag[i]];
    }
    // The seam. Without this the last take of one bag and the first of the
    // next are free to be the same take, which is the repeat we are here to
    // prevent — rarer than uniform random, and therefore worse, because it
    // survives casual listening and shows up in a recording.
    //
    // The guard is on the *end* of the array because `next` pops from there.
    // Guarding `bag[0]` reads more naturally and protects the take that comes
    // out last, which is not a thing that needs protecting.
    const top = bag.length - 1;
    if (count > 1 && bag[top] === last) {
      const swap = Math.floor(rand() * top);
      [bag[top], bag[swap]] = [bag[swap], bag[top]];
    }
  }

  return {
    next() {
      if (count <= 0) return -1;
      if (count === 1) return 0;
      if (bag.length === 0) refill();
      last = bag.pop();
      return last;
    },
  };
}

/* ================================================================== formats */

/**
 * Which encoding this browser wants, given what the pack produced.
 *
 * Opus in WebM is half the size of AAC at the same quality and every current
 * browser plays it — except Safari before 17, which is still a live target on
 * older iPads and is the entire reason the pack emits a second format at all.
 *
 * Exported and pure so the suite can check the preference order without a
 * browser: hand it a fake `canPlay` and watch which extension it picks.
 *
 * @param {string[]} available extensions the manifest offers, e.g. ['webm','m4a']
 * @param {(mime: string) => string} canPlay `HTMLMediaElement.canPlayType`
 */
export function pickFormat(available, canPlay) {
  const order = [
    ['webm', 'audio/webm; codecs=opus'],
    ['m4a', 'audio/mp4; codecs=mp4a.40.2'],
    ['ogg', 'audio/ogg; codecs=opus'],
    ['mp3', 'audio/mpeg'],
    ['wav', 'audio/wav'],
  ];
  for (const [ext, mime] of order) {
    if (!available.includes(ext)) continue;
    const verdict = canPlay(mime);
    if (verdict === 'probably' || verdict === 'maybe') return ext;
  }
  // Nothing claimed support. Try the first thing on offer anyway rather than
  // giving up: `canPlayType` is advisory, browsers understate it, and a failed
  // decode costs one fetch and falls back to the synth like everything else.
  return available[0] || null;
}

/* ================================================================= the bank */

/**
 * Load and play recorded takes over an existing mixer.
 *
 * Takes the context and the buses as arguments for the same reason
 * `createSynth` does: it makes the module testable and it keeps the decision
 * about *where* audio goes in one place, `sound.js`, rather than spread across
 * everything that makes a noise.
 *
 * @param {BaseAudioContext} ctx
 * @param {{
 *   world: AudioNode,
 *   ui: AudioNode,
 *   reserve?: (dur: number, delay: number, critical: boolean) => boolean,
 *   base?: string,
 *   fetchImpl?: typeof fetch,
 *   canPlay?: (mime: string) => string,
 *   rand?: () => number,
 * }} options
 */
export function createSampleBank(ctx, options) {
  const {
    world,
    ui,
    reserve = () => true,
    base = './audio/',
    fetchImpl = typeof fetch === 'function' ? fetch.bind(globalThis) : null,
    canPlay = defaultCanPlay,
    rand = Math.random,
  } = options;

  /** cue name -> {buffers: AudioBuffer[], bag, spec} once decoded. */
  const loaded = new Map();

  /** How many takes failed to decode, and how many cues arrived. Read by stats. */
  let decoded = 0;
  let failed = 0;
  let played = 0;
  let manifestState = 'idle';

  /**
   * The parsed manifest, kept so the music player can read its own section
   * rather than fetching the same file a second time. One manifest describes
   * the whole pack — effects and score — because they are built by one tool
   * from one folder and shipping them out of sync is the failure mode.
   */
  let manifest = null;

  function defaultCanPlay(mime) {
    try {
      return typeof Audio === 'function' ? new Audio().canPlayType(mime) : '';
    } catch {
      return '';
    }
  }

  /**
   * `decodeAudioData` twice over.
   *
   * Old WebViews — including the one on the Fire tablets this game already
   * supports — implement only the callback form and return undefined from the
   * call, so awaiting the return value hangs forever. Wrapping both shapes is
   * four lines and removes a class of bug that only reproduces on a device.
   */
  function decode(arrayBuffer) {
    return new Promise((resolve, reject) => {
      const ret = ctx.decodeAudioData(arrayBuffer, resolve, reject);
      if (ret && typeof ret.then === 'function') ret.then(resolve, reject);
    });
  }

  /**
   * Fetch and decode everything the manifest offers.
   *
   * Deliberately not awaited by anything that matters. The game is already
   * running and already making noise; this arrives when it arrives, cue by
   * cue, and each cue starts playing from its recordings the moment its own
   * takes land rather than waiting for the whole pack.
   *
   * @param {string} [manifestUrl]
   * @returns {Promise<{cues: number, takes: number}>}
   */
  async function load(manifestUrl = `${base}manifest.json`) {
    if (!fetchImpl) {
      manifestState = 'unavailable';
      return { cues: 0, takes: 0 };
    }
    manifestState = 'loading';

    // The single-file build has nowhere to fetch from — it is one HTML file on
    // a disk, and `file://` refuses cross-origin requests to its own directory
    // — so `--with-audio` inlines the whole pack as data URIs under this
    // global instead. Everything downstream is identical: a data URI is a URL,
    // and `fetch` reads it.
    const inlined = globalThis.__ROCKETMAN_AUDIO__;
    if (inlined) {
      manifest = inlined;
    } else {
      try {
        const res = await fetchImpl(manifestUrl);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        manifest = await res.json();
      } catch {
        // The manifest is missing, which is a *deployment* problem rather than
        // the ordinary state of things — an empty one is committed precisely so
        // that a repository with no recordings still answers this request.
        //
        // It has to be committed rather than absent because a 404 cannot be
        // handled quietly: the browser writes "Failed to load resource" to the
        // console before any of this code runs, and a game that logs an error
        // on every boot is a game whose console is worthless. There is no way
        // to suppress that from here, so the only fix is not to 404.
        manifestState = 'absent';
        return { cues: 0, takes: 0 };
      }
    }

    const entries = Object.entries(manifest.cues || {});
    // Checked before the format, so that a pack with nothing in it reports
    // `empty` — which is a checkout nobody has recorded for yet — rather than
    // `unsupported`, which would send someone hunting a codec problem that is
    // not there.
    if (!entries.length) {
      manifestState = 'empty';
      return { cues: 0, takes: 0 };
    }

    const ext = pickFormat(manifest.formats || ['webm'], canPlay);
    if (!ext) {
      manifestState = 'unsupported';
      return { cues: 0, takes: 0 };
    }

    let takes = 0;

    // Four at a time. A pack is a couple of hundred small files and firing
    // them all at once on a phone starves the fetches the *page* still needs.
    const queue = entries.slice();
    const workers = Array.from({ length: Math.min(4, queue.length) }, async () => {
      while (queue.length) {
        const [cue, entry] = queue.shift();
        takes += await loadCue(cue, entry, ext);
      }
    });
    await Promise.all(workers);

    manifestState = loaded.size ? 'loaded' : 'empty';
    return { cues: loaded.size, takes };
  }

  async function loadCue(cue, entry, ext) {
    const spec = CUES[cue];
    // A manifest naming a cue the game does not have is stale, not fatal —
    // the pack tool warns about it and the game ignores it.
    if (!spec) return 0;

    const files = (entry.takes || []).map((take) =>
      typeof take === 'string' ? take : take[ext] || take.file
    );
    const buffers = [];

    for (const file of files) {
      if (!file) continue;
      try {
        const url = /^(?:[a-z]+:)?\/\//i.test(file) || file.startsWith('data:') ? file : base + file;
        const res = await fetchImpl(url);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        buffers.push(await decode(await res.arrayBuffer()));
        decoded++;
      } catch {
        // One bad take is one bad take. The cue plays from the others, and if
        // none of them survive the synth has it.
        failed++;
      }
    }

    if (!buffers.length) return 0;
    loaded.set(cue, {
      buffers,
      spec,
      bag: createShuffleBag(buffers.length, rand),
      gain: entry.gain === undefined ? spec.gain : entry.gain,
    });
    return buffers.length;
  }

  /** Whether a cue will play from a recording rather than from the synth. */
  function has(cue) {
    return loaded.has(cue);
  }

  /**
   * Play one take of `cue`, positioned.
   *
   * Returns false whenever the recording cannot be used — no takes, no
   * context, mix full — and false is the caller's signal to synthesise
   * instead. Never throws: a sound is not worth taking the frame down for.
   *
   * @param {string} cue
   * @param {{pan: number, vol: number}} at
   * @param {{delay?: number, gain?: number}} [opts]
   */
  function play(cue, at, opts = {}) {
    const hit = loaded.get(cue);
    if (!hit) return false;

    const index = hit.bag.next();
    const buffer = hit.buffers[index];
    if (!buffer) return false;

    const delay = opts.delay || 0;
    const critical = hit.spec.bus === 'ui';
    // Reserve against the same ceiling the oscillators use. A recorded take is
    // cheaper than a stack of oscillators, but the ceiling is about how much
    // the *ear* can take in one moment, not how much the CPU can.
    if (!reserve(buffer.duration, delay, critical)) return false;

    try {
      const t0 = ctx.currentTime + delay;
      const src = ctx.createBufferSource();
      src.buffer = buffer;
      src.loop = !!hit.spec.loop;

      if (hit.spec.pitch) {
        const [lo, hi] = hit.spec.pitch;
        src.playbackRate.value = lo + rand() * (hi - lo);
      }

      const env = ctx.createGain();
      const level = (opts.gain === undefined ? hit.gain : opts.gain) * (at ? at.vol : 1);
      env.gain.value = Math.max(0, level);
      src.connect(env);

      const bus = hit.spec.bus === 'ui' ? ui : world;
      const pan = at ? at.pan : 0;
      if (ctx.createStereoPanner && pan) {
        const panner = ctx.createStereoPanner();
        panner.pan.setValueAtTime(Math.max(-1, Math.min(1, pan)), t0);
        env.connect(panner);
        panner.connect(bus);
      } else {
        env.connect(bus);
      }

      src.start(t0);
      played++;
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Hand in an already-decoded buffer.
   *
   * The single-file build inlines the pack as data URIs rather than fetching
   * it, and the e2e suite needs a way to prove the sample path runs without
   * shipping a megabyte of audio into the repository. Both go through here.
   */
  function put(cue, buffers) {
    const spec = CUES[cue];
    if (!spec || !buffers || !buffers.length) return false;
    loaded.set(cue, { buffers, spec, bag: createShuffleBag(buffers.length, rand), gain: spec.gain });
    return true;
  }

  function stats() {
    return { manifest: manifestState, cues: loaded.size, decoded, failed, played };
  }

  return {
    load,
    play,
    has,
    put,
    stats,
    /** The parsed manifest, or null before one has been fetched. */
    get manifest() {
      return manifest;
    },
  };
}
