/**
 * Content-table integrity.
 *
 * The tables are hand-edited during balance passes, and a typo there is a
 * crash at runtime rather than a compile error. These are the assertions that
 * turn "the Hangar produces a unit that does not exist" into a red test
 * instead of a bug report.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  UNITS,
  BUILDINGS,
  WEAPONS,
  ABILITIES,
  FACTIONS,
  BUILD_ORDER,
  DAMAGE_TABLE,
  DAMAGE,
  ARMOR,
  damageMultiplier,
  TERRAIN,
  TERRAIN_INFO,
} from '../engine/content.js';
import { DEFAULT_MAP_SIZE } from '../engine/grid.js';

describe('units', () => {
  for (const [id, def] of Object.entries(UNITS)) {
    test(`${id} is internally consistent`, () => {
      assert.equal(def.id, id, 'id field must match its key');
      assert.ok(def.hp > 0, 'needs hull');
      assert.ok(def.cost > 0, 'needs a cost');
      assert.ok(def.buildTime > 0, 'needs a build time');
      assert.ok(def.speed > 0, 'needs to be able to move');
      assert.ok(['ground', 'air'].includes(def.layer), 'layer must be ground or air');
      assert.ok(Object.values(ARMOR).includes(def.armor), `unknown armour class ${def.armor}`);

      for (const hp of def.hardpoints) {
        assert.ok(WEAPONS[hp], `${id} mounts unknown weapon ${hp}`);
      }
      if (def.ability) assert.ok(ABILITIES[def.ability], `${id} has unknown ability ${def.ability}`);
      if (def.builtAt) assert.ok(BUILDINGS[def.builtAt], `${id} built at unknown ${def.builtAt}`);
    });
  }

  test('every armed unit can actually shoot something', () => {
    for (const [id, def] of Object.entries(UNITS)) {
      if (def.hardpoints.length === 0) continue;
      const layers = new Set(def.hardpoints.flatMap((h) => WEAPONS[h].targets));
      assert.ok(layers.size > 0, `${id} has weapons that target nothing`);
    }
  });

  test('shields are paired with a regen rate', () => {
    for (const [id, def] of Object.entries(UNITS)) {
      if (def.shield > 0) {
        assert.ok(def.shieldRegen > 0, `${id} has a shield that can never come back`);
      }
    }
  });
});

describe('structures', () => {
  for (const [id, def] of Object.entries(BUILDINGS)) {
    test(`${id} is internally consistent`, () => {
      assert.equal(def.id, id);
      assert.ok(def.hp > 0);
      assert.ok(Array.isArray(def.size) && def.size.length === 2);
      assert.ok(def.size[0] > 0 && def.size[1] > 0);
      assert.equal(typeof def.power, 'number', 'power draw must be declared, even as 0');
      for (const hp of def.hardpoints || []) assert.ok(WEAPONS[hp], `unknown weapon ${hp}`);
      for (const req of def.requires || []) assert.ok(BUILDINGS[req], `unknown requirement ${req}`);
    });
  }

  test('the build bar only offers structures that exist', () => {
    for (const id of BUILD_ORDER) assert.ok(BUILDINGS[id], `build bar lists unknown ${id}`);
  });

  test('the build bar excludes the Command Rig', () => {
    // The HQ is the thing that builds; offering it in its own menu is the
    // classic way to end up with a player who cannot afford anything else.
    assert.ok(!BUILD_ORDER.includes('command'));
  });

  test('at least one structure generates power and one produces units', () => {
    const all = Object.values(BUILDINGS);
    assert.ok(all.some((b) => b.power > 0));
    assert.ok(all.some((b) => b.builds === 'units'));
    assert.ok(all.some((b) => b.dropOff));
  });
});

describe('factions', () => {
  for (const [id, faction] of Object.entries(FACTIONS)) {
    test(`${id} has a legal roster`, () => {
      assert.ok(faction.units.length >= 3, 'a faction needs a real roster');
      for (const unitId of faction.units) {
        assert.ok(UNITS[unitId], `${id} rosters unknown unit ${unitId}`);
        assert.equal(
          UNITS[unitId].faction,
          id,
          `${unitId} is on ${id}'s roster but tagged for another faction`
        );
      }
      for (const unitId of faction.startingUnits) {
        assert.ok(UNITS[unitId], `${id} starts with unknown unit ${unitId}`);
      }
    });

    test(`${id} can open without tech`, () => {
      // Every faction needs something buildable from a bare Foundry, or its
      // opening is simply "wait".
      const tierOne = faction.units.filter((u) => UNITS[u].tier === 1);
      assert.ok(tierOne.length > 0, `${id} has no tier-one units`);
    });
  }

  test('rosters do not overlap', () => {
    const seen = new Set();
    for (const faction of Object.values(FACTIONS)) {
      for (const unitId of faction.units) {
        assert.ok(!seen.has(unitId), `${unitId} appears on two rosters`);
        seen.add(unitId);
      }
    }
  });

  test('exactly one chassis is the signature unit the game is named for', () => {
    const signatures = Object.values(UNITS).filter((u) => u.signature);
    assert.equal(signatures.length, 1);
    assert.equal(signatures[0].ability, 'jumpjet', 'the Rocketman had better have jump jets');
  });
});

describe('the damage table', () => {
  test('covers every warhead against every armour class', () => {
    for (const damageType of Object.values(DAMAGE)) {
      const row = DAMAGE_TABLE[damageType];
      assert.ok(row, `no row for ${damageType}`);
      for (const armorClass of Object.values(ARMOR)) {
        assert.equal(typeof row[armorClass], 'number', `${damageType} vs ${armorClass} missing`);
      }
    }
  });

  test('encodes the intended counters', () => {
    const { KINETIC, EXPLOSIVE, ENERGY } = DAMAGE;
    // Kinetic shreds light and struggles against heavy.
    assert.ok(damageMultiplier(KINETIC, ARMOR.LIGHT) > damageMultiplier(KINETIC, ARMOR.HEAVY));
    // Explosive is the siege answer.
    assert.ok(
      damageMultiplier(EXPLOSIVE, ARMOR.STRUCTURE) > damageMultiplier(KINETIC, ARMOR.STRUCTURE)
    );
    // Energy is the heavy-mech answer.
    assert.ok(damageMultiplier(ENERGY, ARMOR.HEAVY) > damageMultiplier(KINETIC, ARMOR.HEAVY));
    // No damage warhead is simply better than another against everything —
    // otherwise one of them is dead content. EMP is excluded on both sides:
    // it is deliberately the worst warhead in the game at dealing damage and
    // buys that back with the disable, which this table does not model.
    const damaging = Object.values(DAMAGE).filter((d) => d !== DAMAGE.EMP);
    for (const a of damaging) {
      for (const b of damaging) {
        if (a === b) continue;
        const dominates = Object.values(ARMOR).every(
          (armor) => damageMultiplier(a, armor) >= damageMultiplier(b, armor)
        );
        assert.ok(!dominates, `${a} is never worse than ${b} — one of them is dead content`);
      }
    }
  });

  test('EMP is the worst warhead in the game at dealing damage', () => {
    for (const armor of Object.values(ARMOR)) {
      for (const other of Object.values(DAMAGE)) {
        if (other === DAMAGE.EMP) continue;
        assert.ok(
          damageMultiplier(DAMAGE.EMP, armor) < damageMultiplier(other, armor),
          `EMP should not out-damage ${other} against ${armor}`
        );
      }
    }
  });

  test('unknown warheads fall back to full damage rather than zero', () => {
    // A content typo should be visible in play, not silently disarm a unit.
    assert.equal(damageMultiplier('nonsense', ARMOR.LIGHT), 1);
  });
});

describe('abilities', () => {
  for (const [id, def] of Object.entries(ABILITIES)) {
    test(`${id} declares what the sim needs`, () => {
      assert.equal(def.id, id);
      assert.ok(def.cooldown > 0, 'an ability with no cooldown is a passive');
      assert.ok(def.name && def.hint, 'the UI needs a name and a hint');
      assert.ok(
        ['leap', 'speed', 'shield', 'toggle', 'heal', 'emp'].includes(def.kind),
        `unknown ability kind ${def.kind}`
      );
    });
  }
});

describe('the README does not drift from the tables', () => {
  test('the road cost it quotes is the road cost the game uses', () => {
    // Written after the prose and the content table disagreed: the README
    // quoted 0.62, which was the value before the discount was benchmarked
    // and raised to 0.72. A reader has no way to tell which number is real,
    // and the one in the design document is the one they will believe.
    //
    // The same idea as this repository's Stripe price-drift guard: a number
    // that lives in two places needs something that notices when they part.
    const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
    const quoted = readme.match(/([0-9.]+) against 1\.0/);
    assert.ok(quoted, 'the README no longer states a road cost — update this test with it');
    assert.equal(
      Number(quoted[1]),
      TERRAIN_INFO[TERRAIN.ROAD].cost,
      'the README and TERRAIN_INFO disagree about how fast a road is'
    );
  });

  test('the map size it quotes is the map size the game generates', () => {
    const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
    const quoted = readme.match(/\*\*(\d+)×\d+ cells\*\*/);
    assert.ok(quoted, 'the README no longer states a map size — update this test with it');
    assert.equal(Number(quoted[1]), DEFAULT_MAP_SIZE);
  });
});
