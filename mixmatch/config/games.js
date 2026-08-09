// Mix & Match — the arcade registry. One entry per game, and nowhere else.
//
// WHY THIS EXISTS
//
// `tokens.js` prices `arcade_play` as one token for "a game". That was fine
// while there was one game. With more than one, every surface that needs to
// know what the arcade contains — a menu, a launcher, a receipt line, a
// "what do I get for $5" page — would otherwise grow its own list, and those
// lists drift the moment a game is renamed or pulled.
//
// So the arcade is data, exactly as the meter table is data. Adding a game is
// an entry here; it is not a new pricing scheme, a new route convention, or a
// new place where a title string lives.
//
// The README's own words for this discipline: "It exists so that when each one
// *is* built, it is a config entry rather than a new pricing scheme."
//
// Plain ESM, no dependencies: imported by Deno edge functions, Node tests, and
// the browser.

/**
 * Every game the arcade knows about.
 *
 * `meter` names the entry in `tokens.js` that a play draws against. All three
 * point at `arcade_play` today, and that is the intended state: a round is a
 * round. A game that ever needs its own price gets its own meter *there*, and
 * this field is how it would say so.
 *
 * `status` mirrors the meter vocabulary deliberately:
 *   'live'      — playable and chargeable
 *   'planned'   — designed, not built
 *   'unwired'   — the game is finished and playable, but nothing connects it
 *                 to a balance yet. This is the honest state of everything
 *                 here: the games exist and take no tokens.
 *
 * `entry` is relative to the repository root, because that is the only path
 * that means the same thing to a static server, a test, and a person reading
 * it. Whatever eventually hosts these will rewrite it; nothing here should
 * guess at a production URL it cannot verify.
 *
 * `owns` is what the game is *for* in an arcade sense — the reason a player
 * would pick this one over the others. Two games with the same answer are one
 * game, the same rule the tank shooter applies to its own hostiles.
 */
export const GAMES = {
  /**
   * The one that was already here. Not a shooter despite the shorthand
   * everyone uses for it — a real-time strategy game with base building and
   * piloted mechs, which is why it is the long-session entry in the arcade.
   */
  rocketman: {
    id: 'rocketman',
    title: 'Rocketman',
    blurb: 'Real-time strategy. Build a base, pilot a mech, hold the yard.',
    owns: 'the long session — twenty minutes, and a campaign behind it',
    entry: 'rocketman/web/rocketman.html',
    meter: 'arcade_play',
    status: 'unwired',
    /** Roughly how long one play takes, in minutes. Drives ordering in a menu. */
    minutes: 20,
  },

  /**
   * The space shooter. Lives in the NOD-ify repository rather than here, so
   * this entry is a reference and not a path that resolves in this checkout —
   * `entry` is null and the test suite knows that is allowed for an external
   * game. Recorded anyway, because the registry's job is to be the complete
   * list; a registry that omits what it cannot see is a registry nobody can
   * trust to be complete.
   */
  'space-shooter': {
    id: 'space-shooter',
    title: 'NOD Space Shooter',
    blurb: 'Arcade space shooting. Score attack, one sitting.',
    owns: 'the two-minute round — pick up, play, put down',
    entry: null,
    external: 'NOD-ify',
    meter: 'arcade_play',
    status: 'unwired',
    minutes: 2,
  },

  /**
   * The robot arena shooter. Sits alongside the space shooter deliberately:
   * same short round, different plane and different pressure — that one is
   * about reading a bullet pattern, this one is about position and priority.
   */
  'tank-shooter': {
    id: 'tank-shooter',
    title: 'NOD Tank Shooter',
    blurb: 'Twin-stick robot arena. Five machines, five questions, escalating waves.',
    owns: 'the five-minute round — ground combat, cover, and target priority',
    entry: 'mixmatch/games/tank-shooter/web/tank-shooter.html',
    meter: 'arcade_play',
    status: 'unwired',
    minutes: 5,
  },
};

/** Every game id, in registry order. */
export const GAME_IDS = Object.keys(GAMES);

/** Games a player could actually be charged to start right now. */
export function liveGames() {
  return Object.values(GAMES).filter((g) => g.status === 'live');
}

/** Games that exist and can be played, whether or not they cost anything. */
export function playableGames() {
  return Object.values(GAMES).filter((g) => g.status === 'live' || g.status === 'unwired');
}

/**
 * A game by id, or a thrown error.
 *
 * Throws rather than returning undefined for the same reason `meterCostMicros`
 * does: a launcher that silently opens nothing is harder to diagnose than one
 * that says which id it did not recognise.
 */
export function game(id) {
  const found = GAMES[id];
  if (!found) throw new TypeError(`Unknown game: ${id}`);
  return found;
}

/** Games this repository can actually serve, shortest round first. */
export function localGames() {
  return Object.values(GAMES)
    .filter((g) => g.entry)
    .sort((a, b) => a.minutes - b.minutes);
}
