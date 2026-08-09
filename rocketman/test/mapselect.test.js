/**
 * Choosing the battlefield.
 *
 * The map character was rolled from the seed and never offered. This suite
 * covers offering it, and the whole reason it is a suite rather than one
 * assertion is the second describe: the choice has to arrive *without*
 * changing what an unchosen map builds. Every seed anyone has written down,
 * every recorded replay, and the Swift conformance fixtures all depend on the
 * generator producing exactly what it produced yesterday when nobody chooses.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { createMap, MAP_CHARACTER_IDS, MAP_CHARACTER_MENU } from '../engine/grid.js';
import { createWorld } from '../engine/sim.js';
import { createRecorder, rebuildWorld } from '../engine/replay.js';
import { MISSIONS } from '../engine/campaign.js';

const SWEEP = Array.from({ length: 40 }, (_, i) => i + 1);

/**
 * Everything the generator writes, as one comparable value.
 *
 * Terrain alone would miss a shifted rng stream that happened to carve the
 * same ground and then place different scenery, which is precisely the shape
 * of the bug this file guards against.
 */
function fingerprint(map) {
  return JSON.stringify({
    character: map.character,
    terrain: [...map.terrain],
    resource: [...map.resource],
    starts: map.starts,
    props: map.props,
    fields: map.fields,
  });
}

/* ============================================================== the choice */

describe('picking a battlefield', () => {
  test('every character in the menu can be asked for by name', () => {
    for (const { id } of MAP_CHARACTER_MENU) {
      assert.equal(createMap(7, { character: id }).character, id);
    }
  });

  test('the menu offers exactly the characters the generator has', () => {
    assert.deepEqual(
      MAP_CHARACTER_MENU.map((c) => c.id),
      MAP_CHARACTER_IDS
    );
    for (const entry of MAP_CHARACTER_MENU) {
      assert.ok(entry.name && entry.name !== entry.id, `${entry.id} has no display name`);
    }
  });

  test('the choice holds whatever the seed would have rolled', () => {
    // The point of the feature: one battlefield across many seeds. Without
    // this, "I want a floodplain" means "reroll until you get one".
    for (const seed of SWEEP) {
      assert.equal(createMap(seed, { character: 'delta' }).character, 'delta');
    }
  });

  test('a chosen character actually biases the ground it builds', () => {
    // Same seed, two choices. If the character were recorded but not read,
    // both would build the same map and the menu would be a label.
    const farm = createMap(99, { character: 'pastoral' });
    const city = createMap(99, { character: 'sprawl' });
    const hedges = (m) => m.props.filter((p) => p.defId === 'hedge').length;
    assert.ok(
      hedges(farm) > hedges(city),
      `farmland grew ${hedges(farm)} hedgerows against the city's ${hedges(city)}`
    );
  });

  test('an unknown character falls back to the roll rather than throwing', () => {
    // A saved config from a newer build naming a character this one has never
    // heard of should still open the map, the tolerance `characterOf` and
    // `biome` already show.
    const rolled = createMap(21).character;
    assert.equal(createMap(21, { character: 'atlantis' }).character, rolled);
  });
});

/* ====================================================== nothing else moved */

describe('an unchosen map is the map that was always there', () => {
  test('asking for nothing is identical to not asking', () => {
    for (const seed of SWEEP) {
      assert.equal(fingerprint(createMap(seed, { character: null })), fingerprint(createMap(seed)));
    }
  });

  /**
   * The guard with teeth.
   *
   * The character is picked with a single `rng.int`, and Grid.swift's own
   * comment calls that draw load-bearing. The obvious implementation — skip
   * the roll when the player has chosen — shifts every draw after it, so
   * choosing the character a seed was going to roll anyway would build a
   * *different* map. This asserts the two are the same map, which they can
   * only be if the draw is spent either way.
   */
  test('choosing what the seed would have rolled changes nothing at all', () => {
    for (const seed of SWEEP) {
      const rolled = createMap(seed).character;
      assert.equal(
        fingerprint(createMap(seed, { character: rolled })),
        fingerprint(createMap(seed)),
        `seed ${seed} built a different map when asked for its own character (${rolled})`
      );
    }
  });
});

/* ============================================================ world + replay */

describe('the choice travels with the match', () => {
  const players = [{ faction: 'ascendancy' }, { faction: 'bulwark' }];

  test('createWorld hands the character down to the map', () => {
    assert.equal(createWorld({ seed: 5, players, character: 'works' }).map.character, 'works');
  });

  test('a replay rebuilds the battlefield that was played', () => {
    // The config is what a recording carries, so if the character did not
    // live there the replay would rebuild a different map and desync on the
    // first order given to a unit.
    const config = { seed: 12, players, character: 'broken' };
    const recorder = createRecorder(config);
    const rebuilt = rebuildWorld({ ...recorder, ticks: 0 });
    assert.equal(rebuilt.map.character, 'broken');
    assert.equal(
      fingerprint(rebuilt.map),
      fingerprint(createWorld(config).map),
      'the replayed battlefield is not the one the match was played on'
    );
  });

  test('missions author their own ground and ignore the picker', () => {
    // Skirmish offers the choice; a mission is a designed fight on designed
    // terrain, and its par times and scripted bases are tuned against it.
    const mission = MISSIONS[0];
    const asked = createWorld({ seed: 3, players, mission, character: 'delta' });
    const plain = createWorld({ seed: 3, players, mission });
    assert.equal(fingerprint(asked.map), fingerprint(plain.map));
  });
});
