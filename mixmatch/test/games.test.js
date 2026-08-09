// Guards for the arcade registry.
//
// The registry's only job is to be the one true list, so the failures worth
// catching are all failures of that claim:
//
//   1. A game pointing at a meter that does not exist, or at a file that does
//      not — either way, a launcher that opens nothing.
//   2. A game becoming chargeable before its meter is.
//   3. Two games occupying the same slot in the arcade, which is how you end
//      up paying to build the same round twice.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { GAMES, GAME_IDS, game, liveGames, playableGames, localGames } from '../config/games.js';
import { METERS } from '../config/tokens.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

describe('the registry is coherent', () => {
  test('every game names a meter that exists', () => {
    for (const id of GAME_IDS) {
      assert.ok(METERS[GAMES[id].meter], `${id} draws against '${GAMES[id].meter}', which is not a meter`);
    }
  });

  test('every id matches its key', () => {
    for (const id of GAME_IDS) {
      assert.equal(GAMES[id].id, id, `${id} disagrees with its own id field`);
    }
  });

  test('a local entry points at a file that is actually there', () => {
    // The registry is only worth having if a launcher can trust it. A path
    // that 404s is worse than no registry, because it looks authoritative.
    for (const g of localGames()) {
      assert.ok(existsSync(join(repoRoot, g.entry)), `${g.id} points at ${g.entry}, which does not exist`);
    }
  });

  test('an external game declares where it lives instead of a path', () => {
    for (const id of GAME_IDS) {
      const g = GAMES[id];
      if (g.entry) continue;
      assert.ok(g.external, `${id} has no entry path and does not say which repository holds it`);
    }
  });

  test('game() throws on an id nobody has heard of', () => {
    assert.throws(() => game('asteroids'), /Unknown game/);
    assert.equal(game('tank-shooter').title, 'NOD Tank Shooter');
  });
});

describe('the arcade has a shape', () => {
  test('no two games are for the same thing', () => {
    // The same rule the tank shooter applies to its own hostiles: two entries
    // that answer "why would I pick this one" identically are one entry.
    const owned = new Map();
    for (const id of GAME_IDS) {
      const owns = GAMES[id].owns;
      assert.ok(owns && owns.length > 10, `${id} does not say what it is for`);
      assert.equal(owned.get(owns), undefined, `${id} and ${owned.get(owns)} are for the same thing`);
      owned.set(owns, id);
    }
  });

  test('round lengths differ enough to be a real choice', () => {
    // Three games all lasting five minutes is one game with three skins as far
    // as a player deciding how to spend the next ten minutes is concerned.
    const minutes = GAME_IDS.map((id) => GAMES[id].minutes).sort((a, b) => a - b);
    for (let i = 1; i < minutes.length; i++) {
      assert.ok(minutes[i] >= minutes[i - 1] * 2, `round lengths ${minutes.join(', ')} are too close together`);
    }
  });

  test('every game has a blurb worth reading', () => {
    for (const id of GAME_IDS) {
      assert.ok(GAMES[id].blurb.length > 20, `${id} has no useful blurb`);
      assert.ok(GAMES[id].title.length > 3, `${id} has no title`);
    }
  });
});

describe('nothing charges before it can', () => {
  test('no game is live while its meter is not', () => {
    // arcade_play is 'planned' today, so this currently asserts that nothing
    // is chargeable at all — which is the honest state and the point.
    for (const g of liveGames()) {
      assert.equal(
        METERS[g.meter].status,
        'live',
        `${g.id} is live but its meter ${g.meter} is ${METERS[g.meter].status}`
      );
    }
  });

  test('the games that exist are playable and free', () => {
    const playable = playableGames().map((g) => g.id);
    assert.ok(playable.includes('rocketman'));
    assert.ok(playable.includes('tank-shooter'));
    assert.deepEqual(liveGames(), [], 'a game is chargeable before the arcade meter is live');
  });

  test('every status is one the registry defines', () => {
    for (const id of GAME_IDS) {
      assert.ok(
        ['live', 'planned', 'unwired'].includes(GAMES[id].status),
        `${id} has status '${GAMES[id].status}'`
      );
    }
  });
});
