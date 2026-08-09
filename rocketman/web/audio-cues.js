/**
 * The cue catalogue — every sound the game can make, as data.
 *
 * `sound.js` synthesises the whole palette from oscillators, and that stays
 * true: the synth is the *floor*, not a placeholder. It ships in the single
 * file build, it works with no network and no assets, and it is what a browser
 * that refuses to decode Opus falls back to. What this file adds is a ceiling
 * — a name for each sound, so a recorded take can be dropped in front of the
 * synthesised one without touching the mixer.
 *
 * Four things read this table and they must not drift apart:
 *
 *   - `samples.js` looks up a cue to decide gain, pitch jitter and which bus.
 *   - `tools/audio-pack.mjs` walks it to know what to encode and what is still
 *     missing from the recording sessions.
 *   - `tools/audio-cue-sheet.mjs` renders it to `audio/CUE-SHEET.md`, which is
 *     the sheet you take into the room with the microphone.
 *   - `test/audio.test.js` checks it against `content.js`, so a weapon added
 *     to the game without a cue fails the suite rather than shipping mute.
 *
 * ## Why the mix lives here and not in the files
 *
 * A sound library arrives at whatever level the studio mastered it, and a
 * session recorded across two days arrives at two levels. If those levels
 * reach the game, then the mix is a property of the files, and rebalancing a
 * weapon means re-exporting audio.
 *
 * So the pack tool flattens every take to one reference level and `gain` here
 * does all the mixing. Loudness is a decision about the *game* — a repeater
 * firing six times a second has to sit under a mortar firing once every three
 * seconds, whatever the two recordings happened to peak at — and decisions
 * about the game belong in a table the tests can read.
 *
 * The gains below start as the peak gains the synthesised voices already use,
 * because that balance is tuned and there is no reason to rediscover it.
 */

/* ============================================================== the classes */

/**
 * Bus assignment, and what it implies.
 *
 * `world` is spatial and expendable: it pans, it fades with distance, and it
 * is the first thing dropped when the voice ceiling is hit. `ui` is centred,
 * never dropped, and never pitch-jittered — an interface sound that arrives at
 * a different pitch each time reads as a glitch rather than as variety.
 */
export const BUSES = ['world', 'ui'];

/**
 * How a take is normalised, which depends on how long it is.
 *
 * Integrated loudness (EBU R128, what `ffmpeg -af loudnorm` measures) is
 * defined over 400 ms blocks. A 45 ms gunshot has no integrated loudness worth
 * the name, and asking for one gives you a number driven by whatever silence
 * happens to sit around the transient. Short cues are peak-normalised instead,
 * which is what they are perceptually judged by anyway — a click is its
 * transient.
 *
 * The crossover is 400 ms because that is where the measurement becomes
 * meaningful, not because it sounds like a round number.
 */
export const LOUDNESS_CROSSOVER_SECONDS = 0.4;

/** Peak-normalisation target for short cues, in dBFS. */
export const PEAK_TARGET_DBFS = -6;

/** Integrated-loudness target for long cues, in LUFS. */
export const LUFS_TARGET = -20;

/** True-peak ceiling every take is limited to, in dBTP. */
export const TRUE_PEAK_CEILING_DBTP = -1;

/** Everything is resampled to this. 48k is what the browsers run at. */
export const SAMPLE_RATE = 48000;

/* =============================================================== the sounds */

/**
 * One entry per sound.
 *
 * - `what`     — what the player is supposed to learn from hearing it. This is
 *                the field that matters at record time; a cue whose purpose
 *                you cannot state in a sentence is a cue that will come back
 *                sounding like its neighbour.
 * - `bus`      — `world` (spatial, droppable) or `ui` (centred, protected).
 * - `takes`    — how many separate recordings to make. Rate of fire drives
 *                this: a sound the player hears twenty times in a fight needs
 *                variants or it becomes a machine, and a sound they hear twice
 *                a mission does not.
 * - `seconds`  — [min, max] length after trimming. The pack tool warns outside
 *                this; it does not truncate, because a cue that wants to be
 *                longer is usually telling you something.
 * - `gain`     — playback gain, and therefore the mix. See the header.
 * - `pitch`    — [lo, hi] playback-rate jitter. Absent means play it as
 *                recorded. Anything on the `ui` bus is deliberately absent.
 * - `loop`     — the sample loops for as long as the state lasts, rather than
 *                firing once. Only the few sustained sounds.
 *
 * @type {Record<string, {
 *   what: string, bus: 'world'|'ui', takes: number,
 *   seconds: [number, number], gain: number,
 *   pitch?: [number, number], loop?: boolean,
 * }>}
 */
export const CUES = {
  /* ------------------------------------------------------------- weapons -- */

  'weapon.autocannon': {
    what: 'The baseline gun. Dry mechanical crack — every other weapon is read against this one.',
    bus: 'world',
    takes: 6,
    seconds: [0.05, 0.25],
    gain: 0.34,
    pitch: [0.94, 1.06],
  },
  'weapon.stormrepeater': {
    what: 'Six shots a second. Each one must be small, or the burst becomes a drill.',
    bus: 'world',
    takes: 8,
    seconds: [0.03, 0.12],
    gain: 0.15,
    pitch: [0.92, 1.08],
  },
  'weapon.scattergun': {
    what: 'Twenty-six damage at three cells. It should sound like a door closing.',
    bus: 'world',
    takes: 5,
    seconds: [0.15, 0.5],
    gain: 0.85,
    pitch: [0.95, 1.05],
  },
  'weapon.turretgun': {
    what: 'Base defence. Heavier than a mech arm, because it is bolted to the ground — this and the autocannon are the two sounds a player hears most, and they must not converge.',
    bus: 'world',
    takes: 6,
    seconds: [0.1, 0.4],
    gain: 0.55,
    pitch: [0.95, 1.05],
  },
  'weapon.flakburst': {
    what: 'Airburst flak. Three pops, because one pop is just a gun.',
    bus: 'world',
    takes: 5,
    seconds: [0.1, 0.35],
    gain: 0.3,
    pitch: [0.94, 1.06],
  },
  'weapon.rocketpod': {
    what: 'Four rockets off the rail. Hiss that climbs as they leave.',
    bus: 'world',
    takes: 4,
    seconds: [0.2, 0.6],
    gain: 0.4,
    pitch: [0.96, 1.04],
  },
  'weapon.lightrockets': {
    what: 'Two rockets, not four. Thinner and brighter than the pod, and gone sooner — it has to be recognised from its first fifty milliseconds.',
    bus: 'world',
    takes: 4,
    seconds: [0.1, 0.35],
    gain: 0.28,
    pitch: [0.96, 1.04],
  },
  'weapon.talon': {
    what: 'Tube-launched. It thumps out cold before the motor lights.',
    bus: 'world',
    takes: 4,
    seconds: [0.2, 0.6],
    gain: 0.55,
    pitch: [0.96, 1.04],
  },
  'weapon.thermite': {
    what: 'Incendiary. Ignition rather than detonation — a whoosh with a chemical edge.',
    bus: 'world',
    takes: 4,
    seconds: [0.2, 0.7],
    gain: 0.45,
    pitch: [0.96, 1.04],
  },
  'weapon.siegemortar': {
    what: 'One shell every three seconds. The heaviest report in the game; it can afford weight the repeater cannot.',
    bus: 'world',
    takes: 4,
    seconds: [0.3, 1.0],
    gain: 0.9,
    pitch: [0.97, 1.03],
  },
  'weapon.railspike': {
    what: 'Electromagnetic. A charge, then a crack with no powder in it — this is the one that must not sound like a cannon.',
    bus: 'world',
    takes: 4,
    seconds: [0.2, 0.7],
    gain: 0.5,
    pitch: [0.97, 1.03],
  },
  'weapon.beamlance': {
    what: 'Continuous energy. Tone, not transient.',
    bus: 'world',
    takes: 3,
    seconds: [0.2, 0.8],
    gain: 0.35,
    pitch: [0.98, 1.02],
  },
  'weapon.empprojector': {
    what: 'Disables rather than damages. It should sound like something being switched off.',
    bus: 'world',
    takes: 3,
    seconds: [0.2, 0.8],
    gain: 0.4,
    pitch: [0.98, 1.02],
  },
  'weapon.arcprojector': {
    what: 'Chained lightning across a splash. Crackle with a path through it.',
    bus: 'world',
    takes: 4,
    seconds: [0.2, 0.8],
    gain: 0.5,
    pitch: [0.97, 1.03],
  },

  /* ------------------------------------------------------------- impacts -- */

  'impact.kinetic': {
    what: 'Solid shot off armour plate. A ping, high and short.',
    bus: 'world',
    takes: 6,
    seconds: [0.03, 0.15],
    gain: 0.24,
    pitch: [0.92, 1.08],
  },
  'impact.explosive': {
    what: 'A warhead arriving. Thud with body under it.',
    bus: 'world',
    takes: 6,
    seconds: [0.06, 0.25],
    gain: 0.34,
    pitch: [0.93, 1.07],
  },
  'impact.energy': {
    what: 'Beam meeting plate. Sizzle, not thud.',
    bus: 'world',
    takes: 5,
    seconds: [0.06, 0.25],
    gain: 0.26,
    pitch: [0.94, 1.06],
  },
  'impact.emp': {
    what: 'The arrival that does no damage. Crackle, and then a hole where the sound should be.',
    bus: 'world',
    takes: 5,
    seconds: [0.05, 0.2],
    gain: 0.18,
    pitch: [0.94, 1.06],
  },

  /* ----------------------------------------------------------- abilities -- */

  'ability.dash': {
    what: 'Afterburn. A turbine spooling up and staying up.',
    bus: 'world',
    takes: 3,
    seconds: [0.4, 1.2],
    gain: 0.3,
    pitch: [0.97, 1.03],
  },
  'ability.overshield': {
    what: 'Aegis Field. A shield is a chord, not a bang.',
    bus: 'world',
    takes: 3,
    seconds: [0.4, 1.5],
    gain: 0.3,
    pitch: [0.98, 1.02],
  },
  'ability.repairfield': {
    what: 'Field Repair. Welding over a warm pad.',
    bus: 'world',
    takes: 3,
    seconds: [0.4, 1.5],
    gain: 0.28,
    pitch: [0.98, 1.02],
  },
  'ability.empburst': {
    what: 'Everything in four cells goes quiet, and you hear it happen.',
    bus: 'world',
    takes: 3,
    seconds: [0.5, 1.5],
    gain: 0.7,
    pitch: [0.98, 1.02],
  },
  'ability.skyfall': {
    what: 'The crew signature. The loudest thing a friendly unit does — when a pilot crosses half the map, the player should know without looking that it was one of theirs.',
    bus: 'world',
    takes: 3,
    seconds: [0.6, 1.6],
    gain: 0.6,
    pitch: [0.98, 1.02],
  },

  /* --------------------------------------------------------------- world -- */

  'world.explosion': {
    what: 'The ordinary blast. Most common big sound in the game.',
    bus: 'world',
    takes: 6,
    seconds: [0.2, 0.8],
    gain: 0.55,
    pitch: [0.93, 1.07],
  },
  'world.explosionBig': {
    what: 'A fuel depot, an ammo store, a chain reaction. It should make the ordinary blast sound small.',
    bus: 'world',
    takes: 4,
    seconds: [0.5, 2.0],
    gain: 1.0,
    pitch: [0.95, 1.05],
  },
  'world.deathMech': {
    what: 'A machine coming apart — torn metal and a descending groan. Not another explosion: the blast already played this tick, and this is the wreck arriving.',
    bus: 'world',
    takes: 5,
    seconds: [0.3, 1.0],
    gain: 0.45,
    pitch: [0.94, 1.06],
  },
  'world.deathBuilding': {
    what: 'A structure collapsing. Longer than a mech, and it ends with what is left of it hitting the ground.',
    bus: 'world',
    takes: 4,
    seconds: [0.6, 2.0],
    gain: 0.7,
    pitch: [0.96, 1.04],
  },
  'world.deathProp': {
    what: 'Scenery destroyed. Rubble, and more of it the taller the thing was.',
    bus: 'world',
    takes: 5,
    seconds: [0.2, 0.9],
    gain: 0.4,
    pitch: [0.92, 1.08],
  },
  'world.shieldBreak': {
    what: 'Cover gone. The player must hear this over a firefight, because it is the moment their timing changes.',
    bus: 'world',
    takes: 4,
    seconds: [0.1, 0.5],
    gain: 0.4,
    pitch: [0.96, 1.04],
  },
  'world.emp': {
    what: 'Splash EMP landing on something. Fires often in a fight, so it must stay small.',
    bus: 'world',
    takes: 4,
    seconds: [0.2, 0.7],
    gain: 0.5,
    pitch: [0.96, 1.04],
  },
  'world.deployDown': {
    what: 'Siege anchors going into the ground. Two clunks, the second one lower.',
    bus: 'world',
    takes: 3,
    seconds: [0.15, 0.6],
    gain: 0.5,
    pitch: [0.97, 1.03],
  },
  'world.deployUp': {
    what: 'Anchors coming out. The same machine, running backwards and lighter.',
    bus: 'world',
    takes: 3,
    seconds: [0.15, 0.6],
    gain: 0.45,
    pitch: [0.97, 1.03],
  },
  'world.leapStart': {
    what: 'Jump jets lighting. Take-off.',
    bus: 'world',
    takes: 4,
    seconds: [0.15, 0.6],
    gain: 0.3,
    pitch: [0.95, 1.05],
  },
  'world.leapEnd': {
    what: 'The landing. Without it, a jump has a take-off and no arrival and the mech reads as having teleported.',
    bus: 'world',
    takes: 4,
    seconds: [0.1, 0.5],
    gain: 0.5,
    pitch: [0.95, 1.05],
  },
  'world.superweaponFired': {
    what: 'A Lance leaving the rail, heard from anywhere on the map. This is the telegraph doing its job — the player has a few seconds to move, and this is how they learn that.',
    bus: 'world',
    takes: 2,
    seconds: [0.6, 2.0],
    gain: 0.5,
  },
  'world.superweaponImpact': {
    what: 'The Lance arriving. The largest sound in the game, and the only one allowed to be.',
    bus: 'world',
    takes: 2,
    seconds: [0.8, 2.5],
    gain: 1.1,
  },

  /* ------------------------------------------------------------ interface -- */

  'ui.click': {
    what: 'A button, a placement, a hotkey. Flat and instant.',
    bus: 'ui',
    takes: 2,
    seconds: [0.01, 0.1],
    gain: 0.35,
  },
  'ui.deny': {
    what: 'That order was refused. Must be distinguishable from a click at a glance, because the player will otherwise assume the order went through.',
    bus: 'ui',
    takes: 2,
    seconds: [0.05, 0.3],
    gain: 0.4,
  },
  'ui.deposit': {
    what: 'Scrap arriving at the refinery. Repeats all mission long, so it has to survive a thousand plays without irritating.',
    bus: 'ui',
    takes: 4,
    seconds: [0.05, 0.25],
    gain: 0.4,
  },
  'ui.placed': {
    what: 'A foundation going down. The order was accepted; the thing is not built yet.',
    bus: 'ui',
    takes: 2,
    seconds: [0.08, 0.4],
    gain: 0.5,
  },
  'ui.built': {
    what: 'The structure standing up. A different moment from the foundation, and it must sound like a different moment.',
    bus: 'ui',
    takes: 3,
    seconds: [0.15, 0.6],
    gain: 0.45,
  },
  'ui.produced': {
    what: 'A unit rolled out of a factory.',
    bus: 'ui',
    takes: 3,
    seconds: [0.08, 0.4],
    gain: 0.5,
  },
  'ui.sold': {
    what: 'A structure sold back. Scrap returning.',
    bus: 'ui',
    takes: 2,
    seconds: [0.15, 0.6],
    gain: 0.45,
  },
  'ui.promoted': {
    what: 'A pilot ranked up. Good news, and the player should look.',
    bus: 'ui',
    takes: 3,
    seconds: [0.3, 1.2],
    gain: 0.5,
  },
  'ui.repairStalled': {
    what: 'Out of scrap mid-repair. A warning, and it should sound like one rather than like a notification.',
    bus: 'ui',
    takes: 2,
    seconds: [0.2, 0.8],
    gain: 0.35,
  },
  'ui.reinforcement': {
    what: 'A pilot the crew had written off walks out of the fog. The biggest thing that happens inside a mission — it gets a fanfare.',
    bus: 'ui',
    takes: 2,
    seconds: [0.5, 2.0],
    gain: 0.5,
  },
  'ui.objectiveComplete': {
    what: 'A required objective done.',
    bus: 'ui',
    takes: 2,
    seconds: [0.3, 1.2],
    gain: 0.5,
  },
  'ui.objectiveBonus': {
    what: 'An optional objective done. Smaller than the required one, and clearly the same family.',
    bus: 'ui',
    takes: 2,
    seconds: [0.2, 1.0],
    gain: 0.45,
  },
  'ui.objectiveFailed': {
    what: 'An objective lost. The mission continues, which is what separates this from defeat.',
    bus: 'ui',
    takes: 2,
    seconds: [0.4, 1.5],
    gain: 0.45,
  },
  'ui.superweaponReady': {
    what: 'The Lance is charged and yours to fire.',
    bus: 'ui',
    takes: 2,
    seconds: [0.4, 1.5],
    gain: 0.5,
  },
  'ui.victory': {
    what: 'The mission is won. Played once, remembered for the whole campaign.',
    bus: 'ui',
    takes: 1,
    seconds: [1.0, 4.0],
    gain: 0.55,
  },
  'ui.defeat': {
    what: 'The mission is lost. It should land without punishing — the player is going to press retry.',
    bus: 'ui',
    takes: 1,
    seconds: [1.0, 4.0],
    gain: 0.55,
  },

  /* ---------------------------------------------------- acknowledgements -- */

  'ack.select': {
    what: 'Selection. An ident, not an answer — the shortest thing a pilot says.',
    bus: 'ui',
    takes: 6,
    seconds: [0.15, 0.8],
    gain: 0.5,
  },
  'ack.move': {
    what: '"Moving out." Rising, unbothered.',
    bus: 'ui',
    takes: 6,
    seconds: [0.3, 1.4],
    gain: 0.7,
  },
  'ack.attack': {
    what: '"Engaging." Lower and harder than a move order.',
    bus: 'ui',
    takes: 6,
    seconds: [0.3, 1.4],
    gain: 0.7,
  },
  'ack.attackmove': {
    what: 'Attack-move. The same answer held longer — you are walking them into it, and they know.',
    bus: 'ui',
    takes: 5,
    seconds: [0.3, 1.6],
    gain: 0.7,
  },
  'ack.harvest': {
    what: 'Harvesting is work, and it answers like work.',
    bus: 'ui',
    takes: 4,
    seconds: [0.3, 1.4],
    gain: 0.7,
  },
  'ack.stop': {
    what: '"Holding." One flat syllable.',
    bus: 'ui',
    takes: 4,
    seconds: [0.2, 1.0],
    gain: 0.56,
  },
  'ack.ability': {
    what: 'An ability going off. Keyed up.',
    bus: 'ui',
    takes: 5,
    seconds: [0.3, 1.4],
    gain: 0.7,
  },
  'ack.deny': {
    what: 'Refusal. Not a sound any pilot enjoys making.',
    bus: 'ui',
    takes: 4,
    seconds: [0.2, 1.0],
    gain: 0.63,
  },
};

/* ================================================================== music */

/**
 * The music states, and what each one is for.
 *
 * A state is not a track. Each of these can hold any number of tracks and the
 * player picks between them, because the fastest way to make a score wear out
 * is to attach exactly one piece of music to the screen it plays on.
 *
 * `intensity` orders them. Music only ever moves up a step at a time on the
 * way in, so a single unlucky skirmish cannot slam the score from `calm` to
 * `desperate`; it comes back down freely, because relief should be immediate.
 *
 * @type {Record<string, {what: string, intensity: number, loop: boolean}>}
 */
export const MUSIC_STATES = {
  menu: {
    what: 'Front end, mission select, the pause screen. Heard before anything has happened and after everything has.',
    intensity: 0,
    loop: true,
  },
  calm: {
    what: 'Building, scouting, harvesting. Nothing is shooting. This is the bed that plays longest, so it has to be the one that hides best.',
    intensity: 1,
    loop: true,
  },
  battle: {
    what: 'Contact. Something of yours is trading fire with something of theirs.',
    intensity: 2,
    loop: true,
  },
  desperate: {
    what: 'Losing. Structures burning, or the Lance charged and pointed at you.',
    intensity: 3,
    loop: true,
  },
  victory: {
    what: 'The mission is won. Plays once over the end screen and stops.',
    intensity: 0,
    loop: false,
  },
  defeat: {
    what: 'The mission is lost. Plays once, and does not gloat.',
    intensity: 0,
    loop: false,
  },
};

/**
 * How long the score takes to move between states, in seconds.
 *
 * Asymmetric on purpose. Into a fight is fast, because music that arrives
 * after the shooting started is scoring the wrong scene; out of one is slow,
 * because a lull of four seconds is not the end of a battle and treating it as
 * one makes the score flap.
 */
export const MUSIC_FADE = { up: 1.2, down: 6.0 };

/** Seconds of quiet before the score is allowed to step back down. */
export const MUSIC_COOLDOWN = 8;

/**
 * How far the music ducks under a big event, and for how long.
 *
 * A Lance impact under a full battle bed is two loud things at once, which is
 * one loud thing. Pulling the music down for a second and a half is what makes
 * the blast read as large rather than as busy.
 */
export const MUSIC_DUCK = { amount: 0.45, seconds: 1.6 };

/* =============================================================== accessors */

/** Every cue name, sorted, for the tools and the tests. */
export const CUE_NAMES = Object.keys(CUES).sort();

/** The cue names on one bus. */
export function cuesOnBus(bus) {
  return CUE_NAMES.filter((name) => CUES[name].bus === bus);
}

/**
 * The cue a weapon fires, whether or not anyone has recorded it yet.
 *
 * Mirrors `WEAPON_VOICES` in `sound.js`: the same weapon id, so a weapon added
 * to `content.js` gets a predictable cue name before it gets a recording, and
 * the coverage report can list it as outstanding rather than silently omitting
 * it.
 */
export function weaponCue(weaponId) {
  return `weapon.${weaponId}`;
}

/** The cue a warhead makes on arrival. `damageType` is lower case here. */
export function impactCue(damageType) {
  return `impact.${damageType}`;
}

/** The cue an ability makes, or null for the two that announce themselves. */
export function abilityCue(abilityId) {
  const name = `ability.${abilityId}`;
  return CUES[name] ? name : null;
}

/**
 * Group a cue name belongs to — the text before the first dot.
 *
 * Used by the cue sheet to section the document and by the pack tool to
 * report coverage per family, which is how you find out that the weapons are
 * done and the acknowledgements are not.
 */
export function groupOf(cueName) {
  return cueName.slice(0, cueName.indexOf('.'));
}

/** The groups, in the order the catalogue declares them. */
export const GROUPS = [...new Set(Object.keys(CUES).map(groupOf))];
