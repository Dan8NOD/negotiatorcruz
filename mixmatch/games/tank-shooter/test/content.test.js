/**
 * The content tables, checked the way a design document cannot be.
 *
 * Every claim the tables make about themselves is asserted here, because the
 * claims are the game. "No two hostiles ask the same question" is the sentence
 * the whole roster is built on, and a sentence in a comment is worth nothing
 * six months later when someone adds a sixth machine that charges in a straight
 * line and detonates.
 *
 * The pattern is lifted from `rocketman/test/content.test.js`: content is data,
 * data can be walked, and anything a designer could get wrong by hand is
 * something a loop can check in a millisecond.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  ARENA,
  COVER,
  TICKS_PER_SECOND,
  TANK,
  GUNS,
  GUN_IDS,
  STARTING_GUN,
  HOSTILES,
  HOSTILE_IDS,
  WAVES,
  PICKUPS,
  unlockedAt,
  damageAgainst,
} from '../engine/content.js';

describe('the roster', () => {
  test('every hostile asks a question, and no two ask the same one', () => {
    // The rule the whole roster is designed against. Two machines that ask the
    // same question are one machine with two sprites: the player learns a
    // single answer and both stop being interesting.
    const asked = new Map();
    for (const id of HOSTILE_IDS) {
      const asks = HOSTILES[id].asks;
      assert.ok(asks && asks.length > 10, `${id} does not say what it asks of the player`);
      assert.equal(asked.get(asks), undefined, `${id} and ${asked.get(asks)} ask the same question`);
      asked.set(asks, id);
    }
  });

  test('no two hostiles share a behaviour', () => {
    const seen = new Map();
    for (const id of HOSTILE_IDS) {
      const b = HOSTILES[id].behaviour;
      assert.equal(seen.get(b), undefined, `${id} and ${seen.get(b)} both behave as '${b}'`);
      seen.set(b, id);
    }
  });

  test('nothing new arrives in the same wave as something else new', () => {
    // A player learning two answers at once learns neither.
    const waves = HOSTILE_IDS.map((id) => HOSTILES[id].minWave);
    assert.equal(new Set(waves).size, waves.length, 'two hostiles debut on the same wave');
  });

  test('the roster opens with exactly one hostile', () => {
    assert.deepEqual(unlockedAt(1), ['scuttler']);
  });

  test('every hostile is unlocked by the time the curve turns steep', () => {
    // WAVES.budget goes quadratic from wave 5. Introducing a new mechanic
    // after that point means teaching it during the hardest part of the run.
    for (const id of HOSTILE_IDS) {
      assert.ok(HOSTILES[id].minWave <= 5, `${id} debuts on wave ${HOSTILES[id].minWave}, too late`);
    }
  });

  test('a hostile that shoots has a telegraph long enough to react to', () => {
    // 0.35s is a generous human reaction time. Anything shorter is a hit the
    // player could not have avoided, and this game's deaths have to be earned.
    for (const id of HOSTILE_IDS) {
      const def = HOSTILES[id];
      if (!def.gun) continue;
      assert.ok(def.gun.telegraph >= 0.35, `${id} telegraphs for only ${def.gun.telegraph}s`);
      assert.ok(def.gun.cooldown > def.gun.telegraph, `${id} re-aims before its own shot lands`);
    }
  });

  test('everything that shoots is slower than the tank, or cannot move at all', () => {
    // A ranged enemy that can also outrun you is a problem with no answer.
    for (const id of HOSTILE_IDS) {
      const def = HOSTILES[id];
      if (!def.gun) continue;
      assert.ok(def.speed < TANK.maxSpeed, `${id} shoots and outruns the tank`);
    }
  });

  test('score tracks the trouble a hostile causes, in roster order', () => {
    const scores = HOSTILE_IDS.map((id) => HOSTILES[id].score);
    for (let i = 1; i < scores.length; i++) {
      assert.ok(scores[i] > scores[i - 1], `${HOSTILE_IDS[i]} is not worth more than its predecessor`);
    }
  });

  test('a lobber cannot lead perfectly', () => {
    // A perfect predictor is not difficult, it is unfair — the counter would be
    // to stand still, which is the opposite of what this game teaches.
    assert.ok(HOSTILES.lobber.lead < 1, 'the lobber leads perfectly and cannot be dodged by turning');
  });
});

describe('the guns', () => {
  test('the starting gun exists', () => {
    assert.ok(GUNS[STARTING_GUN], `STARTING_GUN '${STARTING_GUN}' is not a gun`);
  });

  test('no gun is simply better than another', () => {
    // Sustained damage is held close on purpose. A gun that wins everywhere
    // makes the pickups a lottery for whether you got the good one.
    //
    // These are each gun's *ceiling* against one target — every pellet
    // connecting, which for the scattergun only happens at point-blank, and
    // ignoring the lance's pierce. So the scattergun is allowed to top the
    // table: this is measuring the best case of a gun that has to be in the
    // worst position to reach it.
    const ceiling = (id) => (GUNS[id].damage * GUNS[id].pellets) / GUNS[id].cooldown;
    const dps = GUN_IDS.map(ceiling);
    const best = Math.max(...dps);
    const worst = Math.min(...dps);
    assert.ok(
      best / worst < 1.5,
      `best-case damage per second spans ${worst.toFixed(0)}–${best.toFixed(0)}, too wide — ` +
        GUN_IDS.map((id) => `${id} ${ceiling(id).toFixed(0)}`).join(', ')
    );
  });

  test('the gun with the highest ceiling is the one that must get closest', () => {
    // The trade that keeps the table honest: whatever tops the damage chart
    // has to pay for it in range, or it is simply the best gun.
    const ceiling = (id) => (GUNS[id].damage * GUNS[id].pellets) / GUNS[id].cooldown;
    const reach = (id) => GUNS[id].speed * GUNS[id].life;
    const hardest = [...GUN_IDS].sort((a, b) => ceiling(b) - ceiling(a))[0];
    const shortest = [...GUN_IDS].sort((a, b) => reach(a) - reach(b))[0];
    assert.equal(hardest, shortest, `${hardest} hits hardest without having the shortest reach`);
  });

  test('each gun is the best answer to something', () => {
    // Stated as the specific properties each one owns alone. If a second gun
    // ever gains one of these, this test is the reminder to re-differentiate.
    assert.ok(GUNS.scattergun.pellets > 1, 'the scattergun is the only multi-pellet gun');
    assert.equal(GUN_IDS.filter((id) => GUNS[id].pellets > 1).length, 1);

    assert.ok(GUNS.lance.pierce > 0, 'the lance is the only piercing gun');
    assert.equal(GUN_IDS.filter((id) => GUNS[id].pierce > 0).length, 1);

    const shove = Math.max(...GUN_IDS.map((id) => GUNS[id].knockback));
    assert.equal(GUNS.scattergun.knockback, shove, 'the scattergun must shove hardest');
  });

  test('range follows from the numbers, not from a range stat', () => {
    // The scattergun is short-ranged because its pellets expire, which is a
    // thing the player can see happen rather than a rule they must be told.
    const reach = (id) => GUNS[id].speed * GUNS[id].life;
    assert.ok(reach('scattergun') < reach('cannon') / 2, 'the scattergun reaches too far to be a close-range gun');
    assert.ok(reach('lance') > reach('cannon'), 'the lance should outrange the cannon');
  });

  test('every gun can cross a meaningful part of the arena', () => {
    for (const id of GUN_IDS) {
      assert.ok(GUNS[id].speed * GUNS[id].life > 200, `${id} shots die within 200 units`);
    }
  });
});

describe('the warden shield', () => {
  const warden = HOSTILES.warden;

  test('blocks the front and not the back', () => {
    const facing = 0;
    // Shot arriving from directly ahead of the warden.
    const front = damageAgainst(warden, facing, 0, GUNS.cannon);
    // Shot arriving from directly behind it.
    const back = damageAgainst(warden, facing, Math.PI, GUNS.cannon);
    assert.ok(front < GUNS.cannon.damage, 'the shield does not reduce frontal damage');
    assert.equal(back, GUNS.cannon.damage, 'the shield reduces damage from behind');
  });

  test('the arc has an edge, and it is where the table says', () => {
    const inside = damageAgainst(warden, 0, warden.shieldArc - 0.01, GUNS.cannon);
    const outside = damageAgainst(warden, 0, warden.shieldArc + 0.01, GUNS.cannon);
    assert.ok(inside < outside, 'the shield arc boundary is not where shieldArc says');
  });

  test('wraps correctly across the angle discontinuity', () => {
    // The bug this exists to catch: a warden facing just under +π, shot from
    // just over −π, is being shot in the face — but a naive subtraction says
    // the angles differ by nearly 2π and calls it a flank.
    const facing = Math.PI - 0.05;
    const from = -Math.PI + 0.05;
    const damage = damageAgainst(warden, facing, from, GUNS.cannon);
    assert.ok(damage < GUNS.cannon.damage, 'a frontal shot across ±π was treated as a flank');
  });

  test('the lance ignores it entirely', () => {
    // This is what makes the lance a genuine second answer to the warden
    // rather than a slower version of the first.
    const front = damageAgainst(warden, 0, 0, GUNS.lance);
    assert.equal(front, GUNS.lance.damage);
  });

  test('a shielded warden cannot be out-damaged from the front', () => {
    // The claim the warden's whole identity rests on: no fire rate solves it.
    // Frontal cannon DPS must be low enough that flanking is not merely
    // preferable but necessary.
    const frontalDps =
      (damageAgainst(warden, 0, 0, GUNS.cannon) * GUNS.cannon.pellets) / GUNS.cannon.cooldown;
    const secondsToKill = warden.health / frontalDps;
    assert.ok(secondsToKill > 8, `a warden dies to frontal fire in ${secondsToKill.toFixed(1)}s`);
  });
});

describe('the wave curve', () => {
  test('budget rises every wave', () => {
    for (let n = 2; n <= 40; n++) {
      assert.ok(WAVES.budget(n) > WAVES.budget(n - 1), `wave ${n} is not richer than ${n - 1}`);
    }
  });

  test('the first wave is small enough to be a warm-up', () => {
    // An arcade round that charges a token has to let the player feel
    // competent before it starts taking the token seriously.
    const first = WAVES.budget(1);
    assert.ok(first / WAVES.cost.scuttler <= 6, `wave 1 opens with ${first / WAVES.cost.scuttler} scuttlers`);
  });

  test('the curve is gentle before wave 5 and steep after', () => {
    const early = WAVES.budget(4) - WAVES.budget(3);
    const late = WAVES.budget(12) - WAVES.budget(11);
    assert.ok(late > early * 2, 'the difficulty curve never actually turns');
  });

  test('every hostile is affordable on the wave it debuts', () => {
    // A hostile the budget cannot buy on its own debut wave is a hostile the
    // player meets a wave or two later than the table claims.
    for (const id of HOSTILE_IDS) {
      const n = HOSTILES[id].minWave;
      assert.ok(WAVES.budget(n) >= WAVES.cost[id], `wave ${n} cannot afford the ${id} it introduces`);
    }
  });

  test('every hostile has a cost', () => {
    for (const id of HOSTILE_IDS) {
      assert.ok(WAVES.cost[id] > 0, `${id} has no wave cost`);
    }
    assert.deepEqual(Object.keys(WAVES.cost).sort(), [...HOSTILE_IDS].sort());
  });

  test('cost tracks score, so an expensive wave is a valuable one', () => {
    const ids = [...HOSTILE_IDS].sort((a, b) => WAVES.cost[a] - WAVES.cost[b]);
    const scores = ids.map((id) => HOSTILES[id].score);
    for (let i = 1; i < scores.length; i++) {
      assert.ok(scores[i] >= scores[i - 1], 'a cheaper hostile is worth more points than a dearer one');
    }
  });
});

describe('the pickups', () => {
  test('every scheduled pickup names a real gun', () => {
    for (const [wave, gun] of Object.entries(PICKUPS.schedule)) {
      assert.ok(GUNS[gun], `wave ${wave} drops '${gun}', which is not a gun`);
    }
  });

  test('both alternate guns are offered before the curve turns steep', () => {
    const early = Object.entries(PICKUPS.schedule)
      .filter(([wave]) => Number(wave) <= 5)
      .map(([, gun]) => gun);
    for (const id of GUN_IDS) {
      if (id === STARTING_GUN) continue;
      assert.ok(early.includes(id), `${id} is not offered until after wave 5`);
    }
  });

  test('a gun drop and a repair never land on the same wave', () => {
    // dropWavePickup drops one thing. Scheduling both on a wave would silently
    // discard the gun, and the player would never know they were owed one.
    for (const wave of PICKUPS.repairWaves) {
      assert.equal(PICKUPS.schedule[wave], undefined, `wave ${wave} schedules both a repair and a gun`);
    }
  });

  test('a repair is worth taking but does not trivialise a hit', () => {
    assert.ok(PICKUPS.repairAmount > HOSTILES.warden.damage, 'a repair is worth less than one warden hit');
    assert.ok(PICKUPS.repairAmount < TANK.maxHealth, 'a repair is a full heal');
  });
});

describe('the tank', () => {
  test('the boost is faster than driving, and costs something', () => {
    assert.ok(TANK.boost.speed > TANK.maxSpeed * 1.5, 'the boost is barely faster than driving');
    assert.ok(TANK.boost.cooldown > TANK.boost.seconds * 4, 'the boost is available too often to be a decision');
  });

  test('the turret out-turns the hull', () => {
    // What makes reversing while firing a real option, and therefore what
    // makes retreating a tactic rather than a surrender.
    assert.ok(TANK.turretTurn > TANK.hullTurn);
  });

  test('the tank survives a run of bad luck but not a careless one', () => {
    const worst = HOSTILES.warden.damage;
    const hits = TANK.maxHealth / worst;
    assert.ok(hits >= 4 && hits <= 6, `the tank takes ${hits.toFixed(1)} warden hits; wanted 4–6`);
  });

  test('invulnerability covers less than a scuttler needs to re-reach you', () => {
    // Long enough that a crowd cannot chain-stun, short enough that standing
    // in a swarm still kills.
    assert.ok(TANK.invulnerable > 0.3 && TANK.invulnerable < 1.0);
  });
});

describe('the arena', () => {
  test('is square, and crossable in a few seconds', () => {
    assert.equal(ARENA.width, ARENA.height);
    const seconds = ARENA.width / TANK.maxSpeed;
    assert.ok(seconds > 3 && seconds < 8, `crossing takes ${seconds.toFixed(1)}s`);
  });

  test('the largest cover block fits between the edge margins', () => {
    // generateCover rejection-samples inside these bounds. If the widest block
    // cannot fit, the generator quietly produces fewer blocks than COVER.min
    // and the arena loses the sightline breaks the gunhead depends on.
    assert.ok(COVER.size[1] + COVER.edgeMargin * 2 < ARENA.width);
    assert.ok(COVER.size[0] < COVER.size[1], 'the cover size range is inverted');
  });

  test('there is always enough cover to break a sightline', () => {
    assert.ok(COVER.min >= 4, 'too little cover for the gunhead to be a question about cover');
    assert.ok(COVER.max >= COVER.min);
  });
});
