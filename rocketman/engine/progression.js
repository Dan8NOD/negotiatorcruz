/**
 * Progression: upgrades, pilots, and the resolved stat tables they produce.
 *
 * The campaign's whole reward loop lives here. A mission pays out salvage, the
 * player spends it in the Hangar, and the next mission is fought with better
 * machines — which is the thing a solo campaign needs in order to be a
 * campaign rather than a list of skirmishes.
 *
 * The load-bearing constraint is that none of this may break determinism.
 * Upgrades are therefore *not* applied as live effects during a match. They
 * are resolved **once**, before the world exists, into a per-player copy of the
 * unit/building/weapon tables. From the simulation's point of view an upgraded
 * Kestrel is simply a Kestrel with different numbers, and every guarantee in
 * sim.js still holds: same seed, same commands, same loadout, same world.
 *
 * The corollary is that effect ordering must not matter, because a player who
 * bought armour before guns must end up with the same mech as one who bought
 * guns before armour. Additions are applied before multiplications and each
 * pass is sorted, so the resolved table is a pure function of the *set* of
 * upgrades, not the order they were purchased in.
 */

import { UNITS, BUILDINGS, WEAPONS, ABILITIES, secs } from './content.js';

/* ------------------------------------------------------------- upgrades -- */

/**
 * An effect targets a table (`unit`, `building`, `weapon`, `ability`), an id
 * within it (or `*` for every entry), a stat, and an operation.
 *
 * `add` runs before `mul`, so "+40 hull" then "+10% hull" is the same mech
 * whichever order they were bought in.
 */
const UNIT = 'unit';
const WEAPON = 'weapon';
const BUILDING = 'building';
const ABILITY = 'ability';

export const UPGRADES = {
  /* ---- command: army-wide, expensive, always worth it ------------------ */
  field_plating: {
    id: 'field_plating',
    name: 'Field Plating',
    branch: 'command',
    cost: 600,
    hint: 'Scavenged Bulwark armour, bolted on badly. Every chassis gains 12% hull.',
    effects: [{ target: UNIT, id: '*', stat: 'hp', op: 'mul', value: 1.12 }],
  },
  hardened_frames: {
    id: 'hardened_frames',
    name: 'Hardened Frames',
    branch: 'command',
    cost: 900,
    requires: ['field_plating'],
    hint: 'A further 15% hull, and 25% on structures.',
    effects: [
      { target: UNIT, id: '*', stat: 'hp', op: 'mul', value: 1.15 },
      { target: BUILDING, id: '*', stat: 'hp', op: 'mul', value: 1.25 },
    ],
  },
  capacitors: {
    id: 'capacitors',
    name: 'Capacitor Banks',
    branch: 'command',
    cost: 750,
    hint: 'Shields hold 20% more and come back 30% faster.',
    effects: [
      { target: UNIT, id: '*', stat: 'shield', op: 'mul', value: 1.2 },
      { target: UNIT, id: '*', stat: 'shieldRegen', op: 'mul', value: 1.3 },
    ],
  },
  servos: {
    id: 'servos',
    name: 'Overtuned Servos',
    branch: 'command',
    cost: 700,
    hint: 'Every mech moves 12% faster. Applies to Collectors too.',
    effects: [{ target: UNIT, id: '*', stat: 'speed', op: 'mul', value: 1.12 }],
  },
  targeting_uplink: {
    id: 'targeting_uplink',
    name: 'Targeting Uplink',
    branch: 'command',
    cost: 950,
    requires: ['capacitors'],
    hint: 'Every weapon reaches 10% further. Range wins fights that damage cannot.',
    effects: [
      { target: WEAPON, id: '*', stat: 'range', op: 'mul', value: 1.1 },
      { target: WEAPON, id: '*', stat: 'deployedRange', op: 'mul', value: 1.1 },
    ],
  },

  /* ---- ordnance: one branch per warhead -------------------------------- */
  munitions: {
    id: 'munitions',
    name: 'Match-Grade Munitions',
    branch: 'ordnance',
    cost: 500,
    hint: 'Kinetic weapons hit 15% harder. Autocannons and scatterguns.',
    effects: [{ target: WEAPON, id: 'kinetic:*', stat: 'damage', op: 'mul', value: 1.15 }],
  },
  warheads: {
    id: 'warheads',
    name: 'Shaped Warheads',
    branch: 'ordnance',
    cost: 550,
    hint: 'Explosive weapons hit 15% harder and throw 20% wider.',
    effects: [
      { target: WEAPON, id: 'explosive:*', stat: 'damage', op: 'mul', value: 1.15 },
      { target: WEAPON, id: 'explosive:*', stat: 'splashRadius', op: 'mul', value: 1.2 },
    ],
  },
  focusing: {
    id: 'focusing',
    name: 'Focusing Arrays',
    branch: 'ordnance',
    cost: 550,
    hint: 'Energy weapons hit 18% harder. The heavy-armour answer, sharpened.',
    effects: [{ target: WEAPON, id: 'energy:*', stat: 'damage', op: 'mul', value: 1.18 }],
  },
  autoloaders: {
    id: 'autoloaders',
    name: 'Autoloaders',
    branch: 'ordnance',
    cost: 1100,
    requires: ['munitions'],
    hint: 'Every weapon cycles 12% faster.',
    effects: [{ target: WEAPON, id: '*', stat: 'cooldown', op: 'mul', value: 0.88 }],
  },

  /* ---- logistics: the boring branch that wins campaigns ---------------- */
  logistics: {
    id: 'logistics',
    name: 'Cargo Rigging',
    branch: 'logistics',
    cost: 400,
    hint: 'Collectors carry 30% more per trip.',
    effects: [{ target: UNIT, id: 'collector', stat: 'capacity', op: 'mul', value: 1.3 }],
  },
  cutting_gear: {
    id: 'cutting_gear',
    name: 'Cutting Gear',
    branch: 'logistics',
    cost: 500,
    requires: ['logistics'],
    hint: 'Collectors strip scrap 35% faster.',
    effects: [{ target: UNIT, id: 'collector', stat: 'harvestRate', op: 'mul', value: 1.35 }],
  },
  reactor_shielding: {
    id: 'reactor_shielding',
    name: 'Reactor Shielding',
    branch: 'logistics',
    cost: 650,
    hint: 'Reactors generate 20 more power and no longer detonate when killed.',
    effects: [
      { target: BUILDING, id: 'reactor', stat: 'power', op: 'add', value: 20 },
      { target: BUILDING, id: 'reactor', stat: 'noDeathExplosion', op: 'set', value: true },
    ],
  },
  prefab: {
    id: 'prefab',
    name: 'Prefabricated Sections',
    branch: 'logistics',
    cost: 800,
    requires: ['reactor_shielding'],
    hint: 'Structures go up 25% faster and mechs roll out 15% faster.',
    effects: [
      { target: BUILDING, id: '*', stat: 'buildTime', op: 'mul', value: 0.75 },
      { target: UNIT, id: '*', stat: 'buildTime', op: 'mul', value: 0.85 },
    ],
  },

  /* ---- chassis: the ones that change how a unit plays ------------------ */
  kestrel_pods: {
    id: 'kestrel_pods',
    name: 'Kestrel — Extended Pods',
    branch: 'chassis',
    chassis: 'kestrel',
    cost: 700,
    hint: 'Two more rockets per salvo. The Rocketman earns its name.',
    effects: [{ target: WEAPON, id: 'rocketpod', stat: 'salvoCount', op: 'add', value: 2 }],
  },
  kestrel_jets: {
    id: 'kestrel_jets',
    name: 'Kestrel — Tuned Jets',
    branch: 'chassis',
    chassis: 'kestrel',
    cost: 850,
    requires: ['kestrel_pods'],
    hint: 'Jump jets reach 2 cells further and recharge 30% sooner.',
    effects: [
      { target: ABILITY, id: 'jumpjet', stat: 'distance', op: 'add', value: 2 },
      { target: ABILITY, id: 'jumpjet', stat: 'cooldown', op: 'mul', value: 0.7 },
    ],
  },
  vireo_optics: {
    id: 'vireo_optics',
    name: 'Vireo — Long Optics',
    branch: 'chassis',
    chassis: 'vireo',
    cost: 350,
    hint: 'Sees 35% further. Cheap vision is the cheapest advantage in the game.',
    effects: [{ target: UNIT, id: 'vireo', stat: 'sight', op: 'mul', value: 1.35 }],
  },
  vireo_burners: {
    id: 'vireo_burners',
    name: 'Vireo — Burner Tanks',
    branch: 'chassis',
    chassis: 'vireo',
    cost: 450,
    requires: ['vireo_optics'],
    hint: 'Afterburn lasts half again as long.',
    effects: [{ target: ABILITY, id: 'dash', stat: 'duration', op: 'mul', value: 1.5 }],
  },
  ember_lance: {
    id: 'ember_lance',
    name: 'Ember — Overcharged Lances',
    branch: 'chassis',
    chassis: 'ember',
    cost: 800,
    hint: 'Beam lances hit 25% harder.',
    effects: [{ target: WEAPON, id: 'beamlance', stat: 'damage', op: 'mul', value: 1.25 }],
  },
  ember_aegis: {
    id: 'ember_aegis',
    name: 'Ember — Deep Aegis',
    branch: 'chassis',
    chassis: 'ember',
    cost: 900,
    requires: ['ember_lance'],
    hint: 'The Aegis field absorbs 60% more.',
    effects: [{ target: ABILITY, id: 'overshield', stat: 'amount', op: 'mul', value: 1.6 }],
  },
  gale_emp: {
    id: 'gale_emp',
    name: 'Gale — Wide-Band EMP',
    branch: 'chassis',
    chassis: 'gale',
    cost: 750,
    hint: 'EMP Burst covers 30% more ground and holds them 1.5s longer.',
    effects: [
      { target: ABILITY, id: 'empburst', stat: 'radius', op: 'mul', value: 1.3 },
      { target: ABILITY, id: 'empburst', stat: 'disable', op: 'add', value: secs(1.5) },
    ],
  },
  harrier_frame: {
    id: 'harrier_frame',
    name: 'Harrier — Stressed Frame',
    branch: 'chassis',
    chassis: 'harrier',
    cost: 700,
    hint: 'Harriers gain 30% hull and 25% shield. They still die to flak.',
    effects: [
      { target: UNIT, id: 'harrier', stat: 'hp', op: 'mul', value: 1.3 },
      { target: UNIT, id: 'harrier', stat: 'shield', op: 'mul', value: 1.25 },
    ],
  },
};

/** Upgrades grouped for the Hangar screen, in display order. */
export const BRANCHES = [
  { id: 'command', name: 'Command', blurb: 'Army-wide. Expensive, and never wasted.' },
  { id: 'ordnance', name: 'Ordnance', blurb: 'One branch per warhead. Buy what you actually field.' },
  { id: 'logistics', name: 'Logistics', blurb: 'The boring branch that wins campaigns.' },
  { id: 'chassis', name: 'Chassis', blurb: 'Per-machine. These change how a unit plays.' },
];

/** Can this upgrade be bought, given what is already owned? */
export function upgradeAvailable(owned, id) {
  const up = UPGRADES[id];
  if (!up || owned.includes(id)) return false;
  return (up.requires || []).every((r) => owned.includes(r));
}

/* --------------------------------------------------------------- pilots -- */

/**
 * The rocket crew.
 *
 * Pilots are the campaign's throughline: they are named, they persist between
 * missions, they gain levels, and at level 3 each unlocks a signature perk
 * that only applies to the machine they are sitting in. Losing one hurts in a
 * way losing a numbered Kestrel never does — which is the entire point of
 * giving them names.
 */
export const PILOTS = {
  ash: {
    id: 'ash',
    name: 'Vale "Ash" Corrin',
    chassis: 'kestrel',
    blurb:
      'Cracked her canopy on the way down and flew the rest of the drop on instruments. ' +
      'Nobody has told her the Kestrel is not a fighter.',
    perk: {
      name: 'Low Pass',
      hint: 'Jump jets recharge 35% faster.',
      effects: [{ target: ABILITY, id: 'jumpjet', stat: 'cooldown', op: 'mul', value: 0.65 }],
    },
  },
  nim: {
    id: 'nim',
    name: 'Nim',
    chassis: 'vireo',
    blurb:
      'Youngest of the crew and the only one who volunteered. Has not stopped moving since ' +
      'the landing and does not intend to start.',
    perk: {
      name: 'First Look',
      hint: 'Sees 40% further and moves 15% faster.',
      effects: [
        { target: UNIT, id: 'vireo', stat: 'sight', op: 'mul', value: 1.4 },
        { target: UNIT, id: 'vireo', stat: 'speed', op: 'mul', value: 1.15 },
      ],
    },
  },
  box: {
    id: 'box',
    name: 'Bexley "Box" Aduran',
    chassis: 'ember',
    blurb:
      'Twenty years a Bulwark line engineer before he changed his mind about who he worked ' +
      'for. Knows exactly where their armour is thin.',
    perk: {
      name: 'Seam Work',
      hint: 'Beam lances hit 30% harder and the Aegis field lasts 4s longer.',
      effects: [
        { target: WEAPON, id: 'beamlance', stat: 'damage', op: 'mul', value: 1.3 },
        { target: ABILITY, id: 'overshield', stat: 'duration', op: 'add', value: secs(4) },
      ],
    },
  },
  sable: {
    id: 'sable',
    name: 'Sable',
    chassis: 'gale',
    blurb:
      'Signals officer. Has never destroyed a single enemy machine and has personally ' +
      'decided the outcome of four engagements.',
    perk: {
      name: 'Dead Air',
      hint: 'EMP Burst holds them 2s longer and reaches 25% further.',
      effects: [
        { target: ABILITY, id: 'empburst', stat: 'disable', op: 'add', value: secs(2) },
        { target: ABILITY, id: 'empburst', stat: 'radius', op: 'mul', value: 1.25 },
      ],
    },
  },
  wren: {
    id: 'wren',
    name: 'Wren Halloway',
    chassis: 'harrier',
    blurb:
      'Flew the drop ship. There is no drop ship any more, so she flies a Harrier, badly, ' +
      'and with enormous enthusiasm.',
    perk: {
      name: 'Treetop',
      hint: 'Harriers gain 35% hull and 20% speed.',
      effects: [
        { target: UNIT, id: 'harrier', stat: 'hp', op: 'mul', value: 1.35 },
        { target: UNIT, id: 'harrier', stat: 'speed', op: 'mul', value: 1.2 },
      ],
    },
  },
  halcyon: {
    id: 'halcyon',
    name: 'Tamsin "Halcyon" Vey',
    chassis: 'corvid',
    blurb:
      'Spent the descent calmly reading out everyone else\'s altitude. Puts a railspike ' +
      'through a reactor from outside turret range and calls it arithmetic.',
    perk: {
      name: 'Cold Maths',
      hint: 'Railspike reaches 2 cells further and hits 20% harder.',
      effects: [
        { target: WEAPON, id: 'railspike', stat: 'range', op: 'add', value: 2 },
        { target: WEAPON, id: 'railspike', stat: 'damage', op: 'mul', value: 1.2 },
      ],
    },
  },
  roan: {
    id: 'roan',
    name: 'Roan Ijaz',
    chassis: 'cinder',
    blurb:
      'Walked six days out of the crater field dragging a Cinder\'s power core behind him. ' +
      'Does not discuss it. Prefers to be the closest machine to the enemy.',
    perk: {
      name: 'Walk It In',
      hint: 'Thermite splashes 40% wider and the Aegis field is 25% stronger.',
      effects: [
        { target: WEAPON, id: 'thermite', stat: 'splashRadius', op: 'mul', value: 1.4 },
        { target: ABILITY, id: 'overshield', stat: 'amount', op: 'mul', value: 1.25 },
      ],
    },
  },
  ghost: {
    id: 'ghost',
    name: 'Iver "Ghost" Solveig',
    chassis: 'revenant',
    blurb:
      'Listed as lost with the third wave. Came down inside Bulwark lines, spent eleven days ' +
      'there, and walked out driving one of theirs.',
    perk: {
      name: 'Eleven Days',
      hint: 'Arc Projector disables 30% wider and Skyfall recharges 20% faster.',
      effects: [
        { target: WEAPON, id: 'arcprojector', stat: 'splashRadius', op: 'mul', value: 1.3 },
        { target: ABILITY, id: 'skyfall', stat: 'cooldown', op: 'mul', value: 0.8 },
      ],
    },
  },
};

/** XP needed to reach each level. Index 0 is level 1. */
export const XP_CURVE = [0, 400, 1100, 2200, 3800];
export const MAX_PILOT_LEVEL = XP_CURVE.length;

export function levelForXp(xp) {
  let level = 1;
  for (let i = 1; i < XP_CURVE.length; i++) if (xp >= XP_CURVE[i]) level = i + 1;
  return level;
}

export function xpToNextLevel(xp) {
  const level = levelForXp(xp);
  if (level >= MAX_PILOT_LEVEL) return null;
  return { need: XP_CURVE[level] - xp, at: XP_CURVE[level] };
}

/** The level at which a pilot's signature perk comes online. */
export const PERK_LEVEL = 3;

/**
 * Per-level stat growth, applied to whatever chassis the pilot is flying.
 * Modest on purpose — a veteran pilot should be noticeably better, not a
 * different unit, or the campaign stops being about the army you build.
 */
function pilotLevelEffects(pilot, level) {
  const steps = level - 1;
  if (steps <= 0) return [];
  return [
    { target: UNIT, id: pilot.chassis, stat: 'hp', op: 'mul', value: 1 + 0.07 * steps },
    { target: UNIT, id: pilot.chassis, stat: 'shield', op: 'mul', value: 1 + 0.06 * steps },
  ];
}

/** Everything a pilot contributes at a given level: growth plus the perk. */
export function pilotEffects(pilotId, level) {
  const pilot = PILOTS[pilotId];
  if (!pilot) return [];
  const effects = pilotLevelEffects(pilot, level);
  if (level >= PERK_LEVEL) effects.push(...pilot.perk.effects);
  return effects;
}

/* ---------------------------------------------------- table resolution -- */

function cloneTable(table) {
  const out = {};
  for (const [id, def] of Object.entries(table)) out[id] = { ...def };
  return out;
}

/**
 * Weapon stats that live inside nested objects get flat alias names so an
 * effect can address them without the effect system needing to understand the
 * shape of a weapon.
 */
function readStat(def, stat) {
  if (stat === 'salvoCount') return def.salvo ? def.salvo.count : undefined;
  if (stat === 'splashRadius') return def.splash ? def.splash.radius : undefined;
  return def[stat];
}

function writeStat(def, stat, value) {
  if (stat === 'salvoCount') {
    if (def.salvo) def.salvo = { ...def.salvo, count: Math.max(1, Math.round(value)) };
    return;
  }
  if (stat === 'splashRadius') {
    if (def.splash) def.splash = { ...def.splash, radius: value };
    return;
  }
  def[stat] = value;
}

/** Stats that must stay whole numbers of ticks or the sim drifts. */
const INTEGER_STATS = new Set(['cooldown', 'buildTime', 'duration', 'disable', 'distanceTicks']);

/** Does an effect's id selector match this definition? */
function selectorMatches(selector, id, def) {
  if (selector === '*') return true;
  // `explosive:*` — every weapon of that damage type.
  if (selector.endsWith(':*')) return def.type === selector.slice(0, -2);
  return selector === id;
}

function tableFor(tables, target) {
  if (target === UNIT) return tables.units;
  if (target === BUILDING) return tables.buildings;
  if (target === WEAPON) return tables.weapons;
  if (target === ABILITY) return tables.abilities;
  return null;
}

/**
 * Resolve a set of upgrades and pilot effects into concrete stat tables.
 *
 * `add` and `set` run before `mul` so the result depends only on *which*
 * effects are present, never the order they arrived in. Everything is applied
 * to a fresh copy, so the shared content tables are never mutated — a mistake
 * there would leak one player's upgrades into the enemy's units and into every
 * subsequent match in the same page load.
 */
export function resolveDefs({ upgrades = [], pilots = [] } = {}) {
  const tables = {
    units: cloneTable(UNITS),
    buildings: cloneTable(BUILDINGS),
    weapons: cloneTable(WEAPONS),
    abilities: cloneTable(ABILITIES),
  };

  const effects = [];
  for (const id of [...upgrades].sort()) {
    const up = UPGRADES[id];
    if (up) effects.push(...up.effects);
  }
  for (const p of pilots) effects.push(...pilotEffects(p.id, p.level || 1));

  for (const op of ['set', 'add', 'mul']) {
    for (const effect of effects) {
      if (effect.op !== op) continue;
      const table = tableFor(tables, effect.target);
      if (!table) continue;

      for (const [id, def] of Object.entries(table)) {
        if (!selectorMatches(effect.id, id, def)) continue;

        if (op === 'set') {
          writeStat(def, effect.stat, effect.value);
          continue;
        }

        const current = readStat(def, effect.stat);
        if (typeof current !== 'number') continue; // stat absent on this def

        let next = op === 'add' ? current + effect.value : current * effect.value;
        if (INTEGER_STATS.has(effect.stat)) next = Math.max(1, Math.round(next));
        writeStat(def, effect.stat, next);
      }
    }
  }

  // Reactor Shielding removes the detonation rather than editing a nested
  // object, which keeps the effect list flat.
  for (const def of Object.values(tables.buildings)) {
    if (def.noDeathExplosion) delete def.deathExplosion;
  }

  // Hull and shield pools must stay whole numbers so the HUD does not report
  // a mech with 612.4 hull.
  for (const table of [tables.units, tables.buildings]) {
    for (const def of Object.values(table)) {
      if (typeof def.hp === 'number') def.hp = Math.round(def.hp);
      if (typeof def.shield === 'number') def.shield = Math.round(def.shield);
      if (typeof def.capacity === 'number') def.capacity = Math.round(def.capacity);
    }
  }

  return tables;
}

/** The unmodified tables, for players with no progression (skirmish, the AI). */
export function baseDefs() {
  return resolveDefs();
}

/* -------------------------------------------------------------- salvage -- */

/**
 * XP and salvage from a finished mission.
 *
 * Paying partly for kills and partly for completion means a careful player and
 * an aggressive one both progress, which matters when the same campaign has to
 * survive both.
 */
export function missionRewards(mission, stats) {
  const base = mission.reward || 0;
  const killBonus = Math.round((stats.killed || 0) * 25);
  const speedBonus =
    mission.parTime && stats.ticks && stats.ticks < mission.parTime
      ? Math.round(base * 0.25)
      : 0;
  return {
    salvage: base + killBonus + speedBonus,
    xp: Math.round(base * 0.5 + killBonus * 2),
    killBonus,
    speedBonus,
    base,
  };
}
