/**
 * The recorded layer, checked without a microphone or an AudioContext.
 *
 * `sound.test.js` already pins the synthesised palette — every weapon has a
 * voice, no two weapons share one. This is the same job for the layer in front
 * of it, and it exists because the failure modes here are quiet ones. A cue
 * that no code plays is a folder someone records into for an afternoon and
 * never hears. A weapon with no cue is a gun that stays synthesised forever
 * while everything around it gets recorded, and the only symptom is that it
 * sounds slightly wrong next to its neighbours.
 *
 * Neither of those shows up as a crash, a failed load, or a console line. They
 * show up months later as "something is off about the Talon", which is not a
 * bug report anyone can act on. So they are tests.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { WEAPONS, ABILITIES, DAMAGE } from '../engine/content.js';
import { WEAPON_VOICES, ABILITY_VOICES, ACK_VOICES, DEATH_CUES } from '../web/sound.js';
import {
  CUES,
  CUE_NAMES,
  GROUPS,
  BUSES,
  MUSIC_STATES,
  MUSIC_FADE,
  groupOf,
} from '../web/audio-cues.js';
import { createSampleBank, createShuffleBag, pickFormat } from '../web/samples.js';
import { createMusic, stepState, stateFromEvents } from '../web/music.js';
import { build as buildCueSheet, CUE_SHEET_PATH } from '../tools/audio-cue-sheet.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const soundSource = readFileSync(join(here, '..', 'web', 'sound.js'), 'utf8');

describe('the cue catalogue covers the game', () => {
  test('every weapon has a cue to record into', () => {
    for (const id of Object.keys(WEAPONS)) {
      assert.ok(
        CUES[`weapon.${id}`],
        `${id} is in WEAPONS with no weapon.${id} cue — it will stay synthesised while every other gun gets recorded`
      );
    }
  });

  test('every weapon cue is a weapon that exists', () => {
    for (const cue of CUE_NAMES.filter((c) => groupOf(c) === 'weapon')) {
      const id = cue.slice('weapon.'.length);
      assert.ok(WEAPONS[id], `${cue} names no weapon — a folder nobody should record into`);
    }
  });

  test('every warhead has an arrival', () => {
    for (const type of Object.keys(DAMAGE)) {
      assert.ok(CUES[`impact.${type.toLowerCase()}`], `no impact cue for ${type}`);
    }
  });

  test('every voiced ability has a cue, and the silent two do not', () => {
    for (const id of Object.keys(ABILITY_VOICES)) {
      assert.ok(CUES[`ability.${id}`], `${id} has a synthesised voice but no cue`);
    }
    // jumpjet and siege announce themselves through leapStart and deploy.
    // Recording them as well would double every activation, so the catalogue
    // must not offer somewhere to put that recording.
    for (const id of ['jumpjet', 'siege']) {
      assert.ok(ABILITIES[id], `${id} left content.js — this exemption is now stale`);
      assert.equal(CUES[`ability.${id}`], undefined, `${id} is voiced by another event; it must not have a cue`);
    }
  });

  test('every acknowledgement has a cue', () => {
    for (const kind of Object.keys(ACK_VOICES)) {
      assert.ok(CUES[`ack.${kind}`], `no ack.${kind} cue`);
    }
  });

  test('every kind of death has its own cue', () => {
    for (const [kind, cue] of Object.entries(DEATH_CUES)) {
      assert.ok(CUES[cue], `DEATH_CUES.${kind} points at ${cue}, which is not in the catalogue`);
    }
    const distinct = new Set(Object.values(DEATH_CUES));
    assert.equal(distinct.size, Object.keys(DEATH_CUES).length, 'two kinds of death share a cue');
  });
});

describe('every cue is reachable from the game', () => {
  /**
   * The literal cue names `sound.js` plays.
   *
   * The dynamic ones — `weapon.${id}` and friends — are covered by the tests
   * above, which walk the content tables. This catches the other direction: a
   * cue in the catalogue that no code ever asks for, which is an afternoon of
   * recording that goes straight into a folder nothing reads.
   */
  const literals = new Set([...soundSource.matchAll(/play\(\s*'([a-z]+\.[A-Za-z]+)'/g)].map((m) => m[1]));
  const ternaries = new Set(
    [...soundSource.matchAll(/\?\s*'([a-z]+\.[A-Za-z]+)'\s*:\s*'([a-z]+\.[A-Za-z]+)'/g)].flatMap((m) => [
      m[1],
      m[2],
    ])
  );
  const dynamicGroups = new Set(['weapon', 'impact', 'ability', 'ack']);

  test('sound.js plays no cue the catalogue does not define', () => {
    for (const cue of [...literals, ...ternaries]) {
      assert.ok(CUES[cue], `sound.js plays '${cue}', which is not in audio-cues.js`);
    }
  });

  test('no cue is defined that nothing plays', () => {
    const played = new Set([...literals, ...ternaries, ...Object.values(DEATH_CUES)]);
    for (const cue of CUE_NAMES) {
      if (dynamicGroups.has(groupOf(cue))) continue;
      assert.ok(played.has(cue), `${cue} is in the catalogue but nothing in sound.js ever plays it`);
    }
  });

  test('every play() call hands over a fallback', () => {
    // The whole design rests on this: a recorded cue is an upgrade over a
    // synthesised one, never the only way a sound exists. A `play()` with no
    // second argument would be a sound that is silent until someone records
    // it, which is a content hole wearing an asset pipeline as a disguise.
    const calls = [...soundSource.matchAll(/\bplay\(/g)];
    assert.ok(calls.length > 20, 'the scan found almost no play() calls — the regex has rotted');
    // Neither the declaration of `play` nor the `samples.play` call inside it
    // is a call site — both would otherwise report themselves as fallback-less.
    const bad = [...soundSource.matchAll(/(?<!function )(?<![.\w])play\((.{0,120}?)\)\s*;/gs)].filter(
      (m) => !m[1].includes('=>') && !m[1].includes('function')
    );
    assert.deepEqual(bad.map((m) => m[1].trim()), [], 'play() called without a synthesised fallback');
  });
});

describe('the catalogue is internally sound', () => {
  test('every cue is on a real bus', () => {
    for (const cue of CUE_NAMES) {
      assert.ok(BUSES.includes(CUES[cue].bus), `${cue} is on bus '${CUES[cue].bus}'`);
    }
  });

  test('interface cues are never pitch-jittered', () => {
    // A click that arrives at a different pitch each time reads as a glitch,
    // not as variety — and unlike a gunshot, it is heard in isolation with
    // nothing to mask it.
    for (const cue of CUE_NAMES.filter((c) => CUES[c].bus === 'ui')) {
      assert.equal(CUES[cue].pitch, undefined, `${cue} is an interface sound and must not be pitched`);
    }
  });

  test('take counts and lengths are sane', () => {
    for (const cue of CUE_NAMES) {
      const spec = CUES[cue];
      assert.ok(spec.takes >= 1, `${cue} asks for ${spec.takes} takes`);
      const [min, max] = spec.seconds;
      assert.ok(min > 0 && max > min, `${cue} has a length range of ${min}–${max}`);
      assert.ok(spec.gain > 0 && spec.gain <= 1.5, `${cue} has gain ${spec.gain}`);
      assert.ok(spec.what.length > 20, `${cue} has no useful description to record against`);
    }
  });

  test('the sounds heard most often have the most takes', () => {
    // Not a style rule. A cue the player hears four times a second with two
    // takes is a machine gun that alternates audibly, which is worse than one
    // take played straight.
    assert.ok(CUES['weapon.stormrepeater'].takes >= CUES['weapon.siegemortar'].takes);
    assert.ok(CUES['impact.kinetic'].takes >= CUES['ui.victory'].takes);
    assert.ok(CUES['ack.move'].takes >= CUES['ack.harvest'].takes);
  });

  test('no two cues describe themselves the same way', () => {
    const seen = new Map();
    for (const cue of CUE_NAMES) {
      const what = CUES[cue].what;
      assert.equal(seen.get(what), undefined, `${cue} and ${seen.get(what)} have identical briefs`);
      seen.set(what, cue);
    }
  });

  test('every group is one the cue sheet knows how to title', () => {
    assert.deepEqual([...GROUPS].sort(), ['ability', 'ack', 'impact', 'ui', 'weapon', 'world']);
  });
});

describe('take selection', () => {
  test('deals every take before repeating any', () => {
    const bag = createShuffleBag(4, () => 0.5);
    const first = [bag.next(), bag.next(), bag.next(), bag.next()];
    assert.deepEqual([...first].sort(), [0, 1, 2, 3], 'a bag of four did not deal all four');
  });

  test('never repeats across the seam between bags', () => {
    // The failure this exists to catch: bag one ends on take 2, bag two starts
    // on take 2, and the player hears the same gunshot twice 250 ms apart —
    // which is rarer than uniform random and therefore worse, because it
    // survives casual listening and only shows up in a recording.
    let seed = 0;
    const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    const bag = createShuffleBag(3, rand);
    let previous = bag.next();
    for (let i = 0; i < 300; i++) {
      const next = bag.next();
      assert.notEqual(next, previous, `take ${next} played twice in a row at draw ${i}`);
      previous = next;
    }
  });

  test('a single take is always that take, and no take is -1', () => {
    const one = createShuffleBag(1, Math.random);
    assert.equal(one.next(), 0);
    assert.equal(one.next(), 0);
    const none = createShuffleBag(0, Math.random);
    assert.equal(none.next(), -1);
  });
});

describe('the bank routes takes the way the mixer expects', () => {
  /**
   * Enough of an AudioContext to watch what gets wired to what.
   *
   * The thing worth pinning here is not that a sound plays — a browser test
   * can see that — but *where it goes*. A world cue that reaches the interface
   * bus is a gunshot that cannot be culled for distance and cannot be dropped
   * when the mix is full, and it will sound completely fine right up until
   * twenty of them arrive at once.
   */
  function harness({ reserve } = {}) {
    const wires = [];
    const node = (kind) => ({
      kind,
      gain: {
        value: 1,
        setValueAtTime() {},
        linearRampToValueAtTime() {},
        cancelScheduledValues() {},
        exponentialRampToValueAtTime() {},
      },
      pan: { setValueAtTime() {} },
      playbackRate: { value: 1 },
      connect(target) {
        wires.push(`${kind}->${target.kind}`);
      },
      start() {},
      stop() {},
    });
    const ctx = {
      currentTime: 0,
      sampleRate: 48000,
      createBufferSource: () => node('source'),
      createGain: () => node('gain'),
      createStereoPanner: () => node('panner'),
      decodeAudioData: (buf, ok) => ok({ duration: 0.2 }),
    };
    const reserved = [];
    const bank = createSampleBank(ctx, {
      world: node('worldBus'),
      ui: node('uiBus'),
      reserve: (dur, delay, critical) => {
        reserved.push(critical);
        return reserve ? reserve() : true;
      },
    });
    return { bank, wires, reserved };
  }

  test('a cue with no takes refuses, so the caller synthesises', () => {
    const { bank } = harness();
    assert.equal(bank.play('weapon.autocannon', { pan: 0, vol: 1 }), false);
    assert.equal(bank.has('weapon.autocannon'), false);
  });

  test('a world cue is panned onto the world bus', () => {
    const { bank, wires } = harness();
    bank.put('weapon.autocannon', [{ duration: 0.1 }, { duration: 0.1 }]);
    assert.equal(bank.play('weapon.autocannon', { pan: 0.5, vol: 0.8 }), true);
    assert.ok(wires.includes('gain->panner'), 'a positioned world sound went out unpanned');
    assert.ok(wires.includes('panner->worldBus'));
  });

  test('an interface cue goes straight to the interface bus', () => {
    const { bank, wires } = harness();
    bank.put('ui.click', [{ duration: 0.02 }]);
    assert.equal(bank.play('ui.click', { pan: 0, vol: 1 }), true);
    assert.ok(wires.includes('gain->uiBus'));
    assert.ok(!wires.includes('gain->worldBus'));
  });

  test('interface cues are protected from the voice ceiling and world cues are not', () => {
    const { bank, reserved } = harness();
    bank.put('ui.click', [{ duration: 0.02 }]);
    bank.put('weapon.autocannon', [{ duration: 0.1 }]);
    bank.play('ui.click', { pan: 0, vol: 1 });
    bank.play('weapon.autocannon', { pan: 0, vol: 1 });
    assert.deepEqual(reserved, [true, false], 'the critical flag is the wrong way round');
  });

  test('a full mix refuses a take rather than queueing it', () => {
    const { bank, wires } = harness({ reserve: () => false });
    bank.put('weapon.autocannon', [{ duration: 0.1 }]);
    assert.equal(bank.play('weapon.autocannon', { pan: 0, vol: 1 }), false);
    assert.deepEqual(wires, [], 'a refused take still built and wired up a source');
    // The refusal must not be mistaken for "no recording exists". Both end in
    // the synth, but only one of them is a reason to keep loading the pack.
    assert.equal(bank.has('weapon.autocannon'), true);
  });
});

describe('format selection', () => {
  const chromeish = (mime) => (mime.includes('webm') ? 'probably' : mime.includes('mp4') ? 'maybe' : '');
  const safari16 = (mime) => (mime.includes('mp4') ? 'probably' : '');

  test('prefers Opus where it is supported', () => {
    assert.equal(pickFormat(['webm', 'm4a'], chromeish), 'webm');
  });

  test('falls back to AAC on a browser that will not take Opus', () => {
    assert.equal(pickFormat(['webm', 'm4a'], safari16), 'm4a');
  });

  test('tries something rather than nothing when the browser claims no support', () => {
    // canPlayType is advisory and browsers understate it. A failed decode
    // costs one fetch and falls back to the synth like everything else, which
    // is cheaper than refusing a pack that would have worked.
    assert.equal(pickFormat(['webm', 'm4a'], () => ''), 'webm');
    assert.equal(pickFormat([], () => ''), null);
  });
});

describe('the score does not flap', () => {
  const now = 100000;

  test('climbs one step at a time, immediately', () => {
    // A single skirmish must not slam the score from calm to desperate.
    assert.equal(stepState('calm', 'desperate', now, now), 'battle');
    assert.equal(stepState('battle', 'desperate', now, now), 'desperate');
  });

  test('refuses to step down inside the cooldown', () => {
    assert.equal(stepState('battle', 'calm', now, now - 1000), 'battle');
    assert.equal(stepState('battle', 'calm', now, now - 20000), 'calm');
  });

  test('a lull of four seconds is not the end of a battle', () => {
    // The specific case this rule exists for: contact, then a gap while both
    // sides reposition, then contact again. The bed must ride through it.
    let state = 'battle';
    let since = now;
    for (let t = now; t < now + 4000; t += 100) {
      state = stepState(state, 'calm', t, since);
    }
    assert.equal(state, 'battle');
  });

  test('the end of a mission overrides the ladder in both directions', () => {
    assert.equal(stepState('desperate', 'victory', now, now), 'victory');
    assert.equal(stepState('calm', 'defeat', now, now), 'defeat');
    // And nothing steps back out of an end state.
    assert.equal(stepState('victory', 'battle', now, now - 60000), 'victory');
  });

  test('fades are asymmetric, and in the right direction', () => {
    assert.ok(
      MUSIC_FADE.up < MUSIC_FADE.down,
      'music must arrive at a fight faster than it leaves one, or it scores the wrong scene'
    );
  });

  test('every state named by the ladder exists', () => {
    for (const [name, spec] of Object.entries(MUSIC_STATES)) {
      assert.equal(typeof spec.intensity, 'number', `${name} has no intensity`);
      assert.equal(typeof spec.loop, 'boolean', `${name} does not say whether it loops`);
    }
  });
});

describe('what the events ask the score for', () => {
  test('losing a structure is desperation; losing a mech is a battle', () => {
    assert.equal(stateFromEvents([{ type: 'death', kind: 'building', player: 0 }], 0), 'desperate');
    assert.equal(stateFromEvents([{ type: 'death', kind: 'mech', player: 0 }], 0), 'battle');
  });

  test('their losses are not your desperation', () => {
    assert.equal(stateFromEvents([{ type: 'death', kind: 'building', player: 1 }], 0), 'battle');
  });

  test('a quiet tick asks for nothing at all', () => {
    // Not `calm` — that would step the score down on every frame between
    // shots, which is the flapping the ladder exists to prevent.
    assert.equal(stateFromEvents([{ type: 'deposit', id: 3 }], 0), null);
    assert.equal(stateFromEvents([], 0), null);
  });

  test('the end of the mission wins over everything in the same tick', () => {
    const events = [
      { type: 'explosion', big: true },
      { type: 'death', kind: 'building', player: 0 },
      { type: 'missionEnd', result: 'won' },
    ];
    assert.equal(stateFromEvents(events, 0), 'victory');
  });

  test('their Lance in flight is desperation on its own', () => {
    assert.equal(stateFromEvents([{ type: 'superweaponFired', player: 1 }], 0), 'desperate');
  });

  test('your own Lance is not', () => {
    // It is the best moment you have had all mission. Scoring it as
    // desperation tells the player they are losing at the instant they win.
    assert.equal(stateFromEvents([{ type: 'superweaponFired', player: 0 }], 0), 'battle');
  });
});

describe('the score survives the pack arriving late', () => {
  /**
   * A context that records what got started, and a fetch that hands back one
   * decodable track.
   */
  function harness() {
    const started = [];
    const node = (kind) => ({
      kind,
      loop: false,
      gain: {
        value: 0,
        setValueAtTime() {},
        linearRampToValueAtTime() {},
        cancelScheduledValues() {},
      },
      connect() {},
      start() {
        started.push(kind);
      },
      stop() {},
    });
    const ctx = {
      currentTime: 0,
      createBufferSource: () => node('source'),
      createGain: () => node('gain'),
      decodeAudioData: (raw, ok) => ok({ duration: 120 }),
    };
    const fetchImpl = async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(8) });
    const music = createMusic(ctx, {
      destination: node('master'),
      fetchImpl,
      storage: null,
      rand: () => 0,
    });
    return { music, started };
  }

  test('a state asked for before the manifest lands still plays once it does', async () => {
    // The exact boot order in the game: the title screen calls setMusicState
    // long before the manifest fetch resolves.
    const { music, started } = harness();
    await music.go('menu');
    assert.deepEqual(started, [], 'nothing should play before there are any tracks');

    music.adopt({ music: { menu: [{ file: 'out/music.menu/01.webm' }] } });
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(started, ['source'], 'the menu bed never started after the pack arrived');
  });

  test('adopting a manifest with nothing in it starts nothing', async () => {
    const { music, started } = harness();
    await music.go('menu');
    music.adopt({});
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(started, []);
  });

  test('a state with tracks plays without waiting to be re-adopted', async () => {
    const { music, started } = harness();
    music.adopt({ music: { battle: [{ file: 'out/music.battle/01.webm' }] } });
    await music.go('battle');
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(started, ['source']);
    assert.equal(music.state, 'battle');
  });
});

describe('the cue sheet', () => {
  test('matches the catalogue it is generated from', () => {
    // The sheet is what somebody takes into a room with a microphone. A sheet
    // that disagrees with the game is worse than none, because you find out on
    // the day, having recorded the wrong list.
    const committed = readFileSync(CUE_SHEET_PATH, 'utf8');
    assert.equal(
      committed,
      build(),
      'audio/CUE-SHEET.md is stale — run `npm run rocketman:audio:sheet`'
    );
  });
});

// Imported under a second name so the assertion above reads as the comparison
// it is, rather than as a call to something that might have side effects.
function build() {
  return buildCueSheet();
}
