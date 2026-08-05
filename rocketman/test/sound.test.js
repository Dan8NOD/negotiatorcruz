/**
 * The sound palette, checked the way the content tables are checked.
 *
 * `sound.js` is presentation and cannot be run headless — there is no
 * AudioContext in `node --test` and there is not going to be one. What *can*
 * be checked, and is the part that actually rots, is the mapping: every weapon
 * has a voice, no two weapons share one, every warhead sounds different on
 * arrival, and every recipe honours the distance falloff it is handed.
 *
 * That last one matters more than it looks. A recipe that forgets `at.vol` is
 * not a broken sound — it is a sound that plays at full volume from the other
 * side of the map, which reads as a bug in the fog of war rather than a bug in
 * the mixer, and is correspondingly horrible to track down.
 *
 * The recipes take the synth as an argument precisely so this file can hand
 * them a fake one and watch what they ask for.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { WEAPONS, ABILITIES, DAMAGE } from '../engine/content.js';
import {
  WEAPON_VOICES,
  PROJECTILE_VOICES,
  IMPACT_VOICES,
  ABILITY_VOICES,
  ACK_VOICES,
  ORDER_ACKS,
} from '../web/sound.js';

/**
 * Abilities that are deliberately silent in `ABILITY_VOICES` because a second
 * event already announces them. Listed here rather than skipped so that
 * deleting one of those events shows up as a failing test.
 */
const VOICED_ELSEWHERE = {
  jumpjet: 'leapStart',
  siege: 'deploy',
};

/** Record what a recipe asks the synth for, without an AudioContext. */
function record(voice, at = { pan: 0.4, vol: 1 }) {
  const calls = [];
  const stub = {
    tone: (o) => calls.push({ kind: 'tone', ...o }),
    noise: (o) => calls.push({ kind: 'noise', ...o }),
    vox: (o) => calls.push({ kind: 'vox', ...o }),
    chime: (base, steps, pan) => calls.push({ kind: 'chime', base, steps, pan }),
  };
  voice(stub, at);
  return calls;
}

describe('weapon voices', () => {
  for (const id of Object.keys(WEAPONS)) {
    test(`${id} has a voice of its own`, () => {
      assert.ok(WEAPON_VOICES[id], `${id} would fall back to the generic tracer sound`);
    });
  }

  test('no weapon has a voice that belongs to another weapon', () => {
    // The same rule the damage table lives under: content that is a copy of
    // other content is dead content. Two weapons sharing a recipe means one
    // of them cannot be identified by ear, which is the whole point.
    const seen = new Map();
    for (const [id, voice] of Object.entries(WEAPON_VOICES)) {
      const owner = seen.get(voice);
      assert.equal(owner, undefined, `${id} and ${owner} are the same sound`);
      seen.set(voice, id);
    }
  });

  test('every voice in the table belongs to a weapon that exists', () => {
    for (const id of Object.keys(WEAPON_VOICES)) {
      assert.ok(WEAPONS[id], `${id} has a voice but is not in WEAPONS`);
    }
  });

  test('every projectile kind has a fallback', () => {
    for (const [id, def] of Object.entries(WEAPONS)) {
      assert.ok(PROJECTILE_VOICES[def.projectile], `${id} fires an unvoiced ${def.projectile}`);
    }
  });
});

describe('impact voices', () => {
  for (const type of Object.values(DAMAGE)) {
    test(`${type} sounds like itself on arrival`, () => {
      assert.ok(IMPACT_VOICES[type], `${type} impacts would sound kinetic`);
    });
  }

  test('the four warheads are four different sounds', () => {
    const unique = new Set(Object.values(IMPACT_VOICES));
    assert.equal(unique.size, Object.keys(IMPACT_VOICES).length);
  });
});

describe('ability voices', () => {
  for (const id of Object.keys(ABILITIES)) {
    test(`${id} is either voiced or knowingly silent`, () => {
      if (ABILITY_VOICES[id]) return;
      assert.ok(
        VOICED_ELSEWHERE[id],
        `${id} makes no sound at all — add a voice or document why it does not need one`
      );
    });
  }

  test('the silent abilities are still abilities', () => {
    // Stops the exemption list outliving the abilities it exempts.
    for (const id of Object.keys(VOICED_ELSEWHERE)) {
      assert.ok(ABILITIES[id], `${id} is exempted from having a voice but no longer exists`);
    }
  });

  test('no ability is exempted and voiced at the same time', () => {
    for (const id of Object.keys(VOICED_ELSEWHERE)) {
      assert.equal(ABILITY_VOICES[id], undefined, `${id} would play twice`);
    }
  });
});

describe('every recipe', () => {
  const everything = [
    ...Object.entries(WEAPON_VOICES).map(([id, v]) => [`weapon ${id}`, v]),
    ...Object.entries(IMPACT_VOICES).map(([id, v]) => [`impact ${id}`, v]),
    ...Object.entries(ABILITY_VOICES).map(([id, v]) => [`ability ${id}`, v]),
  ];

  for (const [label, voice] of everything) {
    test(`${label} actually schedules something`, () => {
      const calls = record(voice);
      assert.ok(calls.length > 0, 'a recipe that schedules nothing is a silent weapon');
      for (const call of calls) {
        assert.ok(Number.isFinite(call.gain) && call.gain > 0, `${label} scheduled a silent layer`);
        assert.ok(Number.isFinite(call.dur) && call.dur > 0, `${label} scheduled a zero-length layer`);
      }
    });

    test(`${label} fades to nothing out of earshot`, () => {
      // `locate` hands recipes a volume that falls off past the viewport. A
      // layer that ignores it plays at full blast from across the map.
      for (const call of record(voice, { pan: 0, vol: 0 })) {
        assert.equal(call.gain, 0, `${label} has a layer that ignores distance`);
      }
    });

    test(`${label} pans where it happened`, () => {
      for (const call of record(voice, { pan: -0.6, vol: 1 })) {
        assert.equal(call.pan, -0.6, `${label} has a layer stuck in the centre`);
      }
    });

    test(`${label} stays inside the mix`, () => {
      // Not a hard physical limit — the compressor would catch it — but a
      // recipe summing to far more than its neighbours is one that will be
      // the only thing anyone can hear in a busy fight.
      const total = record(voice).reduce((sum, c) => sum + c.gain, 0);
      assert.ok(total <= 3, `${label} sums to ${total.toFixed(2)}, which will bury everything else`);
    });
  }
});

describe('acknowledgements', () => {
  const VOWELS = ['ah', 'eh', 'ee', 'oh', 'oo'];

  for (const [id, spec] of Object.entries(ACK_VOICES)) {
    test(`${id} is a pronounceable answer`, () => {
      assert.ok(spec.syllables.length > 0, 'an acknowledgement with no syllables is silence');
      assert.ok(spec.syllables.length <= 3, 'more than three syllables stops sounding like a radio call');
      for (const [vowel, pitch] of spec.syllables) {
        assert.ok(VOWELS.includes(vowel), `${id} uses unknown vowel ${vowel}`);
        assert.ok(pitch > 0.3 && pitch < 2, `${id} has a syllable at an inhuman pitch`);
      }
    });
  }

  test('every order resolves to an answer, a click, or documented silence', () => {
    for (const [type, kind] of Object.entries(ORDER_ACKS)) {
      if (kind === null || kind === 'click') continue;
      assert.ok(ACK_VOICES[kind], `${type} maps to unknown acknowledgement ${kind}`);
    }
  });

  test('the orders a pilot carries out are answered by a voice', () => {
    // The split that makes the interface legible: machines answer, the base
    // clicks. If one of these ever becomes a click, orders stop feeling like
    // orders.
    for (const type of ['move', 'attack', 'attackMove', 'harvest', 'stop', 'ability']) {
      const kind = ORDER_ACKS[type];
      assert.ok(kind && kind !== 'click', `${type} should be answered by a pilot, not a click`);
    }
  });
});
