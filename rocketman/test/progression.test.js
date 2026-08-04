/**
 * Upgrades, pilots, and the stat tables they resolve into.
 *
 * The assertions that matter most here are the ones about *purity*: resolving
 * a loadout must not mutate the shared content tables, and the result must not
 * depend on the order upgrades were bought in. Either failure is invisible in
 * play until it is catastrophic — one leaks the player's upgrades into the
 * enemy's units, the other means two players with identical loadouts have
 * different mechs.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  UPGRADES,
  BRANCHES,
  PILOTS,
  XP_CURVE,
  MAX_PILOT_LEVEL,
  PERK_LEVEL,
  resolveDefs,
  baseDefs,
  levelForXp,
  xpToNextLevel,
  pilotEffects,
  upgradeAvailable,
  missionRewards,
} from '../engine/progression.js';
import { UNITS, BUILDINGS, WEAPONS, ABILITIES } from '../engine/content.js';
import { createWorld } from '../engine/sim.js';
import { spawnUnit } from '../engine/entities.js';

describe('the upgrade catalogue', () => {
  for (const [id, up] of Object.entries(UPGRADES)) {
    test(`${id} is well formed`, () => {
      assert.equal(up.id, id);
      assert.ok(up.name && up.hint, 'the Hangar needs a name and a description');
      assert.ok(up.cost > 0, 'a free upgrade is just a buff');
      assert.ok(
        BRANCHES.some((b) => b.id === up.branch),
        `${id} is in unknown branch ${up.branch}`
      );
      assert.ok(up.effects.length > 0, 'an upgrade with no effects does nothing');

      for (const effect of up.effects) {
        assert.ok(
          ['unit', 'building', 'weapon', 'ability'].includes(effect.target),
          `unknown target ${effect.target}`
        );
        assert.ok(['add', 'mul', 'set'].includes(effect.op), `unknown op ${effect.op}`);
      }
      for (const req of up.requires || []) {
        assert.ok(UPGRADES[req], `${id} requires unknown upgrade ${req}`);
      }
    });
  }

  test('every effect selector matches something', () => {
    // A typo'd id is a silent no-op — the player pays and gets nothing.
    const tables = { unit: UNITS, building: BUILDINGS, weapon: WEAPONS, ability: ABILITIES };
    for (const [id, up] of Object.entries(UPGRADES)) {
      for (const effect of up.effects) {
        if (effect.id === '*') continue;
        const table = tables[effect.target];
        if (effect.id.endsWith(':*')) {
          const type = effect.id.slice(0, -2);
          assert.ok(
            Object.values(table).some((d) => d.type === type),
            `${id} targets damage type ${type}, which nothing has`
          );
          continue;
        }
        assert.ok(table[effect.id], `${id} targets unknown ${effect.target} "${effect.id}"`);
      }
    }
  });

  test('requirement chains cannot cycle', () => {
    for (const id of Object.keys(UPGRADES)) {
      const seen = new Set();
      const walk = (current) => {
        if (seen.has(current)) assert.fail(`requirement cycle through ${current}`);
        seen.add(current);
        for (const req of UPGRADES[current].requires || []) walk(req);
        seen.delete(current);
      };
      walk(id);
    }
  });

  test('availability respects prerequisites', () => {
    assert.equal(upgradeAvailable([], 'hardened_frames'), false);
    assert.equal(upgradeAvailable(['field_plating'], 'hardened_frames'), true);
    assert.equal(upgradeAvailable(['field_plating'], 'field_plating'), false, 'already owned');
  });
});

describe('resolving a loadout', () => {
  test('leaves the shared content tables untouched', () => {
    const before = UNITS.kestrel.hp;
    const weaponBefore = WEAPONS.rocketpod.damage;

    resolveDefs({ upgrades: ['field_plating', 'warheads', 'kestrel_pods'] });

    assert.equal(UNITS.kestrel.hp, before, 'the global unit table was mutated');
    assert.equal(WEAPONS.rocketpod.damage, weaponBefore, 'the global weapon table was mutated');
  });

  test('a bare loadout matches the base tables', () => {
    const defs = baseDefs();
    assert.equal(defs.units.kestrel.hp, UNITS.kestrel.hp);
    assert.equal(defs.weapons.autocannon.damage, WEAPONS.autocannon.damage);
  });

  test('applies a flat multiplier to every unit', () => {
    const defs = resolveDefs({ upgrades: ['field_plating'] });
    for (const id of Object.keys(UNITS)) {
      assert.ok(defs.units[id].hp > UNITS[id].hp, `${id} did not gain hull`);
    }
  });

  test('damage-type selectors hit only that warhead', () => {
    const defs = resolveDefs({ upgrades: ['focusing'] });
    assert.ok(defs.weapons.beamlance.damage > WEAPONS.beamlance.damage, 'energy not boosted');
    assert.equal(defs.weapons.autocannon.damage, WEAPONS.autocannon.damage, 'kinetic was boosted');
  });

  test('reaches nested stats through their flat aliases', () => {
    const defs = resolveDefs({ upgrades: ['kestrel_pods'] });
    assert.equal(defs.weapons.rocketpod.salvo.count, WEAPONS.rocketpod.salvo.count + 2);
    // And does not corrupt the shared nested object.
    assert.notEqual(defs.weapons.rocketpod.salvo, WEAPONS.rocketpod.salvo);
  });

  test('is independent of the order upgrades were bought in', () => {
    const forwards = resolveDefs({
      upgrades: ['field_plating', 'hardened_frames', 'capacitors', 'servos'],
    });
    const backwards = resolveDefs({
      upgrades: ['servos', 'capacitors', 'hardened_frames', 'field_plating'],
    });
    assert.deepEqual(forwards.units, backwards.units);
    assert.deepEqual(forwards.buildings, backwards.buildings);
  });

  test('keeps tick-valued stats whole', () => {
    const defs = resolveDefs({ upgrades: ['autoloaders', 'prefab', 'kestrel_jets'] });
    for (const w of Object.values(defs.weapons)) {
      assert.ok(Number.isInteger(w.cooldown), `${w.id} cooldown is fractional`);
    }
    for (const b of Object.values(defs.buildings)) {
      assert.ok(Number.isInteger(b.buildTime), `${b.id} buildTime is fractional`);
    }
    assert.ok(Number.isInteger(defs.abilities.jumpjet.cooldown));
  });

  test('keeps hull and shield pools whole', () => {
    const defs = resolveDefs({ upgrades: ['field_plating', 'hardened_frames', 'capacitors'] });
    for (const u of Object.values(defs.units)) {
      assert.ok(Number.isInteger(u.hp), `${u.id} hull is fractional`);
      assert.ok(Number.isInteger(u.shield), `${u.id} shield is fractional`);
    }
  });

  test('Reactor Shielding removes the detonation rather than dampening it', () => {
    assert.ok(BUILDINGS.reactor.deathExplosion, 'this test needs a reactor that explodes');
    const defs = resolveDefs({ upgrades: ['reactor_shielding'] });
    assert.equal(defs.buildings.reactor.deathExplosion, undefined);
    assert.equal(defs.buildings.reactor.power, BUILDINGS.reactor.power + 20);
    assert.ok(BUILDINGS.reactor.deathExplosion, 'the base table lost its explosion');
  });

  test('an unknown upgrade id is ignored rather than fatal', () => {
    const defs = resolveDefs({ upgrades: ['not_a_real_upgrade'] });
    assert.equal(defs.units.kestrel.hp, UNITS.kestrel.hp);
  });
});

describe('pilots', () => {
  for (const [id, pilot] of Object.entries(PILOTS)) {
    test(`${id} is well formed`, () => {
      assert.equal(pilot.id, id);
      assert.ok(UNITS[pilot.chassis], `${id} flies unknown chassis ${pilot.chassis}`);
      assert.ok(pilot.blurb && pilot.perk.name && pilot.perk.hint);
      assert.ok(pilot.perk.effects.length > 0, 'a perk with no effects is a name');
    });
  }

  test('the level curve is ascending and starts at zero', () => {
    assert.equal(XP_CURVE[0], 0);
    for (let i = 1; i < XP_CURVE.length; i++) {
      assert.ok(XP_CURVE[i] > XP_CURVE[i - 1], 'the XP curve goes backwards');
    }
    assert.equal(levelForXp(0), 1);
    assert.equal(levelForXp(XP_CURVE[1]), 2);
    assert.equal(levelForXp(XP_CURVE[XP_CURVE.length - 1] + 99999), MAX_PILOT_LEVEL);
  });

  test('xpToNextLevel reports null at max', () => {
    assert.ok(xpToNextLevel(0).need > 0);
    assert.equal(xpToNextLevel(XP_CURVE[XP_CURVE.length - 1]), null);
  });

  test('a perk only applies from its unlock level', () => {
    const below = pilotEffects('ash', PERK_LEVEL - 1);
    const at = pilotEffects('ash', PERK_LEVEL);
    const perkEffects = PILOTS.ash.perk.effects.length;
    assert.equal(at.length - below.length, perkEffects, 'the perk did not come online');
  });

  test('levelling a pilot improves the chassis they fly', () => {
    const rookie = resolveDefs({ pilots: [{ id: 'ash', level: 1 }] });
    const veteran = resolveDefs({ pilots: [{ id: 'ash', level: MAX_PILOT_LEVEL }] });
    assert.ok(veteran.units.kestrel.hp > rookie.units.kestrel.hp);
    assert.ok(
      veteran.abilities.jumpjet.cooldown < rookie.abilities.jumpjet.cooldown,
      'Ash’s perk did not shorten her jump-jet cooldown'
    );
  });

  test('an unknown pilot id contributes nothing', () => {
    assert.deepEqual(pilotEffects('nobody', 5), []);
  });
});

describe('upgrades reach the simulation', () => {
  function worldWith(upgrades) {
    return createWorld({
      seed: 5,
      players: [{ faction: 'ascendancy', upgrades }, { faction: 'bulwark' }],
    });
  }

  test('an upgraded unit spawns with the upgraded stats', () => {
    const plain = worldWith([]);
    const buffed = worldWith(['field_plating']);

    const a = spawnUnit(plain, 'kestrel', 0, 20, 20);
    const b = spawnUnit(buffed, 'kestrel', 0, 20, 20);
    assert.ok(b.maxHp > a.maxHp, 'the upgrade never reached the spawned unit');
  });

  test('weapon upgrades reach the hardpoints a unit spawns with', () => {
    const buffed = worldWith(['warheads']);
    const kestrel = spawnUnit(buffed, 'kestrel', 0, 20, 20);
    const pod = kestrel.weapons.find((w) => w.id === 'rocketpod');
    assert.ok(pod.def.damage > WEAPONS.rocketpod.damage);
  });

  test('ability upgrades reach the ability a unit spawns with', () => {
    const buffed = worldWith(['kestrel_jets']);
    const kestrel = spawnUnit(buffed, 'kestrel', 0, 20, 20);
    assert.ok(kestrel.ability.def.distance > ABILITIES.jumpjet.distance);
  });

  test('one player’s upgrades never leak into another’s units', () => {
    const world = createWorld({
      seed: 5,
      players: [{ faction: 'ascendancy', upgrades: ['field_plating'] }, { faction: 'bulwark' }],
    });

    const mine = spawnUnit(world, 'vireo', 0, 20, 20);
    const theirs = spawnUnit(world, 'tick', 1, 40, 40);
    assert.ok(mine.maxHp > UNITS.vireo.hp, 'my upgrade did not apply');
    assert.equal(theirs.maxHp, UNITS.tick.hp, 'my upgrade leaked to the enemy');
  });

  test('an un-upgraded world still matches the base tables exactly', () => {
    const world = worldWith([]);
    const vireo = spawnUnit(world, 'vireo', 0, 20, 20);
    assert.equal(vireo.maxHp, UNITS.vireo.hp);
  });
});

describe('mission rewards', () => {
  const mission = { reward: 500, parTime: 1000 };

  test('pay a base amount plus a kill bonus', () => {
    const r = missionRewards(mission, { killed: 4, ticks: 2000 });
    assert.equal(r.base, 500);
    assert.equal(r.killBonus, 100);
    assert.equal(r.salvage, 600);
  });

  test('pay extra for beating par, and nothing for missing it', () => {
    const fast = missionRewards(mission, { killed: 0, ticks: 500 });
    const slow = missionRewards(mission, { killed: 0, ticks: 5000 });
    assert.ok(fast.speedBonus > 0);
    assert.equal(slow.speedBonus, 0);
    assert.ok(fast.salvage > slow.salvage);
  });

  test('a mission with no par time never pays a speed bonus', () => {
    const r = missionRewards({ reward: 500 }, { killed: 0, ticks: 1 });
    assert.equal(r.speedBonus, 0);
  });
});
