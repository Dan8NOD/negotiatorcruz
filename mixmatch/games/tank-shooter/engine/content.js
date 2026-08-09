/**
 * NOD Tank Shooter — the content tables.
 *
 * Everything the game is *made of* lives here as data: the player's tank, the
 * five hostiles, the guns, and the wave schedule. The simulation in `sim.js`
 * reads these and contains no numbers of its own, which is what lets the suite
 * check balance as a property of the game rather than by playing it.
 *
 * ## The rule every enemy is designed against
 *
 * An arena shooter is only interesting while the player is being asked a
 * question. One enemy asks one question, and two enemies that ask the *same*
 * question are one enemy with two sprites — the player learns a single answer
 * and both stop mattering.
 *
 * So each hostile below is built around a distinct pressure, named in its
 * `asks` field:
 *
 *   - scuttler  — "are you still moving?"
 *   - gunhead   — "are you behind something?"
 *   - lobber    — "are you moving *predictably*?"
 *   - warden    — "are you willing to give up ground to get behind it?"
 *   - hive      — "are you shooting the right thing?"
 *
 * `asks` is not decoration. `content.test.js` asserts every hostile has one and
 * that no two share it, which is the same discipline `rocketman/engine` uses to
 * stop a fourteenth weapon from being a copy of the third.
 *
 * The counter-play is deliberately mechanical rather than statistical: a warden
 * cannot be out-damaged from the front at any fire rate, so the answer is to
 * flank rather than to hold the trigger longer. That distinction is the whole
 * difference between a game and a damage race.
 */

/* ================================================================== the arena */

/**
 * The floor, in world units. One unit is one pixel at zoom 1.
 *
 * Square, and small enough that no corner is ever truly safe: a shooter whose
 * arena has a hiding place is a shooter where the correct play is to stand in
 * it. 1400 is about four seconds of driving corner to corner, which is long
 * enough for repositioning to be a decision and short enough that a fight
 * cannot be run away from indefinitely.
 */
export const ARENA = { width: 1400, height: 1400 };

/** Fixed simulation rate. Everything below is expressed per second. */
export const TICKS_PER_SECOND = 60;

/**
 * Cover blocks, placed by the map generator inside this footprint.
 *
 * Cover is what makes `gunhead` a question rather than a chore, so the arena
 * needs enough of it to break every long sightline and not so much that a
 * player can circle one block forever. Six to nine blocks is the band where
 * both are true.
 */
export const COVER = { min: 6, max: 9, size: [90, 190], edgeMargin: 150 };

/* ================================================================== the tank */

/**
 * The player's machine.
 *
 * Drives like something with mass. `accel` and `friction` rather than a
 * velocity you set directly, because the moment-to-moment skill in a twin-stick
 * game is managing momentum you already have — a tank that stops dead when you
 * release the stick has no positioning game, only an aiming one.
 *
 * The turret turns independently of the hull and faster than it, which is what
 * makes reversing while firing a real option and therefore makes retreating a
 * tactic rather than a surrender.
 */
export const TANK = {
  radius: 22,
  maxSpeed: 260,
  accel: 1500,
  /** Per second, as a fraction of speed retained. Below 1 the tank coasts. */
  friction: 6.5,
  /** Radians per second the hull swings toward its heading. */
  hullTurn: 7.0,
  /** The turret is faster than the hull on purpose. See above. */
  turretTurn: 12.0,
  maxHealth: 100,
  /** Seconds of immunity after being hit, so a crowd cannot chain-stun. */
  invulnerable: 0.55,

  /**
   * The boost. Short, cheap, and on a cooldown you feel.
   *
   * It exists because every hostile below is dodgeable in principle, and
   * without a burst of speed "dodgeable in principle" means "dodgeable only if
   * you were already moving the right way". The boost is the answer to a
   * mistake, which is what keeps a death feeling like the player's fault.
   */
  boost: { speed: 620, seconds: 0.18, cooldown: 1.4, invulnerable: 0.18 },
};

/* ================================================================== the guns */

/**
 * What the tank can be holding.
 *
 * Three, and they differ in *shape of engagement* rather than in damage per
 * second — which is deliberately close between them. A gun that is simply
 * better makes the pickups a lottery for whether you got the good one.
 *
 * @type {Record<string, {
 *   label: string, damage: number, cooldown: number, speed: number,
 *   life: number, radius: number, pierce: number, spread: number,
 *   pellets: number, knockback: number, holds: string,
 * }>}
 */
export const GUNS = {
  /**
   * The starting gun and the one every other is read against. No downside,
   * no speciality — if you are unsure what to pick up, this was fine.
   */
  cannon: {
    label: 'Cannon',
    damage: 24,
    cooldown: 0.28,
    speed: 720,
    life: 1.4,
    radius: 5,
    pierce: 0,
    spread: 0,
    pellets: 1,
    knockback: 90,
    holds: 'The default. Good at range, good up close, best at neither.',
  },

  /**
   * Close range, enormous per-shot, and it pushes things off you.
   *
   * The knockback is the point rather than the damage: this is the gun that
   * answers a scuttler swarm that has already reached you, which is the
   * situation the cannon handles worst.
   */
  scattergun: {
    label: 'Scattergun',
    damage: 9,
    cooldown: 0.52,
    speed: 620,
    life: 0.42,
    radius: 4,
    pierce: 0,
    spread: 0.44,
    pellets: 6,
    knockback: 340,
    holds: 'Six pellets and a shove. Everything it is good at is within two tank lengths.',
  },

  /**
   * Punches through a line and ignores the warden's shield entirely.
   *
   * `pierce` is what makes it the hive answer — a hive behind three scuttlers
   * is otherwise a wall you have to chew through in the order they arrive.
   * Slow enough that missing costs you real time.
   */
  lance: {
    label: 'Lance',
    damage: 44,
    cooldown: 0.6,
    speed: 1150,
    life: 1.1,
    radius: 3,
    pierce: 3,
    spread: 0,
    pellets: 1,
    knockback: 40,
    holds: 'Goes through what it hits, and through a warden shield. Slow to recover.',
  },
};

/** The gun the run starts with. */
export const STARTING_GUN = 'cannon';

/* =============================================================== the hostiles */

/**
 * Five machines, five questions.
 *
 * `score` is roughly how hard the thing is to kill *given the right answer*,
 * not how much health it has — the warden is worth more than the gunhead
 * because getting behind it costs position, not because it takes more shots.
 *
 * `weight` is spawn likelihood within a wave, and `minWave` gates introduction.
 * Nothing new appears in the same wave as something else new: a player learning
 * two answers at once learns neither, and the test suite enforces the spacing.
 *
 * @type {Record<string, object>}
 */
export const HOSTILES = {
  /**
   * Rushes in a straight line and detonates on contact. Individually trivial;
   * the threat is arithmetic, because they arrive in numbers.
   */
  scuttler: {
    label: 'Scuttler',
    asks: 'are you still moving?',
    radius: 13,
    health: 18,
    speed: 205,
    accel: 900,
    damage: 12,
    score: 10,
    weight: 1.0,
    minWave: 1,
    behaviour: 'charge',
    /** Contact damage only — it has no gun and never gets one. */
    contact: true,
  },

  /**
   * Stationary. Fires a slow aimed shot on a long telegraph.
   *
   * Everything about it says "break the sightline": it cannot chase, it cannot
   * miss a stationary target, and the telegraph is longer than the time it
   * takes to get behind cover from anywhere in the arena.
   */
  gunhead: {
    label: 'Gunhead',
    asks: 'are you behind something?',
    radius: 19,
    health: 46,
    speed: 0,
    accel: 0,
    damage: 14,
    score: 25,
    weight: 0.7,
    minWave: 2,
    behaviour: 'turret',
    gun: { cooldown: 1.9, telegraph: 0.62, speed: 430, radius: 6, life: 2.4 },
    range: 620,

    /**
     * What it does when it cannot shoot anything.
     *
     * A genuinely immobile enemy in a 1400-unit arena is a stalemate waiting
     * to happen: hostiles arrive at the edge furthest from the player, which
     * is routinely further than 620 units, and a gunhead that spawns out of
     * its own range can never close, never fire and never die. The wave then
     * never clears and the run never ends — found by the idle-player test,
     * which sat at wave 2 for eighty seconds against a gunhead it could not
     * reach and which could not reach it.
     *
     * So it is stationary *while it has a shot*, and crawls when it does not.
     * Slow enough to still read as an emplacement rather than a chaser, and
     * it also means hiding behind a wall forever is not a winning move.
     */
    redeploy: { speed: 78, accel: 340, after: 1.5 },
  },

  /**
   * Arcs a shell at where the player *will be*, not where they are.
   *
   * The lead is capped below perfect on purpose. A perfect predictor is not
   * hard, it is unfair — the counter would be to stand still, which is the
   * opposite of what this game wants to teach. Capped, the answer is to change
   * direction rather than to move faster.
   */
  lobber: {
    label: 'Lobber',
    asks: 'are you moving predictably?',
    radius: 21,
    health: 58,
    speed: 95,
    accel: 420,
    damage: 18,
    score: 35,
    weight: 0.5,
    minWave: 3,
    behaviour: 'artillery',
    gun: { cooldown: 2.6, telegraph: 0.85, speed: 380, radius: 9, life: 3.0, splash: 78 },
    range: 760,
    /** Fraction of a perfect intercept. Below 1 so a turn always beats it. */
    lead: 0.72,
    /** It backs away if you close, which is what keeps it a ranged problem. */
    standoff: 340,
  },

  /**
   * Armoured across its front arc. Shots inside the arc do a fraction of
   * their damage; the flanks and back are ordinary.
   *
   * This is the one enemy that cannot be answered by shooting harder, and it
   * is here to make position a resource. It advances slowly and never stops,
   * so ignoring it is also not an answer.
   */
  warden: {
    label: 'Warden',
    asks: 'will you give up ground to get behind it?',
    radius: 27,
    health: 120,
    speed: 118,
    accel: 500,
    damage: 22,
    score: 60,
    weight: 0.35,
    minWave: 4,
    behaviour: 'advance',
    contact: true,
    /** Half-width of the shielded arc, in radians. 1.15 ≈ 66° each side. */
    shieldArc: 1.15,
    /** Damage multiplier inside the arc. Not zero — chip damage is honest. */
    shieldMultiplier: 0.15,
  },

  /**
   * Spawns scuttlers until it is dead. Slow, fragile for its wave, and the
   * correct target every single time it is on the field.
   *
   * The question it asks is target priority, so it has to be *reachable* —
   * a hive that hides behind its own spawn is a hive you cannot answer.
   * It drifts toward open ground rather than away from the player.
   */
  hive: {
    label: 'Hive',
    asks: 'are you shooting the right thing?',
    radius: 25,
    health: 90,
    speed: 68,
    accel: 300,
    damage: 10,
    score: 80,
    weight: 0.25,
    minWave: 5,
    behaviour: 'hive',
    contact: true,
    spawn: { of: 'scuttler', every: 3.1, cap: 5 },
  },
};

/* ================================================================== the waves */

/**
 * How a run escalates.
 *
 * Budget-based rather than a hand-written list: each wave has a number of
 * points to spend and buys hostiles with it at random from what is unlocked.
 * That keeps runs different from each other without letting wave 3 roll a
 * warden, and it means adding a hostile is one table entry rather than an edit
 * to every wave after the one it joins.
 *
 * The curve is deliberately gentle for four waves and then steep. An arcade
 * round that charges a token has to let the player *feel competent* before it
 * starts taking the token seriously, or the purchase reads as a con.
 */
export const WAVES = {
  /** Points available in wave n. */
  budget(n) {
    return Math.round(24 + n * 15 + Math.pow(Math.max(0, n - 4), 2.05) * 5.5);
  },
  /** What one of each costs against that budget. */
  cost: { scuttler: 8, gunhead: 20, lobber: 28, warden: 46, hive: 58 },
  /** Seconds of quiet between waves. Long enough to breathe, short enough to hurry. */
  interval: 3.2,
  /** No wave may be more than this fraction of one hostile type. */
  maxShare: 0.7,
  /** Hard ceiling on simultaneous hostiles, whatever the budget says. */
  maxAlive: 34,

  /**
   * When a wave has gone on too long, the survivors stop being patient.
   *
   * A wave only ends when the field is clear, so anything that can indefinitely
   * avoid resolution makes the *run* indefinite — and a run that never ends is
   * a token spent on a screensaver. A 30-seed sweep found three that stalled
   * forever on wave 3: a lobber holding its standoff band behind cover against
   * a player who kept backing away, neither able to reach the other.
   *
   * Obstacle steering fixed most of it. This is the backstop that makes
   * termination a property of the game rather than a thing that happens to be
   * true of the seeds that were tested. After `stallSeconds`, urgency ramps
   * from 0 to 1 over `stallRamp`; at full urgency every hostile abandons its
   * standoff, redeploys immediately, and moves half again as fast.
   *
   * Set well above a normal wave — a clean wave 12 resolves in under twenty
   * seconds — so a player who is winning never sees it happen.
   */
  stallSeconds: 26,
  stallRamp: 14,
  /** Top speed multiplier at full urgency. */
  stallSpeedup: 1.5,
};

/**
 * Gun pickups.
 *
 * Dropped on a schedule rather than randomly, because a run where the
 * scattergun never appears is a run missing a mechanic the player paid for.
 */
export const PICKUPS = {
  /** Wave numbers on which a gun drops, and which gun. */
  schedule: { 2: 'scattergun', 4: 'lance', 7: 'scattergun', 10: 'lance' },
  /** Seconds before an untaken pickup fades. */
  life: 22,
  radius: 16,
  /** A repair drops on these waves instead of a gun. */
  repairWaves: [3, 6, 9, 12],
  repairAmount: 35,
};

/* ============================================================== the accessors */

/** Hostile ids unlocked by wave `n`, in table order. */
export function unlockedAt(n) {
  return Object.keys(HOSTILES).filter((id) => HOSTILES[id].minWave <= n);
}

/** Every hostile id, in table order. */
export const HOSTILE_IDS = Object.keys(HOSTILES);

/** Every gun id, in table order. */
export const GUN_IDS = Object.keys(GUNS);

/**
 * Damage a shot does to a hostile, given where it came from.
 *
 * Lives here rather than in `sim.js` because it is a balance decision — the
 * warden's whole identity is this function — and because a pure function of
 * (hostile, angle, gun) is something the suite can exhaust without a world.
 *
 * @param {object} hostile the hostile definition
 * @param {number} facing the hostile's facing, radians
 * @param {number} fromAngle angle from hostile to the shot's origin, radians
 * @param {object} gun the gun definition
 */
export function damageAgainst(hostile, facing, fromAngle, gun) {
  if (!hostile.shieldArc) return gun.damage;
  // A piercing round defeats the shield outright. That is what makes the lance
  // a genuine alternative answer to the warden rather than a slower one.
  if (gun.pierce > 0) return gun.damage;
  let delta = fromAngle - facing;
  while (delta > Math.PI) delta -= Math.PI * 2;
  while (delta < -Math.PI) delta += Math.PI * 2;
  return Math.abs(delta) <= hostile.shieldArc ? gun.damage * hostile.shieldMultiplier : gun.damage;
}
