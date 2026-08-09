/**
 * Sound — spatial, layered, and entirely outside the simulation.
 *
 * The engine already narrates everything that happens as events (`fire`,
 * `impact`, `shieldBreak`, `promoted`, …) for the renderer's sake; this module
 * is nothing but a second listener on that same stream. It never touches world
 * state and the simulation never waits for it, so it sits on the presentation
 * side of the determinism wall along with the sparks.
 *
 * There are two layers, and the order between them is the whole design.
 *
 * The **synthesised palette** below is the floor. Oscillators, filtered noise,
 * envelopes, formant filters — zero asset files, zero network fetches, and a
 * coherent palette that ships inside the single-file build and works on a
 * plane. Every sound in the game exists here first.
 *
 * **Recorded takes** are the ceiling, and they are strictly optional. When an
 * audio pack has been built and deployed, `samples.js` plays a real recording
 * for any cue that has one and `play()` below falls through to the oscillator
 * for every cue that does not. That makes a half-finished recording session a
 * perfectly playable game rather than a game with holes in it, and it means
 * the pack can be deployed one family of sounds at a time. See
 * `audio-cues.js` for the catalogue and `audio/README.md` for the pipeline.
 *
 * Browsers refuse audio before a user gesture, so the context is created lazily
 * on the first pointer/key event and every path in here survives having no
 * context at all (headless test runs, ancient webviews, autoplay refusal).
 *
 * ## Why the voice tables live at module scope
 *
 * A weapon whose sound is a copy of another weapon's sound is dead content in
 * exactly the way a warhead that never beats another warhead is dead content,
 * and the engine pins that one with a test. So the mapping from weapon to
 * sound is a plain exported table rather than a switch buried in a closure:
 * `sound.test.js` walks `WEAPONS` and fails if anything is missing a voice, or
 * if two weapons resolve to the same recipe. The recipes take a synth
 * interface as an argument, which is what lets them be data out here while the
 * AudioContext stays private in there.
 */

import { createSampleBank } from './samples.js';
import { createMusic, stateFromEvents } from './music.js';

/* ============================================================== the palette */

/**
 * Fourteen weapons, fourteen voices.
 *
 * The rule each recipe follows: a weapon should be identifiable with the
 * screen covered. Rate of fire does most of that work by itself — a storm
 * repeater at six shots a second and a siege mortar at one shot every three
 * could share a sample and still be told apart — so the recipes push in the
 * other direction and separate them by *timbre*, which is what lets you tell
 * an autocannon from a turret gun when both are firing once a third of a
 * second, off-screen, in the same fight.
 *
 * Loudness is deliberately inverse to rate of fire. The storm repeater is the
 * quietest thing in the game per shot because it fires twenty-three times in
 * the window a mortar fires once, and a mix that treats those equally is a mix
 * where the repeater is the only thing you can hear.
 *
 * @type {Record<string, (s: Synth, at: Place) => void>}
 */
export const WEAPON_VOICES = {
  /** Dry mechanical crack. The baseline against which the others are read. */
  autocannon(s, at) {
    s.noise({ dur: 0.045, freq: 2200, gain: 0.34 * at.vol, pan: at.pan });
    s.tone({ freq: 180, to: 60, type: 'square', dur: 0.05, gain: 0.26 * at.vol, pan: at.pan });
  },

  /**
   * Six shots a second. Anything with weight here becomes a drill — but the
   * first pass went so far the other way that each shot was twenty
   * milliseconds and read as a click rather than a gun. Forty is still a sixth
   * of the gap between shots, so the shots stay separate, and it is long
   * enough to have a pitch.
   */
  stormrepeater(s, at) {
    s.noise({ dur: 0.045, freq: 3600, filter: 'highpass', gain: 0.15 * at.vol, pan: at.pan, drop: false });
    s.tone({ freq: 460, to: 300, type: 'square', dur: 0.04, gain: 0.12 * at.vol, pan: at.pan });
  },

  /** Twenty-six damage at three cells. It should sound like a door closing. */
  scattergun(s, at) {
    s.noise({ dur: 0.2, freq: 1300, gain: 0.85 * at.vol, pan: at.pan });
    s.tone({ freq: 125, to: 42, type: 'sine', dur: 0.14, gain: 0.6 * at.vol, pan: at.pan });
  },

  /**
   * A turret is bolted to the ground, so it can be heavier than a mech's arm —
   * and it has to be, because it fires at almost the autocannon's rate and
   * these two are the sounds a player hears most. The mechanical action on the
   * front and the long low tail are what keep "my mech is shooting" and "their
   * base is shooting at me" from arriving as the same event.
   */
  turretgun(s, at) {
    s.noise({ dur: 0.02, freq: 2600, filter: 'highpass', gain: 0.3 * at.vol, pan: at.pan, drop: false });
    s.noise({ dur: 0.13, freq: 900, gain: 0.55 * at.vol, pan: at.pan, delay: 0.012 });
    s.tone({ freq: 100, to: 36, type: 'square', dur: 0.15, gain: 0.5 * at.vol, pan: at.pan, delay: 0.012 });
  },

  /** Airburst flak: three pops, because one pop is just a gun. */
  flakburst(s, at) {
    for (let i = 0; i < 3; i++) {
      s.noise({ dur: 0.05, freq: 1900, gain: 0.3 * at.vol, pan: at.pan, delay: i * 0.035 });
    }
    s.tone({ freq: 300, to: 90, type: 'square', dur: 0.09, gain: 0.22 * at.vol, pan: at.pan });
  },

  /** Four rockets off the rail. Hiss that climbs as the thing leaves. */
  rocketpod(s, at) {
    s.tone({ freq: 150, to: 700, type: 'sawtooth', dur: 0.22, gain: 0.16 * at.vol, pan: at.pan });
    s.noise({ dur: 0.3, freq: 900, filter: 'bandpass', q: 1.4, gain: 0.4 * at.vol, pan: at.pan, drop: false });
  },

  /**
   * A smaller tube, and it has to read as one next to the pod rather than as
   * a quieter copy of it: thinner, brighter, and gone sooner. Two rockets, not
   * four, so the sound has less time to establish itself and must be recognised
   * from its first fifty milliseconds.
   */
  lightrockets(s, at) {
    s.tone({ freq: 340, to: 1500, type: 'sawtooth', dur: 0.1, gain: 0.11 * at.vol, pan: at.pan });
    s.noise({ dur: 0.13, freq: 2400, filter: 'bandpass', q: 3, gain: 0.28 * at.vol, pan: at.pan, drop: false });
  },

  /** Tube-launched, so it thumps out before it lights. */
  talon(s, at) {
    s.tone({ freq: 95, to: 60, type: 'sine', dur: 0.07, gain: 0.55 * at.vol, pan: at.pan });
    s.noise({
      dur: 0.26,
      freq: 800,
      filter: 'bandpass',
      q: 1.2,
      gain: 0.32 * at.vol,
      pan: at.pan,
      drop: false,
      delay: 0.05,
    });
  },

  /** Incendiary. Heavier off the rail and it keeps hissing after it has gone. */
  thermite(s, at) {
    s.tone({ freq: 72, to: 40, type: 'sine', dur: 0.2, gain: 0.7 * at.vol, pan: at.pan });
    s.noise({ dur: 0.45, freq: 620, filter: 'bandpass', q: 0.8, gain: 0.42 * at.vol, pan: at.pan, drop: false });
  },

  /** Eleven cells of arc. A hollow underground thump, then the tube ringing. */
  siegemortar(s, at) {
    s.tone({ freq: 115, to: 36, type: 'sine', dur: 0.32, gain: 1.0 * at.vol, pan: at.pan });
    s.noise({ dur: 0.26, freq: 340, gain: 0.5 * at.vol, pan: at.pan });
    s.tone({ freq: 880, to: 700, type: 'triangle', dur: 0.16, gain: 0.1 * at.vol, pan: at.pan, delay: 0.03 });
  },

  /**
   * Halcyon's gun, and the loudest single report in the game.
   *
   * A rail gun has no propellant, so there is no boom to make: the sound is
   * the capacitor emptying and then the air being torn. The 30ms up-chirp on
   * the front is what sells it — it arrives already moving.
   */
  railspike(s, at) {
    s.tone({ freq: 420, to: 3000, type: 'sine', dur: 0.035, gain: 0.3 * at.vol, pan: at.pan });
    s.noise({ dur: 0.14, freq: 5200, filter: 'highpass', gain: 0.9 * at.vol, pan: at.pan, delay: 0.032 });
    s.tone({
      freq: 1700,
      to: 110,
      type: 'sawtooth',
      dur: 0.22,
      gain: 0.5 * at.vol,
      pan: at.pan,
      delay: 0.032,
    });
  },

  /** Energy hitscan: tonal, no mechanism, all of it in one exhale. */
  beamlance(s, at) {
    s.tone({ freq: 1500, to: 880, type: 'sawtooth', dur: 0.17, gain: 0.3 * at.vol, pan: at.pan });
    s.tone({ freq: 2900, to: 1700, type: 'sine', dur: 0.15, gain: 0.13 * at.vol, pan: at.pan });
    s.noise({ dur: 0.12, freq: 3000, filter: 'bandpass', q: 3, gain: 0.22 * at.vol, pan: at.pan, drop: false });
  },

  /**
   * The Gale's projector. It kills nothing, so it must *sound* like it did
   * something — a warbling collapse rather than a hit.
   */
  empprojector(s, at) {
    for (let i = 0; i < 3; i++) {
      s.tone({
        freq: 900 - i * 120,
        to: 90,
        type: 'square',
        dur: 0.3,
        gain: 0.16 * at.vol,
        pan: at.pan,
        delay: i * 0.045,
      });
    }
    s.noise({ dur: 0.3, freq: 2400, filter: 'bandpass', q: 6, gain: 0.24 * at.vol, pan: at.pan });
  },

  /** Ghost's stolen arc gun: a crackle across a gap, not a shot. */
  arcprojector(s, at) {
    for (let i = 0; i < 5; i++) {
      s.noise({
        dur: 0.03,
        freq: 4200,
        filter: 'highpass',
        gain: (0.2 + i * 0.05) * at.vol,
        pan: at.pan,
        delay: i * 0.028,
        drop: false,
      });
    }
    s.tone({ freq: 62, to: 50, type: 'sine', dur: 0.4, gain: 0.5 * at.vol, pan: at.pan });
  },

  /* ---- the Robot Marine ------------------------------------------------ */

  /**
   * The gate gun. A single enormous shell every two and a half seconds, and
   * the fight is built around hearing it: the player's counterplay is to be
   * somewhere else for one cycle, which only works if the cycle is audible
   * from across the map. Longest, lowest, slowest thing in the table.
   */
  bastioncannon(s, at) {
    s.noise({ dur: 0.34, freq: 620, gain: 1.0 * at.vol, pan: at.pan });
    s.tone({ freq: 72, to: 30, type: 'sine', dur: 0.42, gain: 0.9 * at.vol, pan: at.pan });
    // The breech, a beat behind the muzzle. It is what makes it a machine.
    s.tone({
      freq: 200,
      to: 120,
      type: 'square',
      dur: 0.1,
      gain: 0.3 * at.vol,
      pan: at.pan,
      delay: 0.3,
    });
  },

  /**
   * The close-range answer to being rushed, and the sound that tells a player
   * they have got too near.
   *
   * The first pass was an autocannon an octave down, and the suite was right
   * to reject it: at three and a half rounds a second against the
   * autocannon's six, "the same gun, slightly lower" is not something anyone
   * identifies mid-fight. So it is a *double knock* instead — two deep bursts
   * twenty-five milliseconds apart, which no other weapon in the table does
   * and which reads as a much heavier action even at a distance.
   */
  wardrepeater(s, at) {
    for (let i = 0; i < 2; i++) {
      s.noise({ dur: 0.06, freq: 800, gain: 0.5 * at.vol, pan: at.pan, delay: i * 0.025 });
    }
    s.tone({ freq: 104, to: 44, type: 'sawtooth', dur: 0.1, gain: 0.52 * at.vol, pan: at.pan });
  },
};

/**
 * Fallbacks by projectile kind, for a weapon added to `content.js` before
 * anyone has written it a voice. The test says every weapon has its own; this
 * exists so the *game* still makes a noise in the window between the two.
 *
 * @type {Record<string, (s: Synth, at: Place) => void>}
 */
export const PROJECTILE_VOICES = {
  tracer: WEAPON_VOICES.autocannon,
  rocket: WEAPON_VOICES.lightrockets,
  shell: WEAPON_VOICES.siegemortar,
  beam: WEAPON_VOICES.beamlance,
};

/**
 * What a warhead sounds like when it arrives. The counter triangle is the
 * central decision in the game, so the four warheads are four unmistakably
 * different arrivals: kinetic pings off plate, explosive thuds, energy
 * sizzles, EMP crackles and does no damage worth hearing.
 *
 * @type {Record<string, (s: Synth, at: Place) => void>}
 */
export const IMPACT_VOICES = {
  kinetic(s, at) {
    s.tone({ freq: 2600, to: 1100, type: 'triangle', dur: 0.05, gain: 0.16 * at.vol, pan: at.pan });
    s.noise({ dur: 0.05, freq: 3200, filter: 'highpass', gain: 0.24 * at.vol, pan: at.pan });
  },
  explosive(s, at) {
    s.noise({ dur: 0.11, freq: 700, gain: 0.34 * at.vol, pan: at.pan });
    s.tone({ freq: 105, to: 48, type: 'sine', dur: 0.11, gain: 0.3 * at.vol, pan: at.pan });
  },
  energy(s, at) {
    s.noise({ dur: 0.13, freq: 2600, filter: 'bandpass', q: 4, gain: 0.26 * at.vol, pan: at.pan });
    s.tone({ freq: 1900, to: 520, type: 'sine', dur: 0.09, gain: 0.14 * at.vol, pan: at.pan });
  },
  emp(s, at) {
    for (let i = 0; i < 3; i++) {
      s.noise({
        dur: 0.025,
        freq: 5000,
        filter: 'highpass',
        gain: 0.18 * at.vol,
        pan: at.pan,
        delay: i * 0.03,
        drop: false,
      });
    }
  },
};

/**
 * Active abilities.
 *
 * `jumpjet` and `siege` are deliberately absent: both already announce
 * themselves through a second event (`leapStart` and `deploy` respectively),
 * and playing the ability voice as well would double every activation. The
 * test knows about the exemption and checks the events instead.
 *
 * @type {Record<string, (s: Synth, at: Place) => void>}
 */
export const ABILITY_VOICES = {
  /** Afterburn: a turbine spooling up, and staying up. */
  dash(s, at) {
    s.tone({ freq: 200, to: 900, type: 'sawtooth', dur: 0.5, gain: 0.22 * at.vol, pan: at.pan });
    s.noise({ dur: 0.55, freq: 1400, filter: 'bandpass', q: 2, gain: 0.3 * at.vol, pan: at.pan, drop: false });
  },

  /** Aegis Field: a shield is a chord, not a bang. */
  overshield(s, at) {
    for (const [i, mult] of [1, 1.5, 2, 3].entries()) {
      s.tone({
        freq: 220 * mult,
        to: 226 * mult,
        type: 'triangle',
        dur: 0.6,
        gain: 0.16 * at.vol,
        pan: at.pan,
        delay: i * 0.04,
      });
    }
  },

  /** Field Repair: welding, over a warm pad. */
  repairfield(s, at) {
    s.tone({ freq: 330, to: 495, type: 'triangle', dur: 0.45, gain: 0.2 * at.vol, pan: at.pan });
    for (let i = 0; i < 6; i++) {
      s.noise({
        dur: 0.02,
        freq: 3000,
        filter: 'highpass',
        gain: 0.12 * at.vol,
        pan: at.pan,
        delay: 0.06 + i * 0.055,
        drop: false,
      });
    }
  },

  /** EMP Burst: everything in four cells goes quiet, and you hear it happen. */
  empburst(s, at) {
    s.tone({ freq: 1600, to: 40, type: 'sawtooth', dur: 0.7, gain: 0.4 * at.vol, pan: at.pan });
    s.tone({ freq: 55, to: 44, type: 'sine', dur: 0.9, gain: 0.7 * at.vol, pan: at.pan });
    s.noise({ dur: 0.5, freq: 3000, filter: 'bandpass', q: 5, gain: 0.3 * at.vol, pan: at.pan });
  },

  /**
   * Skyfall — thirty-six cells, on top of the leap's own whoosh.
   *
   * This is the crew's signature move and the loudest thing a friendly unit
   * does, which is the point: when a pilot crosses half the map, the player
   * should know without looking that it was one of *theirs*.
   */
  skyfall(s, at) {
    s.tone({ freq: 60, to: 260, type: 'sawtooth', dur: 0.75, gain: 0.55 * at.vol, pan: at.pan });
    s.noise({ dur: 0.85, freq: 700, filter: 'bandpass', q: 0.9, gain: 0.6 * at.vol, pan: at.pan, drop: false });
  },
};

/**
 * What kind of thing came apart, as a cue name.
 *
 * A mech, a structure and a lamp post are three different collapses and the
 * synthesised `deathVoice` already treats them as three. This is the same
 * split written as data, so the recorded layer can honour it and so the pack
 * tool knows there are three recordings to make rather than one.
 *
 * @type {Record<string, string>}
 */
export const DEATH_CUES = {
  mech: 'world.deathMech',
  building: 'world.deathBuilding',
  prop: 'world.deathProp',
};

/**
 * Order acknowledgements, as formant pairs.
 *
 * Command & Conquer answered every order with a voice line, and half of why
 * those games feel responsive is that the acknowledgement arrives before the
 * unit has moved a pixel. So the acknowledgement is synthesised the way a
 * vocal tract makes one: a buzzing source at the pitch of a voice, run through
 * two resonant band-passes sitting where a human's first and second formants
 * sit for that vowel.
 *
 * It does not say a word and it is not trying to. It answers, in a voice, on
 * a radio — which is the whole job, and it is the job it keeps doing on the
 * day nobody has recorded a pilot yet.
 *
 * The `ack.*` cues in `audio-cues.js` are where recorded lines go when someone
 * does record them, and the two layers coexist rather than compete: a session
 * that captures "moving out" and "engaging" but not "holding" gets recorded
 * voices for two orders and a formant answer for the third, which is a mixed
 * crew rather than a broken one.
 *
 * F1/F2 in Hz, then a relative pitch multiplier for the syllable.
 */
const VOWELS = {
  ah: [730, 1090],
  eh: [530, 1840],
  ee: [270, 2290],
  oh: [570, 840],
  oo: [300, 870],
};

/** @type {Record<string, {syllables: Array<[keyof VOWELS, number]>, gain?: number}>} */
export const ACK_VOICES = {
  /** Selection: an ident, not an answer. One syllable, up top. */
  select: { syllables: [['ee', 1.15]], gain: 0.5 },
  /** "Moving out." Rising, unbothered. */
  move: { syllables: [['oh', 0.95], ['ee', 1.2]] },
  /** "Engaging." Lower and harder than a move order. */
  attack: { syllables: [['ah', 0.85], ['ah', 0.78]] },
  /** Attack-move: the same answer, held longer — you are walking into it. */
  attackmove: { syllables: [['ah', 0.85], ['oh', 0.95], ['ah', 0.8]] },
  /** Harvesting is work, and it answers like work. */
  harvest: { syllables: [['oo', 0.9], ['eh', 1.0]] },
  /** "Holding." One flat syllable. */
  stop: { syllables: [['eh', 0.8]], gain: 0.8 },
  /** Ability: keyed up. */
  ability: { syllables: [['ah', 1.05], ['oo', 1.3]] },
  /** Refusal — not a vowel any human makes, on purpose. */
  deny: { syllables: [['oo', 0.5]], gain: 0.9 },
};

/**
 * Which acknowledgement a command earns.
 *
 * The split that matters: an order given to a *machine with a pilot in it*
 * gets a voice, and an order given to the *base* gets a click. Selling a
 * refinery is a decision you made with a mouse; telling a Kestrel to walk into
 * a fight is a decision someone else has to carry out, and only one of those
 * should answer you.
 *
 * `null` means deliberately silent. `steer` is silent because driving emits a
 * command on every change of stick direction.
 *
 * @type {Record<string, string|null>}
 */
export const ORDER_ACKS = {
  move: 'move',
  attackMove: 'attackmove',
  attack: 'attack',
  harvest: 'harvest',
  stop: 'stop',
  hold: 'stop',
  ability: 'ability',
  build: 'click',
  train: 'click',
  cancelTrain: 'click',
  sell: 'click',
  repair: 'click',
  rally: 'click',
  superweapon: 'click',
  steer: null,
};

/**
 * Events that carry a map position but must be heard wherever the camera is.
 *
 * The distance cull is right for a rifle and wrong for a notification. A
 * reinforcement drop lands at the mission start point and a Lance fires from
 * the enemy base — both are *usually* far off screen, so culling them by
 * distance silences the cue in exactly the case the player relies on it. These
 * keep their pan as a hint of direction when they happen to be close, and are
 * never dropped for being far.
 *
 * `deposit` is deliberately absent. It is the only repeating one of these —
 * economy texture rather than a one-shot notification — and a collector
 * chiming at full volume from a base the player has scouted away from is
 * noise, not information.
 */
export const UNMISSABLE_EVENTS = new Set([
  'reinforcement',
  'superweaponFired',
  'superweaponReady',
  'objectiveComplete',
  'objectiveFailed',
  'missionEnd',
  'gameOver',
  'built',
  'produced',
  'sold',
  'placed',
  'promoted',
  'repairStalled',
  // A shaft opening under the headquarters happens wherever the headquarters
  // was, which is routinely nowhere near the camera. It is also the single
  // biggest thing that happens in a challenge, so it comes back centred
  // rather than not at all — the same argument as a mid-mission arrival.
  'gatewayOpened',
  'gatewayEntered',
]);

/** Beyond this many pixels outside the viewport, a world sound is not heard. */
export const EARSHOT = 900;

/**
 * The place an interface sound happens: nowhere, at full volume.
 *
 * A click has no position on the map and `place()` is never asked about one.
 * Naming the constant rather than writing `{ pan: 0, vol: 1 }` at each call
 * site is what makes "interface sound, therefore centred and undimmed" a
 * statement in the code rather than a coincidence between four literals.
 */
export const CENTRE = { pan: 0, vol: 1 };

/**
 * Where on the stereo field and how loud, given where the camera is — or
 * `null` for a world sound that happened out of earshot.
 *
 * Off-screen events fade with distance rather than cutting off at the viewport
 * edge: hearing a fight start just off-screen is real information, and losing
 * it made scouting feel deaf.
 *
 * Pure, and takes the renderer as an argument, so the suite can hand it a fake
 * camera and check the decision without an AudioContext — which is the only
 * reason the cull is testable at all.
 *
 * @param {{type: string, x?: number, y?: number}} ev
 * @param {{worldToScreen: Function, viewWidth: Function, viewHeight: Function}} renderer
 * @returns {{pan: number, vol: number}|null}
 */
export function place(ev, renderer) {
  if (ev.x === undefined) return { pan: 0, vol: 1 };
  const s = renderer.worldToScreen(ev.x, ev.y);
  const w = renderer.viewWidth();
  const h = renderer.viewHeight();
  const pan = Math.max(-1, Math.min(1, (s.x / w) * 2 - 1)) * 0.7;
  const dx = s.x < 0 ? -s.x : s.x > w ? s.x - w : 0;
  const dy = s.y < 0 ? -s.y : s.y > h ? s.y - h : 0;
  const off = Math.sqrt(dx * dx + dy * dy);
  if (off <= 0) return { pan, vol: 1 };
  if (off > EARSHOT) {
    // Out of earshot. A world sound is gone; a notification comes back
    // centred at full volume rather than not at all.
    return UNMISSABLE_EVENTS.has(ev.type) ? { pan: 0, vol: 1 } : null;
  }
  return { pan, vol: 1 - off / EARSHOT };
}

/* =================================================================== synth */

/**
 * The oscillator kit, over any AudioContext you hand it.
 *
 * Taking the context as an argument rather than closing over a private one is
 * what makes the *sound* testable rather than only the wiring. `sound.spec.js`
 * builds one of these on an `OfflineAudioContext`, renders each weapon to a
 * buffer faster than real time, and measures it: a recipe that is inaudible,
 * one that clips, and two recipes that are secretly the same sound are all
 * things a mapping test cannot see and a rendered waveform can.
 *
 * @param {BaseAudioContext} ctx
 * @param {{world: AudioNode, ui: AudioNode, reserve?: Function}} buses
 *   `reserve(dur, delay, critical)` returns false to refuse a layer when the
 *   mix is full. Offline renders pass nothing and get no ceiling, which is
 *   what you want when the thing under test is one sound on its own.
 */
export function createSynth(ctx, { world, ui, reserve = () => true }) {
  /** One oscillator with a pitch ramp and an exponential decay. */
  function tone({ freq, to = freq, type = 'square', dur = 0.08, gain = 1, pan = 0, delay = 0, bus }) {
    if (!reserve(dur, delay, bus === ui)) return;
    const t0 = ctx.currentTime + delay;
    const osc = ctx.createOscillator();
    const env = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t0);
    if (to !== freq) osc.frequency.exponentialRampToValueAtTime(Math.max(1, to), t0 + dur);
    env.gain.setValueAtTime(Math.max(0.0001, gain), t0);
    env.gain.exponentialRampToValueAtTime(0.001, t0 + dur);
    osc.connect(env);
    connectSpatial(env, pan, t0, bus);
    osc.start(t0);
    osc.stop(t0 + dur + 0.05);
  }

  /**
   * A burst of filtered noise — impacts, explosions, rocket exhaust, static.
   *
   * `filter` picks the character: lowpass for weight, highpass for air and
   * crackle, bandpass for the hollow hiss a rocket motor makes.
   */
  function noise({
    dur = 0.2,
    freq = 800,
    q = 1,
    gain = 1,
    pan = 0,
    drop = true,
    delay = 0,
    filter: kind = 'lowpass',
    bus,
  }) {
    if (!reserve(dur, delay, bus === ui)) return;
    const t0 = ctx.currentTime + delay;
    const src = noiseSource();

    const filter = ctx.createBiquadFilter();
    filter.type = kind;
    filter.frequency.setValueAtTime(freq, t0);
    if (drop) filter.frequency.exponentialRampToValueAtTime(Math.max(40, freq / 8), t0 + dur);
    filter.Q.value = q;
    const env = ctx.createGain();
    env.gain.setValueAtTime(Math.max(0.0001, gain), t0);
    env.gain.exponentialRampToValueAtTime(0.001, t0 + dur);
    src.connect(filter);
    filter.connect(env);
    connectSpatial(env, pan, t0, bus);
    // A random start offset into the shared buffer, so ten impacts in a second
    // are not ten copies of the same waveform — which the ear hears as a
    // ringing pitch rather than as noise.
    src.start(t0, Math.random() * 0.9);
    src.stop(t0 + dur + 0.05);
  }

  /**
   * Two seconds of white noise, generated once and replayed from an offset.
   *
   * Filling a fresh buffer per burst was the single most expensive thing this
   * module did — a busy frame is a dozen bursts, and each one was a
   * `Math.random()` loop the length of its own duration. One shared looping
   * buffer read from a random offset is indistinguishable and costs nothing.
   */
  let noiseBuffer = null;
  function noiseSource() {
    if (!noiseBuffer) {
      const samples = Math.floor(ctx.sampleRate * 2);
      noiseBuffer = ctx.createBuffer(1, samples, ctx.sampleRate);
      const data = noiseBuffer.getChannelData(0);
      // Math.random is fine here: this is presentation, on the far side of the
      // determinism wall — the same wall that lets the renderer throw sparks.
      for (let i = 0; i < samples; i++) data[i] = Math.random() * 2 - 1;
    }
    const src = ctx.createBufferSource();
    src.buffer = noiseBuffer;
    // Looping so that an offset near the end of the buffer still fills a long
    // burst — the skyfall roar is most of a second on its own.
    src.loop = true;
    return src;
  }

  function connectSpatial(node, pan, t0, bus) {
    const target = bus || world;
    if (ctx.createStereoPanner && pan !== 0) {
      const panner = ctx.createStereoPanner();
      panner.pan.setValueAtTime(Math.max(-1, Math.min(1, pan)), t0);
      node.connect(panner);
      panner.connect(target);
    } else {
      node.connect(target);
    }
  }

  /** A little rising arpeggio — promotions, unlocks, good news. */
  function chime(base, steps, pan = 0, bus = ui) {
    for (let i = 0; i < steps; i++) {
      tone({
        freq: base * Math.pow(1.5, i),
        type: 'triangle',
        dur: 0.11,
        gain: 0.7,
        pan,
        delay: i * 0.07,
        bus,
      });
    }
  }

  /**
   * A voice, over a radio.
   *
   * A sawtooth at speech pitch is the glottal source; two narrow band-passes
   * in parallel are the vocal tract. Move the band-passes between vowels and
   * the same buzz becomes different syllables. The high-pass at the end is the
   * radio: a comms channel has no bottom, and taking the bottom out is most of
   * why this reads as "someone answered" rather than "a synth played".
   */
  function vox({ syllables, f0 = 118, gain = 1, pan = 0, delay = 0 }) {
    const each = 0.1;
    const total = syllables.length * each + 0.05;
    if (!reserve(total, delay, true)) return;
    const t0 = ctx.currentTime + delay;

    const osc = ctx.createOscillator();
    osc.type = 'sawtooth';

    const radio = ctx.createBiquadFilter();
    radio.type = 'highpass';
    radio.frequency.value = 380;

    const env = ctx.createGain();
    env.gain.setValueAtTime(0.0001, t0);

    const f1 = ctx.createBiquadFilter();
    f1.type = 'bandpass';
    f1.Q.value = 7;
    const f2 = ctx.createBiquadFilter();
    f2.type = 'bandpass';
    f2.Q.value = 9;

    osc.connect(f1);
    osc.connect(f2);
    f1.connect(env);
    f2.connect(env);
    env.connect(radio);
    connectSpatial(radio, pan, t0, ui);

    syllables.forEach(([vowel, pitch], i) => {
      const t = t0 + i * each;
      const [a, b] = VOWELS[vowel] || VOWELS.ah;
      osc.frequency.setValueAtTime(f0 * pitch, t);
      // A little downward drift inside the syllable. Perfectly flat pitch is
      // the difference between a voice and a test tone.
      osc.frequency.linearRampToValueAtTime(f0 * pitch * 0.94, t + each * 0.9);
      f1.frequency.setValueAtTime(a, t);
      f2.frequency.setValueAtTime(b, t);
      // Gate each syllable, so two syllables are two words and not one hum.
      env.gain.setValueAtTime(0.0001, t);
      env.gain.exponentialRampToValueAtTime(0.5 * gain, t + 0.012);
      env.gain.setValueAtTime(0.5 * gain, t + each * 0.62);
      env.gain.exponentialRampToValueAtTime(0.0001, t + each * 0.92);
    });

    osc.start(t0);
    osc.stop(t0 + total);
  }

  return { tone, noise, chime, vox };
}

/* ================================================================== module */

const MASTER_VOLUME = 0.22;
const MUTE_KEY = 'rocketman.muted.v1';
const VOLUME_KEY = 'rocketman.volume.v1';

/**
 * How many scheduled voices may be alive at once.
 *
 * A tank farm going up sets off its neighbours, which set off theirs; without
 * a ceiling a single fuel depot can schedule three hundred oscillators in one
 * frame and the tab audibly stalls. Past the ceiling new sounds are dropped
 * rather than queued — a sound that arrives late is worse than one that never
 * arrived, because it desynchronises from the picture.
 */
const MAX_VOICES = 28;

/**
 * Where the audio pack is served from, relative to the page.
 *
 * A directory rather than a bundled import, because the pack is tens of
 * megabytes of recordings that must stay out of the JavaScript bundle, out of
 * git, and cacheable independently of the code. `tools/audio-pack.mjs` writes
 * it; `audio/README.md` explains how it gets deployed.
 *
 * `../audio/` and not `./audio/`, because this resolves against the *page* —
 * `web/rocketman.html` — and the pack is a sibling of `web/` rather than a
 * child of it. Recordings are not source and do not belong in the source
 * directory. The Android asset tree mirrors the same shape (`game/web/` and
 * `game/audio/`) so that one path works everywhere.
 */
const AUDIO_BASE = '../audio/';

export function createSound({ audioBase = AUDIO_BASE } = {}) {
  let ctx = null;
  let master = null;
  let worldBus = null;
  let uiBus = null;
  let muted = readStored(MUTE_KEY) === '1';
  let volume = clampVolume(parseFloat(readStored(VOLUME_KEY)));

  /** The recorded layer and the score. Null until there is a context. */
  let samples = null;
  let music = null;

  /** Scheduled end times, in context seconds, of everything currently alive. */
  let voices = [];

  /** Per-event-type budget: how many may sound in one frame, and a floor
   *  between repeats — twenty mechs firing at once is a battle, not a rave. */
  const limits = {
    fire: { perFrame: 4, gapMs: 32, last: 0 },
    impact: { perFrame: 3, gapMs: 45, last: 0 },
    explosion: { perFrame: 3, gapMs: 30, last: 0 },
    shieldBreak: { perFrame: 2, gapMs: 80, last: 0 },
    death: { perFrame: 3, gapMs: 40, last: 0 },
    deposit: { perFrame: 1, gapMs: 350, last: 0 },
    leapStart: { perFrame: 2, gapMs: 90, last: 0 },
    leapEnd: { perFrame: 2, gapMs: 90, last: 0 },
    // One arc projector disables everything in a 2.2-cell splash, and every
    // one of those pushes its own `emp`. Unlimited, that is a wall of static.
    emp: { perFrame: 1, gapMs: 220, last: 0 },
    ack: { perFrame: 1, gapMs: 260, last: 0 },
    built: { perFrame: 2, gapMs: 120, last: 0 },
  };

  function readStored(key) {
    try {
      return window.localStorage.getItem(key);
    } catch {
      return null;
    }
  }

  function writeStored(key, value) {
    try {
      window.localStorage.setItem(key, value);
    } catch {
      /* preference just does not persist */
    }
  }

  function clampVolume(v) {
    return Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 1;
  }

  function ensureContext() {
    if (ctx || muted) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    try {
      ctx = new AC();

      // A limiter across the whole mix. Without it, a chain reaction in a fuel
      // depot is not loud — it is *clipped*, which is a different and much
      // worse sound. The slow release lets a big blast duck the battle under
      // it for a moment, which is free drama.
      const comp = ctx.createDynamicsCompressor();
      comp.threshold.value = -18;
      comp.knee.value = 12;
      comp.ratio.value = 8;
      comp.attack.value = 0.003;
      comp.release.value = 0.22;
      comp.connect(ctx.destination);

      master = ctx.createGain();
      master.gain.value = MASTER_VOLUME * volume;
      master.connect(comp);

      // Two buses, because they answer to different rules. World sound is
      // spatial and expendable — it pans, it fades with distance, and it is
      // the first thing dropped when the voice ceiling is hit. Interface
      // sound is centred, quieter, and must never be dropped: an
      // acknowledgement that goes missing reads as an order that went
      // missing, and the player will click again.
      worldBus = ctx.createGain();
      worldBus.gain.value = 1;
      worldBus.connect(master);

      uiBus = ctx.createGain();
      uiBus.gain.value = 0.85;
      uiBus.connect(master);

      synth = createSynth(ctx, { world: worldBus, ui: uiBus, reserve });

      // The recorded layer, and the score. Both attach to the mix that already
      // exists rather than building one of their own, so a take goes through
      // the same limiter and the same voice ceiling as an oscillator does.
      samples = createSampleBank(ctx, { world: worldBus, ui: uiBus, reserve, base: audioBase });
      music = createMusic(ctx, { destination: master, base: audioBase });

      // Deliberately not awaited. The game is already running and already
      // making noise; the pack lands cue by cue underneath it.
      samples
        .load()
        .then(() => samples.manifest && music.adopt(samples.manifest))
        .catch(() => {});
    } catch {
      ctx = null;
      synth = null;
      samples = null;
      music = null;
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

  /* ------------------------------------------------------- voice budget -- */

  /** Everything ever scheduled, and everything ever refused for want of a
   *  slot. Only read by `stats()`, which only the browser suite reads. */
  let scheduled = 0;
  let dropped = 0;

  /** Reserve a voice slot for `dur` seconds. False means the mix is full. */
  function reserve(dur, delay, critical) {
    const now = ctx.currentTime;
    if (voices.length >= MAX_VOICES) voices = voices.filter((t) => t > now);
    if (!critical && voices.length >= MAX_VOICES) {
      dropped++;
      return false;
    }
    voices.push(now + delay + dur);
    scheduled++;
    return true;
  }

  /**
   * The synth, built the moment there is a context to build it on. Null
   * before then — which every caller already handles, because `ctx` is null
   * at the same times.
   */
  let synth = null;

  // Thin delegates, so the event handlers below read as `tone(...)` rather
  // than `synth.tone(...)` and so a call that slips past the `ctx` guard is a
  // no-op rather than a crash on null.
  const tone = (opts) => synth && synth.tone(opts);
  const noise = (opts) => synth && synth.noise(opts);
  const chime = (base, steps, pan, bus) => synth && synth.chime(base, steps, pan, bus);
  const vox = (opts) => synth && synth.vox(opts);

  /**
   * Make one sound: the recording if there is one, the oscillators if not.
   *
   * Every noise the game makes goes through here, which is what keeps the two
   * layers from drifting. A cue name without a fallback would be a sound that
   * exists only once someone has recorded it — that is a content hole hiding
   * behind an asset pipeline, so `fallback` is required and the suite checks
   * that every call site passes one.
   *
   * The recording wins when it exists. That is the point of recording it, and
   * anything cleverer — layering the synth under the take, crossfading between
   * them by distance — was tried and sounds like two guns.
   *
   * @param {string} cue name from `audio-cues.js`
   * @param {Place} at
   * @param {() => void} fallback the synthesised recipe
   */
  function play(cue, at, fallback) {
    if (samples && samples.play(cue, at)) return;
    fallback();
  }

  /* ----------------------------------------------------------- mapping -- */

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
    const mine = (id) => world.entities.get(id)?.player === viewerId;
    // A campaign mission that ends by objective pushes `missionEnd`, and an
    // annihilation in the same tick pushes `gameOver` too. Both are the same
    // moment and the player should hear one sting, not a chord of two.
    let ended = false;

    for (const ev of events) {
      const at = place(ev, renderer);
      if (!at) continue;
      const { pan, vol } = at;

      switch (ev.type) {
        case 'fire': {
          if (!allow('fire', now)) break;
          const voice = WEAPON_VOICES[ev.weapon] || PROJECTILE_VOICES.tracer;
          play(`weapon.${ev.weapon}`, at, () => voice(synth, at));
          break;
        }
        case 'impact': {
          if (!allow('impact', now)) break;
          const voice = IMPACT_VOICES[ev.damageType] || IMPACT_VOICES.kinetic;
          play(`impact.${ev.damageType}`, at, () => voice(synth, at));
          break;
        }
        case 'explosion': {
          if (!allow('explosion', now)) break;
          const big = !!ev.big;
          // A depot going up pulls the score down under it for a moment. The
          // blast is not louder for it; everything else is quieter, which is
          // the only way to make a mix feel bigger than its ceiling.
          if (big && music) music.duck();
          play(big ? 'world.explosionBig' : 'world.explosion', at, () => {
            noise({ dur: big ? 0.7 : 0.3, freq: big ? 500 : 900, gain: (big ? 1.0 : 0.55) * vol, pan });
            tone({ freq: big ? 90 : 130, to: 40, type: 'sine', dur: big ? 0.5 : 0.25, gain: 0.8 * vol, pan });
          });
          break;
        }
        case 'death': {
          if (!allow('death', now)) break;
          play(DEATH_CUES[ev.kind] || DEATH_CUES.mech, at, () => deathVoice(ev, at));
          break;
        }
        case 'shieldBreak':
          if (!allow('shieldBreak', now)) break;
          play('world.shieldBreak', at, () => {
            tone({ freq: 2200, to: 300, type: 'sawtooth', dur: 0.18, gain: 0.4 * vol, pan });
            noise({ dur: 0.2, freq: 2400, filter: 'bandpass', q: 4, gain: 0.22 * vol, pan });
          });
          break;
        case 'emp':
        case 'empBurst':
          if (!allow('emp', now)) break;
          play('world.emp', at, () => {
            tone({ freq: 60, to: 55, type: 'sine', dur: 0.5, gain: 0.9 * vol, pan });
            tone({ freq: 1800, to: 100, type: 'sawtooth', dur: 0.4, gain: 0.25 * vol, pan });
          });
          break;
        case 'ability': {
          const voice = ABILITY_VOICES[ev.ability];
          if (voice) play(`ability.${ev.ability}`, at, () => voice(synth, at));
          break;
        }
        case 'deploy':
          // Anchors down, or anchors up. Two clunks, second one lower.
          play(ev.deployed ? 'world.deployDown' : 'world.deployUp', at, () => {
            noise({ dur: 0.09, freq: 900, gain: 0.5 * vol, pan });
            tone({
              freq: ev.deployed ? 190 : 260,
              to: ev.deployed ? 80 : 150,
              type: 'square',
              dur: 0.14,
              gain: 0.45 * vol,
              pan,
              delay: 0.07,
            });
            noise({ dur: 0.12, freq: 500, gain: 0.4 * vol, pan, delay: 0.07 });
          });
          break;
        case 'leapStart':
          if (!allow('leapStart', now)) break;
          play('world.leapStart', at, () => {
            noise({ dur: 0.25, freq: 600, gain: 0.3 * vol, pan, drop: false });
            tone({ freq: 140, to: 420, type: 'sawtooth', dur: 0.22, gain: 0.14 * vol, pan });
          });
          break;
        case 'leapEnd':
          // The landing. Without it a jump has a take-off and no arrival, and
          // the mech reads as having teleported.
          if (!allow('leapEnd', now)) break;
          play('world.leapEnd', at, () => {
            noise({ dur: 0.16, freq: 420, gain: 0.5 * vol, pan });
            tone({ freq: 90, to: 42, type: 'sine', dur: 0.18, gain: 0.5 * vol, pan });
          });
          break;
        case 'deposit':
          if (!mine(ev.id)) break;
          if (!allow('deposit', now)) break;
          play('ui.deposit', at, () => {
            tone({ freq: 1050, type: 'triangle', dur: 0.05, gain: 0.4, pan, bus: uiBus });
            tone({ freq: 1550, type: 'triangle', dur: 0.06, gain: 0.4, pan, delay: 0.06, bus: uiBus });
          });
          break;
        case 'promoted':
          if (mine(ev.id)) play('ui.promoted', at, () => chime(500, 3, pan));
          break;
        case 'placed':
          if (ev.player === viewerId) {
            play('ui.placed', at, () =>
              noise({ dur: 0.15, freq: 300, gain: 0.5, pan, bus: uiBus, drop: false })
            );
          }
          break;
        case 'built':
          // Construction finished. `placed` was the foundation going down;
          // this is the thing standing up, and they are different moments.
          if (ev.player !== viewerId) break;
          if (!allow('built', now)) break;
          play('ui.built', at, () => {
            tone({ freq: 280, to: 300, type: 'triangle', dur: 0.12, gain: 0.45, pan, bus: uiBus });
            tone({ freq: 420, to: 450, type: 'triangle', dur: 0.16, gain: 0.45, pan, delay: 0.1, bus: uiBus });
            noise({ dur: 0.1, freq: 400, gain: 0.3, pan, bus: uiBus });
          });
          break;
        case 'produced':
          if (ev.player === viewerId) {
            play('ui.produced', at, () =>
              tone({ freq: 350, to: 520, type: 'triangle', dur: 0.1, gain: 0.5, pan, bus: uiBus })
            );
          }
          break;
        case 'sold':
          if (ev.player === viewerId) play('ui.sold', at, () => chime(700, 2, pan));
          break;
        case 'repairStalled':
          // Out of scrap mid-repair. A warning, and it should sound like one.
          if (ev.player !== viewerId) break;
          play('ui.repairStalled', at, () => {
            tone({ freq: 320, to: 300, type: 'square', dur: 0.14, gain: 0.3, pan: 0, bus: uiBus });
            tone({ freq: 240, to: 220, type: 'square', dur: 0.2, gain: 0.3, pan: 0, delay: 0.16, bus: uiBus });
          });
          break;
        case 'reinforcement':
          // A pilot the crew had written off walks out of the fog. This is the
          // biggest thing that happens in a mission and it gets a fanfare.
          if (ev.player !== viewerId) break;
          play('ui.reinforcement', at, () => {
            for (const [i, mult] of [1, 1.5, 2].entries()) {
              tone({
                freq: 262 * mult,
                type: 'triangle',
                dur: 0.5,
                gain: 0.5,
                pan: 0,
                delay: i * 0.13,
                bus: uiBus,
              });
            }
          });
          break;
        /**
         * A way off the map opening.
         *
         * Positional rather than an interface chime: it happens *there*, at
         * whatever the crew just brought down, and the camera cuts to it. The
         * long sub-bass under the rubble is the whole point — something large
         * moved, and it moved somewhere else on the map.
         */
        case 'gatewayOpened':
          noise({ dur: 1.3, freq: 260, gain: 0.9 * vol, pan });
          tone({ freq: 60, to: 28, type: 'sine', dur: 1.6, gain: 1.0 * vol, pan });
          tone({
            freq: 180,
            to: 420,
            type: 'triangle',
            dur: 1.1,
            gain: 0.4 * vol,
            pan,
            delay: 0.35,
          });
          break;
        case 'gatewayEntered':
          // Going through. Rising, and it stops rather than resolving — the
          // debrief is the resolution.
          tone({ freq: 300, to: 900, type: 'sine', dur: 0.7, gain: 0.5, pan: 0, bus: uiBus });
          tone({ freq: 150, to: 450, type: 'triangle', dur: 0.9, gain: 0.4, pan: 0, bus: uiBus });
          break;
        case 'objectiveComplete':
          if (ev.optional) play('ui.objectiveBonus', at, () => chime(660, 2, 0));
          else play('ui.objectiveComplete', at, () => chime(523, 3, 0));
          break;
        case 'objectiveFailed':
          play('ui.objectiveFailed', at, () => {
            tone({ freq: 330, to: 160, type: 'sawtooth', dur: 0.5, gain: 0.45, pan: 0, bus: uiBus });
            tone({ freq: 220, to: 110, type: 'sawtooth', dur: 0.6, gain: 0.35, pan: 0, delay: 0.1, bus: uiBus });
          });
          break;
        case 'superweaponReady':
          if (ev.player === viewerId) play('ui.superweaponReady', at, () => chime(400, 4, 0));
          break;
        case 'superweaponFired':
          // Everyone hears a Lance fire, wherever the camera is. That is the
          // telegraph doing its job.
          play('world.superweaponFired', at, () =>
            tone({ freq: 200, to: 1400, type: 'sawtooth', dur: 1.0, gain: 0.5, pan: 0 })
          );
          break;
        case 'superweapon':
          if (music) music.duck(0.7, 2.4);
          play('world.superweaponImpact', at, () => {
            noise({ dur: 1.1, freq: 400, gain: 1.2 * (vol || 1), pan });
            tone({ freq: 70, to: 35, type: 'sine', dur: 0.9, gain: 1.0, pan });
          });
          break;
        case 'missionEnd':
          if (ended) break;
          ended = true;
          endSting(ev.result === 'won', at);
          break;
        case 'gameOver':
          if (ended) break;
          ended = true;
          endSting(ev.winner === viewerId, at);
          break;
        default:
          break;
      }
    }

    // The score reads the same event stream, one step behind: what just
    // happened decides what should be playing, and `music.update` refuses to
    // act on a single frame of it. See `music.js` for why that matters.
    if (music) music.update(stateFromEvents(events, viewerId));
  }

  /**
   * Won or lost, played once.
   *
   * Split out because two different events reach it — a campaign mission that
   * ends by objective and an annihilation in the same tick — and the sting has
   * to be identical either way or the same moment sounds like two moments.
   */
  function endSting(won, at) {
    play(won ? 'ui.victory' : 'ui.defeat', at, () => {
      if (won) chime(440, 5, 0);
      else tone({ freq: 220, to: 90, type: 'sawtooth', dur: 1.2, gain: 0.6, pan: 0, bus: uiBus });
    });
  }

  /**
   * Something came apart.
   *
   * Anything with a death explosion has already pushed an `explosion` event
   * this same tick, so this is deliberately *not* another bang: it is the
   * wreck arriving — torn metal, a descending groan, and a delayed clang as
   * what is left of it hits the ground. Layered over the blast that preceded
   * it, that reads as one collapse rather than two explosions.
   */
  function deathVoice(ev, at) {
    const { pan, vol } = at;
    if (ev.kind === 'building') {
      noise({ dur: 0.8, freq: 420, gain: 0.7 * vol, pan, delay: 0.1 });
      tone({ freq: 150, to: 34, type: 'sawtooth', dur: 0.7, gain: 0.5 * vol, pan, delay: 0.1 });
      noise({ dur: 0.3, freq: 900, gain: 0.35 * vol, pan, delay: 0.5 });
      return;
    }
    if (ev.kind === 'prop') {
      // Rubble, and more of it the taller the thing was. A fence post does not
      // get a groan; a tower block does.
      const height = ev.height || 1;
      noise({ dur: 0.25 + height * 0.06, freq: 700, gain: 0.4 * vol, pan, delay: 0.08 });
      if (height > 2) {
        tone({ freq: 120, to: 40, type: 'sine', dur: 0.5, gain: 0.45 * vol, pan, delay: 0.12 });
      }
      return;
    }
    noise({ dur: 0.35, freq: 800, gain: 0.45 * vol, pan, delay: 0.06 });
    tone({ freq: 300, to: 70, type: 'sawtooth', dur: 0.32, gain: 0.3 * vol, pan, delay: 0.06 });
    tone({ freq: 700, to: 640, type: 'triangle', dur: 0.16, gain: 0.22 * vol, pan, delay: 0.22 });
  }

  /* --------------------------------------------------------- interface -- */

  /**
   * Acknowledge an order.
   *
   * Called from the one funnel every command in `input.js` passes through, so
   * there is exactly one place that decides what an order sounds like and no
   * call site can forget to make a noise. `seed` varies the pitch — usually
   * the entity id — so the crew sounds like a crew and not like one pilot in
   * twenty cockpits.
   */
  function ack(kind, seed = 0) {
    if (muted || !ctx || ctx.state !== 'running') return;
    const spec = ACK_VOICES[kind];
    if (!spec) return;
    if (!allow('ack', performance.now())) return;
    // Recorded lines carry their own crew variety — that is what the takes
    // are for — so the pitch scatter only applies to the formant fallback.
    play(`ack.${kind}`, CENTRE, () =>
      vox({
        syllables: spec.syllables,
        f0: 104 + (Math.abs(seed) % 6) * 9,
        gain: spec.gain === undefined ? 0.7 : spec.gain,
      })
    );
  }

  /**
   * Answer one command. Wired to `input.js`'s single emit funnel, so the
   * mapping above is the only thing that decides what an order sounds like.
   */
  function order(cmd) {
    const kind = cmd && ORDER_ACKS[cmd.type];
    if (!kind) return;
    if (kind === 'click') {
      click(true);
      return;
    }
    ack(kind, (cmd.ids && cmd.ids[0]) || 0);
  }

  /** A flat interface click — placement, panel buttons, hotkeys. */
  function click(ok = true) {
    if (muted || !ctx || ctx.state !== 'running') return;
    if (ok) {
      play('ui.click', CENTRE, () =>
        tone({ freq: 900, to: 1200, type: 'triangle', dur: 0.03, gain: 0.35, bus: uiBus })
      );
    } else {
      play('ui.deny', CENTRE, () =>
        tone({ freq: 200, to: 140, type: 'square', dur: 0.12, gain: 0.4, bus: uiBus })
      );
    }
  }

  function toggleMute() {
    muted = !muted;
    writeStored(MUTE_KEY, muted ? '1' : '0');
    if (!muted) unlock();
    // Mute used to be nothing but an early return in the event handlers, which
    // was complete when every sound was a one-shot fired from one of them. The
    // score is neither: it is already playing when the button is pressed, and
    // no amount of refusing *new* sounds stops a bed that is mid-loop. So the
    // switch now reaches the master gain as well.
    if (master) master.gain.value = muted ? 0 : MASTER_VOLUME * volume;
    return muted;
  }

  /** 0..1, applied on top of the module's own headroom. */
  function setVolume(v) {
    volume = clampVolume(v);
    writeStored(VOLUME_KEY, String(volume));
    if (master && !muted) master.gain.value = MASTER_VOLUME * volume;
    return volume;
  }

  /**
   * Read-only inspection hook, for the same reason the renderer has one.
   *
   * A browser test can prove the page did not throw, which is not the same
   * fact as the game having made a sound — and those two came apart once
   * already, when every weapon still played and the mixer was silently
   * refusing every voice. `scheduled` is the number that tells them apart.
   */
  function stats() {
    return {
      context: ctx ? ctx.state : null,
      muted,
      volume,
      scheduled,
      dropped,
      live: ctx ? voices.filter((t) => t > ctx.currentTime).length : 0,
      // How much of the mix is coming from recordings rather than from
      // oscillators. `samples.cues` at zero with a deployed pack is the
      // failure this number exists to catch: the game sounds fine, because
      // the synth covers for it, and nothing else would ever say so.
      samples: samples ? samples.stats() : null,
      music: music ? music.stats() : null,
    };
  }

  /**
   * Put the score somewhere directly — menus and end screens, which are not
   * in the event stream because they are not in the simulation.
   */
  function setMusicState(state) {
    ensureContext();
    if (music) music.go(state);
  }

  return {
    consume,
    ack,
    order,
    click,
    stats,
    toggleMute,
    setVolume,
    setMusicState,
    setMusicVolume: (v) => (music ? music.setVolume(v) : v),
    stopMusic: () => music && music.stop(),
    get volume() {
      return volume;
    },
    get musicVolume() {
      return music ? music.volume : null;
    },
    get muted() {
      return muted;
    },
  };
}

/**
 * @typedef {{pan: number, vol: number}} Place
 * @typedef {{
 *   tone: (opts: object) => void,
 *   noise: (opts: object) => void,
 *   chime: (base: number, steps: number, pan?: number) => void,
 *   vox: (opts: object) => void,
 * }} Synth
 */
