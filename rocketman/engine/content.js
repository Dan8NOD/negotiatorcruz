/**
 * Rocketman content tables — units, weapons, structures, factions.
 *
 * This file is the design document that the simulation actually executes.
 * Everything here is plain data with no behaviour, so balance changes never
 * require touching sim code, and the whole table can be serialised to JSON and
 * handed to a Swift port unchanged.
 *
 * The two halves of the design meet here:
 *
 *   Red Alert  — a warhead/armour multiplier table, power as a hard economic
 *                gate on production, base building on a grid, two asymmetric
 *                factions with overlapping roles.
 *   War Robots — every combat unit is a piloted mech with named hardpoints, a
 *                regenerating shield layered over hull HP, and one active
 *                ability on a cooldown that the player fires manually.
 *
 * Units are consequently expensive and individually legible: a Rocketman
 * skirmish is closer to twenty mechs that each matter than to two hundred
 * interchangeable riflemen.
 */

/** Simulation rate. Every cooldown, build time and duration below is in ticks. */
export const TICKS_PER_SECOND = 20;

/** Convenience: seconds → ticks, rounded to the nearest whole tick. */
export const secs = (s) => Math.round(s * TICKS_PER_SECOND);

/** World geometry. One cell is the placement unit for structures and pathing. */
export const CELL = 24;

export const ARMOR = {
  LIGHT: 'light',
  MEDIUM: 'medium',
  HEAVY: 'heavy',
  STRUCTURE: 'structure',
};

export const DAMAGE = {
  KINETIC: 'kinetic',
  EXPLOSIVE: 'explosive',
  ENERGY: 'energy',
  EMP: 'emp',
};

/**
 * Warhead × armour, the Red Alert inheritance and the game's whole counter
 * structure. Read a row as "what this damage type does to each armour class".
 *
 *   kinetic   shreds light chassis, embarrasses itself against heavy plate
 *   explosive is the siege answer — mediocre versus fast light units
 *   energy    is the heavy-mech counter, poor against buildings
 *   emp       barely scratches anything; it is here to disable, not to kill
 */
export const DAMAGE_TABLE = {
  [DAMAGE.KINETIC]: { light: 1.0, medium: 0.7, heavy: 0.4, structure: 0.3 },
  [DAMAGE.EXPLOSIVE]: { light: 0.55, medium: 0.9, heavy: 0.85, structure: 1.0 },
  [DAMAGE.ENERGY]: { light: 0.75, medium: 0.85, heavy: 1.0, structure: 0.55 },
  [DAMAGE.EMP]: { light: 0.1, medium: 0.1, heavy: 0.1, structure: 0.15 },
};

/**
 * Shields are the War Robots layer: they soak damage before hull, come back
 * on their own, and stay down for a punishing while once broken. They make
 * hit-and-run viable — disengaging is a real way to heal, so a raid that
 * escapes is worth more than a raid that trades.
 */
export const SHIELD = {
  /** Ticks a unit must go undamaged before regeneration starts. */
  REGEN_DELAY: secs(5),
  /** Extra delay applied when a shield is broken outright rather than dented. */
  BREAK_PENALTY: secs(3),
};

/**
 * Veterancy — straight out of Command & Conquer.
 *
 * A machine that survives gets better at the job. Promotion is earned by
 * destroying enemy value worth a multiple of your own cost, which is C&C's
 * rule and a good one: it scales automatically, so a cheap scout that lives
 * through a whole campaign promotes on merit rather than on luck.
 *
 * This is also the mechanic that makes retreating a damaged veteran worth
 * doing. Losing a rank-2 Kestrel costs more than the 900 scrap on the
 * invoice, and the player can see the chevrons.
 */
export const VETERANCY = [
  { rank: 0, name: 'Green', killValue: 0, damage: 1, cooldown: 1, hull: 1, selfRepair: 0 },
  {
    rank: 1,
    name: 'Veteran',
    /** Destroyed enemy value needed, as a multiple of this unit's own cost. */
    killValue: 3,
    damage: 1.1,
    /** Rate of fire: lower is faster. */
    cooldown: 0.8,
    hull: 1.25,
    selfRepair: 0,
  },
  {
    rank: 2,
    name: 'Elite',
    killValue: 9,
    damage: 1.25,
    cooldown: 0.7,
    hull: 1.5,
    /** Hull points per second. Elites repairing themselves is the C&C rule. */
    selfRepair: 6,
  },
];

/** Selling a structure returns half its cost, scaled by what is left standing. */
export const SELL_REFUND = 0.5;

/**
 * Field repair. A damaged structure can be patched rather than replaced,
 * paying scrap in proportion to the hull restored — cheaper than rebuilding,
 * and the reason a half-dead Refinery is worth defending.
 */
export const REPAIR = {
  /** Fraction of max hull restored per second. */
  RATE: 0.06,
  /** Scrap per hull point, as a fraction of cost-per-hull. */
  COST_RATIO: 0.45,
};

/**
 * Wreck fields slowly recover, the way Red Alert's ore does.
 *
 * Without this a long match ends in a mined-out stalemate where neither side
 * can rebuild and nothing can resolve. Regrowth is slow enough that expanding
 * to a fresh field is still the right move, and fast enough that running out
 * of map is not the way games end.
 */
export const REGROWTH = {
  /** Ticks between regrowth passes. */
  INTERVAL: secs(6),
  /** Scrap added per pass to a cell that still has something in it. */
  AMOUNT: 26,
  /** A depleted cell only comes back if a neighbour survived to seed it. */
  SEED_AMOUNT: 12,
};

/**
 * Weapons. `cooldown` is between shots; a salvo fires `count` projectiles
 * `interval` ticks apart on a single trigger pull, which is what makes rocket
 * mechs feel like rocket mechs rather than machine guns.
 */
export const WEAPONS = {
  autocannon: {
    id: 'autocannon',
    name: 'AC-2 Autocannon',
    damage: 9,
    type: DAMAGE.KINETIC,
    range: 5.5,
    cooldown: secs(0.35),
    projectile: 'tracer',
    speed: 34,
    targets: ['ground', 'air'],
    spread: 0.04,
  },
  rocketpod: {
    id: 'rocketpod',
    name: 'Kestrel Rocket Pod',
    damage: 13,
    type: DAMAGE.EXPLOSIVE,
    range: 7,
    cooldown: secs(2.4),
    projectile: 'rocket',
    speed: 16,
    salvo: { count: 4, interval: 2 },
    splash: { radius: 0.9, falloff: 0.6 },
    targets: ['ground', 'air'],
    spread: 0.1,
  },
  lightrockets: {
    id: 'lightrockets',
    name: 'Sparrow Rockets',
    damage: 9,
    type: DAMAGE.EXPLOSIVE,
    range: 6,
    cooldown: secs(1.8),
    projectile: 'rocket',
    speed: 18,
    salvo: { count: 2, interval: 3 },
    splash: { radius: 0.6, falloff: 0.5 },
    targets: ['ground'],
    spread: 0.08,
  },
  scattergun: {
    id: 'scattergun',
    name: 'Breach Scattergun',
    damage: 26,
    type: DAMAGE.KINETIC,
    range: 3.2,
    cooldown: secs(1.1),
    projectile: 'tracer',
    speed: 30,
    targets: ['ground'],
    spread: 0.12,
  },
  beamlance: {
    id: 'beamlance',
    name: 'Ember Beam Lance',
    damage: 19,
    type: DAMAGE.ENERGY,
    range: 6.2,
    cooldown: secs(0.9),
    projectile: 'beam',
    speed: 0,
    targets: ['ground', 'air'],
    spread: 0,
  },
  siegemortar: {
    id: 'siegemortar',
    name: 'Longbow Mortar',
    damage: 58,
    type: DAMAGE.EXPLOSIVE,
    range: 11,
    /** Deploying trades mobility for reach — see the `siege` ability. */
    deployedRange: 16,
    cooldown: secs(3.6),
    projectile: 'shell',
    speed: 11,
    arcing: true,
    splash: { radius: 1.8, falloff: 0.65 },
    targets: ['ground'],
    minRange: 3,
    spread: 0.35,
  },
  flakburst: {
    id: 'flakburst',
    name: 'Flak Burst',
    damage: 17,
    type: DAMAGE.EXPLOSIVE,
    range: 7.5,
    cooldown: secs(1.2),
    projectile: 'tracer',
    speed: 40,
    splash: { radius: 0.7, falloff: 0.7 },
    targets: ['air'],
    spread: 0.05,
  },
  empprojector: {
    id: 'empprojector',
    name: 'EMP Projector',
    damage: 6,
    type: DAMAGE.EMP,
    range: 5,
    cooldown: secs(2.5),
    projectile: 'beam',
    speed: 0,
    disable: secs(2.5),
    targets: ['ground', 'air'],
    spread: 0,
  },
  turretgun: {
    id: 'turretgun',
    name: 'Emplaced Chaingun',
    damage: 14,
    type: DAMAGE.KINETIC,
    range: 7,
    cooldown: secs(0.5),
    projectile: 'tracer',
    speed: 36,
    targets: ['ground', 'air'],
    spread: 0.03,
  },
};

/**
 * Active abilities. The player fires these by hand — they are the reason a
 * Rocketman engagement rewards attention rather than a-move. Each is a small
 * tagged record; sim/abilities.js is the only place that interprets the tags.
 */
export const ABILITIES = {
  jumpjet: {
    id: 'jumpjet',
    name: 'Jump Jets',
    kind: 'leap',
    /** Cells. Terrain and units are ignored for the duration of the leap. */
    distance: 6.5,
    duration: secs(0.9),
    cooldown: secs(14),
    targeted: true,
    hint: 'Leap over terrain, walls and blockers to a chosen point.',
  },
  dash: {
    id: 'dash',
    name: 'Afterburn',
    kind: 'speed',
    multiplier: 2.1,
    duration: secs(4),
    cooldown: secs(16),
    targeted: false,
    hint: 'Doubles movement speed for four seconds.',
  },
  overshield: {
    id: 'overshield',
    name: 'Aegis Field',
    kind: 'shield',
    /** Flat temporary shield, added over the unit's normal shield pool. */
    amount: 220,
    duration: secs(8),
    cooldown: secs(26),
    targeted: false,
    hint: 'Projects a heavy temporary shield.',
  },
  siege: {
    id: 'siege',
    name: 'Deploy',
    kind: 'toggle',
    /** Toggling costs time in both directions; caught undeployed is death. */
    duration: secs(1.6),
    cooldown: secs(2),
    targeted: false,
    hint: 'Anchor down for maximum range. Cannot move while deployed.',
  },
  repairfield: {
    id: 'repairfield',
    name: 'Field Repair',
    kind: 'heal',
    radius: 4,
    /** Hull points restored per second to every friendly unit in radius. */
    rate: 16,
    duration: secs(6),
    cooldown: secs(22),
    targeted: false,
    hint: 'Repairs nearby friendly mechs for six seconds.',
  },
  empburst: {
    id: 'empburst',
    name: 'EMP Burst',
    kind: 'emp',
    radius: 4.5,
    disable: secs(3.5),
    cooldown: secs(30),
    targeted: true,
    hint: 'Disables enemy weapons and movement in a wide area.',
  },
};

/**
 * Units. `speed` is cells per second; `sight` and weapon ranges are in cells.
 *
 * Hardpoints are cosmetic-plus-mechanical: the array order is the order the
 * renderer draws muzzles, and each entry is an independent weapon with its own
 * cooldown, so a two-hardpoint mech genuinely fires twice as often.
 */
export const UNITS = {
  /* ---- shared economy ------------------------------------------------- */
  collector: {
    id: 'collector',
    name: 'Collector',
    role: 'economy',
    cost: 450,
    buildTime: secs(11),
    hp: 340,
    shield: 0,
    shieldRegen: 0,
    armor: ARMOR.MEDIUM,
    speed: 3.1,
    sight: 5,
    layer: 'ground',
    radius: 0.42,
    hardpoints: [],
    /** Scrap carried before it must return to a drop-off. */
    capacity: 400,
    /** Scrap pulled from a wreck field per second while harvesting. */
    harvestRate: 110,
    tier: 1,
    builtAt: 'refinery',
    hint: 'Unarmed. Pulls scrap from wreck fields and returns it to a refinery.',
  },

  /* ---- Ascendancy: fast, airborne, rocket-heavy ------------------------ */
  vireo: {
    id: 'vireo',
    name: 'Vireo',
    faction: 'ascendancy',
    role: 'scout',
    cost: 300,
    buildTime: secs(7),
    hp: 260,
    shield: 90,
    shieldRegen: 26,
    armor: ARMOR.LIGHT,
    speed: 5.4,
    sight: 9.5,
    layer: 'ground',
    radius: 0.38,
    hardpoints: ['autocannon'],
    ability: 'dash',
    tier: 1,
    builtAt: 'foundry',
    hint: 'Cheap eyes. Outruns everything that can hurt it.',
  },
  kestrel: {
    id: 'kestrel',
    name: 'Kestrel',
    faction: 'ascendancy',
    role: 'assault',
    cost: 900,
    buildTime: secs(15),
    hp: 620,
    shield: 260,
    shieldRegen: 22,
    armor: ARMOR.MEDIUM,
    speed: 3.6,
    sight: 8,
    layer: 'ground',
    radius: 0.46,
    hardpoints: ['rocketpod', 'autocannon'],
    ability: 'jumpjet',
    tier: 1,
    builtAt: 'foundry',
    /** The signature chassis. The game is named after its pilots. */
    signature: true,
    hint: 'The Rocketman. Jump jets carry it over walls and cliffs into a rocket salvo.',
  },
  ember: {
    id: 'ember',
    name: 'Ember',
    faction: 'ascendancy',
    role: 'brawler',
    cost: 1150,
    buildTime: secs(19),
    hp: 900,
    shield: 300,
    shieldRegen: 18,
    armor: ARMOR.HEAVY,
    speed: 2.7,
    sight: 7,
    layer: 'ground',
    radius: 0.55,
    hardpoints: ['beamlance', 'beamlance'],
    ability: 'overshield',
    tier: 2,
    builtAt: 'hangar',
    hint: 'Twin beam lances melt heavy armour. Aegis field buys the seconds it needs.',
  },
  harrier: {
    id: 'harrier',
    name: 'Harrier',
    faction: 'ascendancy',
    role: 'air',
    cost: 1000,
    buildTime: secs(16),
    hp: 400,
    shield: 180,
    shieldRegen: 30,
    armor: ARMOR.LIGHT,
    speed: 6.2,
    sight: 9,
    layer: 'air',
    radius: 0.4,
    hardpoints: ['lightrockets'],
    ability: 'dash',
    tier: 2,
    builtAt: 'hangar',
    hint: 'Ignores terrain entirely. Dies instantly to flak — check before you commit.',
  },
  gale: {
    id: 'gale',
    name: 'Gale',
    faction: 'ascendancy',
    role: 'support',
    cost: 800,
    buildTime: secs(14),
    hp: 420,
    shield: 200,
    shieldRegen: 24,
    armor: ARMOR.LIGHT,
    speed: 3.9,
    sight: 8.5,
    layer: 'ground',
    radius: 0.42,
    hardpoints: ['empprojector'],
    ability: 'empburst',
    tier: 2,
    builtAt: 'hangar',
    hint: 'Kills nothing. Turns an enemy push off for three seconds, which is worse.',
  },

  /* ---- Bulwark: slow, armoured, siege-oriented ------------------------- */
  tick: {
    id: 'tick',
    name: 'Tick',
    faction: 'bulwark',
    role: 'scout',
    cost: 320,
    buildTime: secs(7),
    hp: 330,
    shield: 60,
    shieldRegen: 20,
    armor: ARMOR.LIGHT,
    speed: 4.8,
    sight: 9,
    layer: 'ground',
    radius: 0.38,
    hardpoints: ['scattergun'],
    ability: 'dash',
    tier: 1,
    builtAt: 'foundry',
    hint: 'A scout that actually hurts at knife range.',
  },
  anvil: {
    id: 'anvil',
    name: 'Anvil',
    faction: 'bulwark',
    role: 'assault',
    cost: 950,
    buildTime: secs(16),
    hp: 1050,
    shield: 200,
    shieldRegen: 16,
    armor: ARMOR.HEAVY,
    speed: 2.5,
    sight: 6.5,
    layer: 'ground',
    radius: 0.55,
    hardpoints: ['scattergun', 'scattergun'],
    ability: 'overshield',
    tier: 1,
    builtAt: 'foundry',
    hint: 'Walks forward and does not stop. The problem is arriving at all.',
  },
  longbow: {
    id: 'longbow',
    name: 'Longbow',
    faction: 'bulwark',
    role: 'siege',
    cost: 1300,
    buildTime: secs(22),
    hp: 520,
    shield: 150,
    shieldRegen: 14,
    armor: ARMOR.MEDIUM,
    speed: 2.1,
    sight: 7,
    layer: 'ground',
    radius: 0.5,
    hardpoints: ['siegemortar'],
    ability: 'siege',
    tier: 2,
    builtAt: 'hangar',
    hint: 'Deployed, it outranges every turret in the game. Undeployed, it is scrap.',
  },
  ward: {
    id: 'ward',
    name: 'Ward',
    faction: 'bulwark',
    role: 'support',
    cost: 750,
    buildTime: secs(13),
    hp: 560,
    shield: 120,
    shieldRegen: 18,
    armor: ARMOR.MEDIUM,
    speed: 2.9,
    sight: 7.5,
    layer: 'ground',
    radius: 0.45,
    hardpoints: ['autocannon'],
    ability: 'repairfield',
    tier: 2,
    builtAt: 'hangar',
    hint: 'Field repair turns an even fight into a won one.',
  },
  vulture: {
    id: 'vulture',
    name: 'Vulture',
    faction: 'bulwark',
    role: 'air',
    cost: 1050,
    buildTime: secs(17),
    hp: 480,
    shield: 140,
    shieldRegen: 26,
    armor: ARMOR.LIGHT,
    speed: 5.4,
    sight: 9,
    layer: 'air',
    radius: 0.42,
    hardpoints: ['flakburst', 'lightrockets'],
    tier: 2,
    builtAt: 'hangar',
    hint: 'Air superiority first, ground harassment second.',
  },
};

/**
 * Structures. `size` is in cells and placement is top-left anchored.
 * `power` is positive for generation and negative for draw — see economy.js
 * for what a brownout actually does.
 */
export const BUILDINGS = {
  command: {
    id: 'command',
    name: 'Command Rig',
    cost: 0,
    buildTime: secs(40),
    hp: 2400,
    armor: ARMOR.STRUCTURE,
    size: [3, 3],
    power: 10,
    sight: 9,
    /** The build menu for structures lives on the HQ, Red Alert style. */
    builds: 'buildings',
    /**
     * Also a scrap drop-off, so the opening three Collectors have somewhere to
     * deliver before the first Refinery exists. Without this the first ninety
     * seconds of every match are silent.
     */
    dropOff: true,
    /** Losing every Command Rig is not instantly fatal, but it ends expansion. */
    critical: true,
    hint: 'Constructs every structure and accepts scrap. Protect it.',
  },
  reactor: {
    id: 'reactor',
    name: 'Reactor',
    cost: 350,
    buildTime: secs(12),
    hp: 700,
    armor: ARMOR.STRUCTURE,
    size: [2, 2],
    power: 60,
    sight: 4,
    /** Reactors detonate, which is why nobody sensible clusters them. */
    deathExplosion: { damage: 90, radius: 2.6, type: DAMAGE.EXPLOSIVE },
    hint: 'Generates 60 power. Explodes when destroyed.',
  },
  refinery: {
    id: 'refinery',
    name: 'Refinery',
    cost: 1000,
    buildTime: secs(24),
    hp: 1100,
    armor: ARMOR.STRUCTURE,
    size: [3, 2],
    power: -12,
    sight: 5,
    /**
     * Collectors are built here. Without this the only Collectors in a match
     * are the three you start with and one free per Refinery — a player who
     * loses harvesters to a raid can never replace them, and the economy is
     * quietly un-recoverable.
     */
    builds: 'units',
    /** Ships with a Collector, so the first one pays for itself faster. */
    freeUnit: 'collector',
    dropOff: true,
    hint: 'Builds Collectors and accepts scrap. Arrives with one Collector.',
  },
  foundry: {
    id: 'foundry',
    name: 'Foundry',
    cost: 1000,
    buildTime: secs(20),
    hp: 950,
    armor: ARMOR.STRUCTURE,
    size: [3, 3],
    power: -18,
    sight: 5,
    builds: 'units',
    rally: true,
    hint: 'Produces tier-one chassis.',
  },
  techlab: {
    id: 'techlab',
    name: 'Tech Lab',
    cost: 900,
    buildTime: secs(22),
    hp: 620,
    armor: ARMOR.STRUCTURE,
    size: [2, 2],
    power: -25,
    sight: 5,
    /** Gates every tier-2 chassis and the Hangar itself. */
    unlocksTier: 2,
    hint: 'Unlocks the Hangar and every tier-two chassis.',
  },
  hangar: {
    id: 'hangar',
    name: 'Hangar',
    cost: 1600,
    buildTime: secs(28),
    hp: 1150,
    armor: ARMOR.STRUCTURE,
    size: [3, 3],
    power: -30,
    sight: 5,
    builds: 'units',
    rally: true,
    requires: ['techlab'],
    hint: 'Produces tier-two chassis, including air.',
  },
  lance: {
    id: 'lance',
    name: 'Orbital Lance',
    cost: 3500,
    buildTime: secs(50),
    hp: 900,
    armor: ARMOR.STRUCTURE,
    size: [3, 3],
    power: -60,
    sight: 6,
    requires: ['techlab', 'hangar'],
    /**
     * The Command & Conquer superweapon, and the same bargain: enormous power
     * draw, a charge you watch tick down, and a strike that ends a base. It
     * exists to give a long game somewhere to go other than a stalemate.
     *
     * It needs power, so the counter is the same as everything else in this
     * game — kill their reactors and the doomsday clock stops.
     */
    superweapon: {
      id: 'orbital_lance',
      name: 'Orbital Lance',
      charge: secs(240),
      radius: 5.5,
      damage: 900,
      type: DAMAGE.EXPLOSIVE,
      falloff: 0.35,
      hint: 'Calls a strike anywhere you can see. Four minutes to recharge.',
    },
    needsPower: true,
    hint: 'Superweapon. Enormous power draw, and silent during a brownout.',
  },
  turret: {
    id: 'turret',
    name: 'Turret',
    cost: 600,
    buildTime: secs(10),
    hp: 800,
    armor: ARMOR.STRUCTURE,
    size: [1, 1],
    power: -12,
    sight: 8,
    hardpoints: ['turretgun'],
    /** Unpowered turrets do not fire. Brownouts are a real defensive risk. */
    needsPower: true,
    hint: 'Automated defence. Silent during a brownout.',
  },
  sensor: {
    id: 'sensor',
    name: 'Sensor Mast',
    cost: 350,
    buildTime: secs(9),
    hp: 400,
    armor: ARMOR.STRUCTURE,
    size: [1, 1],
    power: -8,
    sight: 18,
    needsPower: true,
    hint: 'Wide static vision. Cheap, fragile, and worth it.',
  },
};

/** Faction rosters and presentation. */
export const FACTIONS = {
  ascendancy: {
    id: 'ascendancy',
    name: 'Ascendancy',
    blurb:
      'Orbital-drop engineers who never came down. Fast chassis, jump jets, rockets, ' +
      'and a doctrine that treats terrain as a suggestion.',
    color: '#4fb3ff',
    accent: '#a9e2ff',
    units: ['vireo', 'kestrel', 'ember', 'harrier', 'gale'],
    startingUnits: ['kestrel', 'vireo', 'vireo'],
  },
  bulwark: {
    id: 'bulwark',
    name: 'Bulwark',
    blurb:
      'What was left of the ground army, dug in and up-armoured. Slower, heavier, ' +
      'and able to shell your refinery from outside turret range.',
    color: '#ff8a4c',
    accent: '#ffd0ae',
    units: ['tick', 'anvil', 'longbow', 'ward', 'vulture'],
    startingUnits: ['anvil', 'tick', 'tick'],
  },
};

/** Structures every faction can build, in build-bar order. */
export const BUILD_ORDER = [
  'reactor',
  'refinery',
  'foundry',
  'techlab',
  'hangar',
  'turret',
  'sensor',
  'lance',
];

/** Terrain classes. Index into these from the map's terrain array. */
export const TERRAIN = {
  GROUND: 0,
  ROUGH: 1,
  CLIFF: 2,
  WATER: 3,
};

/** Movement cost per terrain, and whether ground units may enter at all. */
export const TERRAIN_INFO = [
  { id: 'ground', passable: true, cost: 1.0, color: '#2b3440' },
  { id: 'rough', passable: true, cost: 1.7, color: '#39424e' },
  { id: 'cliff', passable: false, cost: Infinity, color: '#161b22' },
  { id: 'water', passable: false, cost: Infinity, color: '#16303f' },
];

/** Starting economy, shared by both factions. */
export const START = {
  scrap: 4000,
  /** Collectors that arrive with the initial Command Rig. */
  collectors: 3,
};

/** Look up a unit or building definition by id, whichever table holds it. */
export function defOf(id) {
  return UNITS[id] || BUILDINGS[id] || null;
}

/** Damage multiplier for a warhead against an armour class. */
export function damageMultiplier(damageType, armorClass) {
  const row = DAMAGE_TABLE[damageType];
  if (!row) return 1;
  const m = row[armorClass];
  return m === undefined ? 1 : m;
}
