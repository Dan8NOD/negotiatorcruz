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
  /* ---- the drop's salvaged and stolen hardware ------------------------ */

  railspike: {
    id: 'railspike',
    name: 'Railspike',
    damage: 54,
    type: DAMAGE.ENERGY,
    range: 11.5,
    cooldown: secs(3.4),
    projectile: 'shell',
    speed: 70,
    /** Cannot depress onto anything already standing on top of it. */
    minRange: 3,
    targets: ['ground', 'air'],
    spread: 0.015,
  },
  stormrepeater: {
    id: 'stormrepeater',
    name: 'Storm Repeater',
    damage: 6,
    type: DAMAGE.KINETIC,
    range: 4.6,
    cooldown: secs(0.15),
    projectile: 'tracer',
    speed: 40,
    targets: ['ground', 'air'],
    spread: 0.1,
  },
  thermite: {
    id: 'thermite',
    name: 'Thermite Launcher',
    damage: 38,
    type: DAMAGE.EXPLOSIVE,
    range: 6.4,
    cooldown: secs(3),
    projectile: 'rocket',
    speed: 13,
    splash: { radius: 1.9, falloff: 0.45 },
    targets: ['ground'],
    spread: 0.12,
  },
  arcprojector: {
    id: 'arcprojector',
    name: 'Arc Projector',
    damage: 6,
    type: DAMAGE.EMP,
    range: 5.6,
    cooldown: secs(1.5),
    projectile: 'beam',
    speed: 0,
    splash: { radius: 2.2, falloff: 0.8 },
    targets: ['ground', 'air'],
    spread: 0,
  },
  talon: {
    id: 'talon',
    name: 'Talon Missiles',
    damage: 24,
    type: DAMAGE.EXPLOSIVE,
    range: 9,
    cooldown: secs(1.7),
    projectile: 'rocket',
    speed: 28,
    salvo: { count: 2, interval: 3 },
    splash: { radius: 0.7, falloff: 0.5 },
    targets: ['ground', 'air'],
    spread: 0.05,
  },

  /* ---- the Robot Marine's hardpoints ---------------------------------- */

  /**
   * The gate gun. Enormous single shells on a long cycle, which is what makes
   * the Robot Marine a fight with a *rhythm*: you have two seconds between
   * rounds to be somewhere else, and standing still through one is how the
   * challenge ends early.
   */
  bastioncannon: {
    id: 'bastioncannon',
    name: 'Bastion Cannon',
    damage: 78,
    type: DAMAGE.EXPLOSIVE,
    range: 8.5,
    cooldown: secs(2.6),
    projectile: 'shell',
    speed: 20,
    splash: { radius: 1.8, falloff: 0.55 },
    targets: ['ground', 'air'],
    spread: 0.07,
  },
  /**
   * And the reason you cannot simply walk up to it. Short, fast and kinetic:
   * the cannon punishes standing in the open, this punishes closing.
   */
  wardrepeater: {
    id: 'wardrepeater',
    name: 'Ward Repeater',
    damage: 15,
    type: DAMAGE.KINETIC,
    range: 4.8,
    cooldown: secs(0.28),
    projectile: 'tracer',
    speed: 36,
    targets: ['ground', 'air'],
    spread: 0.06,
  },
};

/**
 * Active abilities. The player fires these by hand — they are the reason a
 * Rocketman engagement rewards attention rather than a-move. Each is a small
 * tagged record; sim/abilities.js is the only place that interprets the tags.
 */
/** The ability every named pilot carries, on top of their chassis ability. */
export const HERO_ABILITY = 'skyfall';

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
  /**
   * The crew ability. Every named pilot carries it in a second slot, on top
   * of whatever their chassis already mounts.
   *
   * Half the map on a fifteen-second cooldown is an enormous amount of reach,
   * and that is the point: a handful of machines that can be anywhere is the
   * premise of *Just You and Your Rocket Crew*. It is also exactly why it is
   * hero-only — the same range on a buildable chassis would make defending
   * anything meaningless, and the AI cannot field heroes at all.
   */
  skyfall: {
    id: 'skyfall',
    name: 'Skyfall',
    kind: 'leap',
    /** Cells. Half a standard 72-cell map. */
    distance: 36,
    duration: secs(1.5),
    cooldown: secs(15),
    targeted: true,
    /** Mounted in the hero slot only, never by a chassis definition. */
    heroOnly: true,
    hint: 'Burn the drop pod reserve and cross half the battlefield. 15s.',
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
  /* ---- hero chassis: unique machines, never trained ------------------- */

  corvid: {
    id: 'corvid',
    name: 'Corvid',
    faction: 'ascendancy',
    role: 'siege',
    cost: 1400,
    buildTime: secs(20),
    hp: 520,
    shield: 240,
    shieldRegen: 20,
    armor: ARMOR.LIGHT,
    speed: 3.4,
    sight: 12,
    layer: 'ground',
    radius: 0.44,
    hardpoints: ['railspike'],
    ability: 'dash',
    tier: 2,
    /** No `builtAt`: hero chassis are placed by the campaign, never built.
     *  Keeping them off both faction rosters also keeps the AI's options —
     *  and therefore the faction balance the tests pin — exactly as they were. */
    heroOnly: true,
    hint: 'A rail gun on legs. Outranges every turret and hates being closed on.',
  },
  cinder: {
    id: 'cinder',
    name: 'Cinder',
    faction: 'ascendancy',
    role: 'brawler',
    cost: 1300,
    buildTime: secs(19),
    hp: 900,
    shield: 200,
    shieldRegen: 18,
    armor: ARMOR.HEAVY,
    speed: 3.2,
    sight: 7.5,
    layer: 'ground',
    radius: 0.52,
    hardpoints: ['stormrepeater', 'thermite'],
    ability: 'overshield',
    tier: 2,
    heroOnly: true,
    hint: 'Walks in and burns everything at arm’s length. Shreds light, melts structures.',
  },
  revenant: {
    id: 'revenant',
    name: 'Revenant',
    faction: 'bulwark',
    role: 'support',
    cost: 1500,
    buildTime: secs(22),
    hp: 760,
    shield: 300,
    shieldRegen: 24,
    armor: ARMOR.MEDIUM,
    speed: 3.5,
    sight: 9,
    layer: 'ground',
    radius: 0.48,
    hardpoints: ['arcprojector', 'talon'],
    ability: 'empburst',
    tier: 2,
    heroOnly: true,
    hint: 'Bulwark hardware, repainted badly. Disables what it cannot kill.',
  },

  /* ---- the gate guard: placed by a challenge, never trained ----------- */

  /**
   * The Robot Marine.
   *
   * A door guard, and built like one. It does not raid, it does not expand
   * and it never leaves the ground it is standing on — the whole machine is a
   * single question: can this crew kill a thing with four thousand hull and a
   * fourteen-hundred-point shield before it kills them?
   *
   * Deliberately not a bigger Anvil. An Anvil is beaten by trading; the Marine
   * regenerates its shield fast enough that trading loses, so the answer is
   * *focus* — everything on it at once, and use the two-second cannon cycle to
   * be somewhere else in between. That is a different fight from anything in
   * the campaign, which is why it is the thing standing between the player and
   * a door rather than another wave of Ticks.
   *
   * Off both faction rosters and with no `builtAt`, so the AI's production
   * options — and therefore the faction balance the suite pins — are untouched.
   */
  marine: {
    id: 'marine',
    name: 'Robot Marine',
    faction: 'bulwark',
    role: 'guardian',
    cost: 3400,
    buildTime: secs(45),
    hp: 4200,
    shield: 1400,
    /** Fast enough that chip damage is wasted and only a focused push works. */
    shieldRegen: 46,
    armor: ARMOR.HEAVY,
    /** Slow. It is not chasing anybody; it is standing in a doorway. */
    speed: 1.9,
    sight: 11,
    layer: 'ground',
    radius: 0.95,
    hardpoints: ['bastioncannon', 'wardrepeater'],
    ability: 'empburst',
    tier: 3,
    heroOnly: true,
    /** Marks a machine a challenge places at a landmark. See gateways.js. */
    guardian: true,
    hint: 'Four storeys of door guard. Kill it and the door it is standing in front of opens.',
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
/**
 * Terrain props — the world itself, and it can be knocked down.
 *
 * These are neutral entities (`player: -1`) rather than a separate layer, so
 * they inherit the damage pipeline, the spatial index and splash for free.
 * They also claim grid cells the way structures do, which means two things
 * that are really one thing: A* routes around them, and *destroying one opens
 * a path*. Blowing a hole through a housing block to shortcut a siege is the
 * best thing in this file.
 *
 * `height` is presentation only — how far the roof is offset from the
 * footprint to fake elevation — but it lives here rather than in the renderer
 * because a two-storey house and a radio mast are a design decision, not a
 * drawing one.
 */
export const PROPS = {
  tower: {
    id: 'tower',
    name: 'Tower Block',
    size: [2, 2],
    hp: 1600,
    armor: ARMOR.STRUCTURE,
    height: 3.4,
    storeys: 9,
    hint: 'Nine storeys of pre-war housing. Falls hard.',
  },
  house: {
    id: 'house',
    name: 'House',
    size: [1, 1],
    hp: 420,
    armor: ARMOR.STRUCTURE,
    height: 0.9,
    storeys: 2,
    hint: 'Somebody lived here.',
  },
  gasstation: {
    id: 'gasstation',
    name: 'Fuel Station',
    size: [2, 1],
    hp: 220,
    /**
     * Structure rather than light: explosive multiplies against structure in
     * full, and a fuel station that cannot set off the one next to it is not
     * a fuel station. The trade is that small-arms fire barely scratches it —
     * you pop these with rockets, which is the right answer anyway.
     */
    armor: ARMOR.STRUCTURE,
    height: 0.8,
    volatile: true,
    /**
     * The reason to care where you fight. Cheap hull, enormous blast — and
     * because splash damages everything in radius including other props, a
     * forecourt full of them goes up in a chain.
     */
    deathExplosion: { radius: 4.6, damage: 300, type: DAMAGE.EXPLOSIVE },
    hint: 'Do not fight next to this. Do make the enemy fight next to it.',
  },
  tree: {
    id: 'tree',
    name: 'Ironwood',
    size: [1, 1],
    hp: 200,
    armor: ARMOR.LIGHT,
    height: 1.7,
    canopy: true,
    hint: 'Old growth. Blocks a mech, not a rocket.',
  },
  statue: {
    id: 'statue',
    name: 'Monument',
    size: [1, 1],
    hp: 2400,
    armor: ARMOR.STRUCTURE,
    height: 2.8,
    hint: 'Whoever it was, both sides have stopped saluting it.',
  },
  tank: {
    id: 'tank',
    name: 'Fuel Tank',
    size: [1, 1],
    hp: 200,
    armor: ARMOR.STRUCTURE,
    height: 1.3,
    volatile: true,
    deathExplosion: { radius: 3.4, damage: 210, type: DAMAGE.EXPLOSIVE },
    hint: 'Industrial storage. Still full.',
  },

  /* ---- the second wave: enough variety that a district reads as a place -- */

  apartment: {
    id: 'apartment',
    name: 'Apartment Block',
    size: [2, 3],
    hp: 1100,
    armor: ARMOR.STRUCTURE,
    height: 2.4,
    storeys: 6,
    hint: 'Six floors of balconies. Good cover until it is not.',
  },
  warehouse: {
    id: 'warehouse',
    name: 'Warehouse',
    size: [3, 2],
    hp: 900,
    armor: ARMOR.STRUCTURE,
    height: 1.1,
    storeys: 1,
    /** A long blank shed. Wide enough to break a firing line in half. */
    hint: 'Whatever was stored here left in a hurry.',
  },
  chapel: {
    id: 'chapel',
    name: 'Chapel',
    size: [2, 2],
    hp: 780,
    armor: ARMOR.STRUCTURE,
    height: 1.6,
    storeys: 2,
    spire: true,
    hint: 'The steeple is the tallest thing for three blocks. Snipers know.',
  },
  watertower: {
    id: 'watertower',
    name: 'Water Tower',
    size: [2, 2],
    hp: 520,
    armor: ARMOR.STRUCTURE,
    height: 3.1,
    shape: 'watertower',
    hint: 'Legs, a tank, and a very long way to fall.',
  },
  mast: {
    id: 'mast',
    name: 'Relay Mast',
    size: [1, 1],
    hp: 300,
    /**
     * Light rather than structure: it is a lattice, and lattices come down to
     * autocannon fire in a way concrete does not.
     */
    armor: ARMOR.LIGHT,
    height: 4.2,
    shape: 'mast',
    hint: 'Still transmitting. Nobody is listening.',
  },
  billboard: {
    id: 'billboard',
    name: 'Billboard',
    size: [2, 1],
    hp: 180,
    armor: ARMOR.LIGHT,
    height: 1.9,
    shape: 'billboard',
    hint: 'Advertising something that no longer exists.',
  },
  silo: {
    id: 'silo',
    name: 'Grain Silo',
    size: [2, 2],
    hp: 340,
    armor: ARMOR.STRUCTURE,
    height: 2.6,
    shape: 'silo',
    volatile: true,
    /**
     * Grain dust, not fuel — a wider, softer blast than a tank. Real ones do
     * exactly this, and it gives the farm district a hazard of its own
     * rather than importing the fuel station's.
     */
    deathExplosion: { radius: 5.2, damage: 180, type: DAMAGE.EXPLOSIVE },
    hint: 'Full of dust. Dust burns faster than fuel.',
  },
  depot: {
    id: 'depot',
    name: 'Propane Depot',
    size: [2, 2],
    hp: 420,
    armor: ARMOR.STRUCTURE,
    height: 1.2,
    shape: 'depot',
    volatile: true,
    /** The biggest hazard on the map, and the one worth manoeuvring around. */
    deathExplosion: { radius: 6.4, damage: 420, type: DAMAGE.EXPLOSIVE },
    hint: 'Bank of cylinders behind a wire fence. Do not.',
  },
  bus: {
    id: 'bus',
    name: 'Wrecked Bus',
    size: [2, 1],
    hp: 240,
    armor: ARMOR.MEDIUM,
    height: 0.7,
    shape: 'vehicle',
    volatile: true,
    deathExplosion: { radius: 2.4, damage: 120, type: DAMAGE.EXPLOSIVE },
    hint: 'Abandoned across two lanes. Still has a tank in it.',
  },
  fountain: {
    id: 'fountain',
    name: 'Fountain',
    size: [2, 2],
    hp: 640,
    armor: ARMOR.STRUCTURE,
    height: 0.6,
    shape: 'fountain',
    hint: 'Dry since the evacuation.',
  },
  pine: {
    id: 'pine',
    name: 'Blackpine',
    size: [1, 1],
    hp: 170,
    armor: ARMOR.LIGHT,
    height: 2.3,
    canopy: true,
    conifer: true,
    hint: 'Taller than the ironwoods, and thinner.',
  },
  hedge: {
    id: 'hedge',
    name: 'Hedgerow',
    size: [2, 1],
    hp: 120,
    armor: ARMOR.LIGHT,
    height: 0.6,
    canopy: true,
    low: true,
    hint: 'Waist-high. Blocks a walker, hides nothing from the air.',
  },

  /* ---- the rail yard, the farm and the quarry ------------------------- */

  /**
   * Rolling stock, standing where it was left.
   *
   * A yard is three or four sidings running the same way with wagons parked
   * along them, and that is the whole reason it is a good place to fight: the
   * tracks are the fastest ground in the district and the wagons are hard
   * cover *across* them, so every siding is a firing lane with a door in it.
   *
   * Medium armour rather than structure — a steel box on bogies is not a
   * building, and it should fold to autocannon rather than needing a rocket.
   */
  boxcar: {
    id: 'boxcar',
    name: 'Box Wagon',
    size: [3, 1],
    hp: 300,
    armor: ARMOR.MEDIUM,
    height: 1.1,
    shape: 'railcar',
    hint: 'Loaded, sealed, and going nowhere.',
  },
  tanker: {
    id: 'tanker',
    name: 'Tank Wagon',
    size: [3, 1],
    hp: 210,
    /** Structure, for the same reason the fuel station is: see `gasstation`. */
    armor: ARMOR.STRUCTURE,
    height: 1.2,
    shape: 'railcar',
    volatile: true,
    /**
     * A long thin blast rather than the depot's fat one, and the reason a yard
     * is not simply a safer industrial estate: the wagons are strung out along
     * the sidings, so one going up takes the *lane* rather than the block.
     */
    deathExplosion: { radius: 4.4, damage: 250, type: DAMAGE.EXPLOSIVE },
    hint: 'Nobody wrote on it what is inside. It does not matter.',
  },
  signal: {
    id: 'signal',
    name: 'Signal Gantry',
    size: [1, 1],
    hp: 220,
    /** A lattice, like the relay mast, and it comes down like one. */
    armor: ARMOR.LIGHT,
    height: 3.0,
    shape: 'signal',
    hint: 'Still showing a clear road for a train that is not coming.',
  },
  barn: {
    id: 'barn',
    name: 'Barn',
    size: [3, 2],
    hp: 620,
    armor: ARMOR.STRUCTURE,
    height: 1.7,
    storeys: 1,
    shape: 'barn',
    hint: 'Big doors, empty inside, and one wall you can walk through.',
  },
  windpump: {
    id: 'windpump',
    name: 'Wind Pump',
    size: [1, 1],
    hp: 190,
    armor: ARMOR.LIGHT,
    height: 3.4,
    shape: 'windpump',
    hint: 'Still turning. It is the only thing out here that is.',
  },
  crusher: {
    id: 'crusher',
    name: 'Rock Crusher',
    size: [3, 3],
    hp: 1500,
    armor: ARMOR.STRUCTURE,
    height: 2.2,
    shape: 'crusher',
    hint: 'Hopper, jaw and a conveyor to nowhere. Solid all the way down.',
  },

  /**
   * The thing somebody built at the chokepoint, before all this.
   *
   * A pass or a bridgehead is worth holding whether or not anything stands on
   * it, but a player has to be able to *see* that it is worth holding, and a
   * pair of blockhouses either side of the road says so from across the map.
   * Cheap to draw, low enough not to hide what is behind it, and tough enough
   * that clearing one is a decision rather than a formality.
   */
  bunker: {
    id: 'bunker',
    name: 'Blockhouse',
    size: [2, 2],
    hp: 1100,
    armor: ARMOR.STRUCTURE,
    height: 0.9,
    shape: 'bunker',
    hint: 'Somebody held this once. There is a firing slit and no door.',
  },

  /* ---- landmarks: one to a map, and the reason the map exists ---------- */

  /**
   * The Bulwark headquarters, and the first of the two challenge landmarks.
   *
   * Ordinary scenery is something you fight *around*. A landmark is something
   * you fight *for*, which is why this one is four times the hull of a tower
   * block and sits on a footprint you can see from the minimap.
   *
   * What makes it a challenge rather than a big house is what is underneath
   * it: the headquarters was built over the shaft, and knocking it down is
   * the only way to uncover the entrance. The gateway that appears is mission
   * data, not a property of this record — see `gateways.js` — so the same
   * landmark can anchor a different secret on a different map.
   */
  headquarters: {
    id: 'headquarters',
    name: 'Bulwark Headquarters',
    size: [4, 4],
    hp: 6400,
    armor: ARMOR.STRUCTURE,
    height: 4.6,
    storeys: 12,
    shape: 'headquarters',
    landmark: true,
    hint: 'Eight years of occupation, administered from here. Built over something older.',
  },

  /**
   * The castle, and the second landmark. Unlike the headquarters this one is
   * **indestructible**, which is a deliberate exception to "the map is
   * destructible" and worth stating plainly:
   *
   * The challenge is the door. A castle you can demolish makes the Robot
   * Marine optional — walk round the back, put four rockets through the wall,
   * and the guard you were supposed to beat is a thing you ignored. Every
   * version of this that stayed destructible ended the same way, so the wall
   * is the boundary of the puzzle and the gate is the answer to it.
   *
   * It still takes hits, still shows damage, still blocks line of sight and
   * still claims its cells. It simply does not fall.
   */
  castle: {
    id: 'castle',
    name: 'The Bastion',
    size: [6, 6],
    hp: 12000,
    armor: ARMOR.STRUCTURE,
    height: 5.4,
    storeys: 5,
    shape: 'castle',
    landmark: true,
    indestructible: true,
    /**
     * Where the great door sits, as an offset from the footprint's top-left.
     * The renderer draws the door here and the gateway opens here, so the two
     * can never disagree about which wall the way in is.
     */
    door: [2, 6],
    hint: 'Curtain wall, four towers, and one door that has not opened in eight years.',
  },

  /* ---- underworld scenery: the cavern and the keep --------------------- */

  pillar: {
    id: 'pillar',
    name: 'Rock Pillar',
    size: [2, 2],
    hp: 1400,
    armor: ARMOR.STRUCTURE,
    height: 4.4,
    shape: 'pillar',
    hint: 'Floor to roof. Whatever is above is resting on these.',
  },
  crystal: {
    id: 'crystal',
    name: 'Firestone',
    size: [1, 1],
    hp: 240,
    armor: ARMOR.LIGHT,
    height: 2.1,
    shape: 'crystal',
    volatile: true,
    /**
     * The cavern's answer to the fuel station. Energy rather than explosive,
     * because down here the hazard should read as *the place* rather than as
     * a petrol station somebody buried.
     */
    deathExplosion: { radius: 4.0, damage: 260, type: DAMAGE.ENERGY },
    hint: 'It glows because it is under pressure. Do not relieve the pressure.',
  },
  rubble: {
    id: 'rubble',
    name: 'Rockfall',
    size: [2, 1],
    hp: 380,
    armor: ARMOR.STRUCTURE,
    height: 0.7,
    shape: 'rubble',
    hint: 'The roof came down here once already.',
  },
  brazier: {
    id: 'brazier',
    name: 'Brazier',
    size: [1, 1],
    hp: 160,
    armor: ARMOR.LIGHT,
    height: 1.4,
    shape: 'brazier',
    volatile: true,
    deathExplosion: { radius: 2.0, damage: 90, type: DAMAGE.EXPLOSIVE },
    hint: 'Still lit. Somebody is still lighting them.',
  },
};

/** Props are neutral: owned by nobody, hostile to nobody, in everybody's way. */
export const NEUTRAL_PLAYER = -1;

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

/**
 * Build hotkeys — letters, not digits.
 *
 * Digits used to build, which put them in a fight they could not win: every
 * game these controls are modelled on binds 1–9 to *control groups*, so the
 * digit that placed a Reactor on minute one silently stopped doing so the
 * moment the player assigned a group to it. One key, two meanings, and which
 * one you got depended on something you did ten minutes ago.
 *
 * Letters are what Age of Empires and StarCraft use for construction anyway,
 * chosen the same way they choose them: the first letter of the name that is
 * not already spoken for. R-eactor, refI-nery, fO-undry, T-ech Lab,
 * ha-N-gar, t-U-rret, sensor M-ast, orbital L-ance.
 *
 * They only fire while something that can build is selected, so they cost
 * nothing the rest of the time.
 */
export const BUILD_HOTKEYS = {
  reactor: 'r',
  refinery: 'i',
  foundry: 'o',
  techlab: 't',
  hangar: 'n',
  turret: 'u',
  sensor: 'm',
  lance: 'l',
};

/** Terrain classes. Index into these from the map's terrain array. */
export const TERRAIN = {
  GROUND: 0,
  ROUGH: 1,
  CLIFF: 2,
  WATER: 3,
  /**
   * Tarmac. Appended rather than inserted: the renderer and the Swift port
   * both read these as raw indices, and renumbering GROUND out from under
   * them would be a silent, map-wide corruption.
   */
  ROAD: 4,
};

/**
 * Movement cost per terrain, and whether ground units may enter at all.
 *
 * Road is the only cost below 1, and it is what makes the road network a
 * decision rather than decoration: the fast route across a doubled map runs
 * through the built-up ground where the buildings — and the fuel stations —
 * are. Taking the long way round open country is *safe*, and slow. That
 * trade is the whole reason the districts are connected at all.
 */
export const TERRAIN_INFO = [
  { id: 'ground', passable: true, cost: 1.0, color: '#2b3440' },
  { id: 'rough', passable: true, cost: 1.7, color: '#39424e' },
  { id: 'cliff', passable: false, cost: Infinity, color: '#161b22' },
  { id: 'water', passable: false, cost: Infinity, color: '#16303f' },
  { id: 'road', passable: true, cost: 0.72, color: '#31353c' },
];

/**
 * The cheapest step any ground unit can take.
 *
 * A* needs a heuristic that never *over*-estimates the remaining cost, or it
 * stops returning shortest paths. Octile distance assumes one unit of cost
 * per step, which was true while the cheapest terrain cost exactly 1 — roads
 * made it false, and an inadmissible heuristic would have quietly routed
 * units around the road network they were built to use. Scaling the estimate
 * by this restores the guarantee.
 */
export const MIN_TERRAIN_COST = TERRAIN_INFO.reduce(
  (min, t) => (t.passable && t.cost < min ? t.cost : min),
  Infinity
);

/**
 * Biomes — what a world is made of.
 *
 * The five terrain indices never change meaning: 0 is the floor you walk on,
 * 1 is the slow floor, 2 is the wall you cannot pass, 3 is the hole you cannot
 * cross, 4 is the fast lane. A biome only changes what those five *are* — the
 * generator that arranges them, the scenery scattered over them, and the
 * colours they are painted in.
 *
 * Doing it this way rather than adding terrain classes is what keeps the
 * underworld free: pathfinding, vision, the Swift port and every saved replay
 * read raw indices, and renumbering them out from under those would be a
 * silent, map-wide corruption for one new colour of rock.
 *
 * `palette` is the *base* tone per terrain, before the renderer's noise and
 * per-cell detail. The surface values are the literals the renderer used
 * before biomes existed, so a surface map paints byte-for-byte as it did.
 */
export const BIOMES = {
  surface: {
    id: 'surface',
    name: 'Surface',
    generator: 'surface',
    palette: {
      ground: [40, 46, 53],
      cliff: [24, 28, 33],
      water: [16, 40, 58],
      road: [44, 46, 50],
      lit: 'rgba(160, 175, 190, 0.22)',
      glint: 'rgba(140, 190, 220, 0.07)',
      /** The centre line down a straight run of the fast ground. */
      dash: 'rgba(214, 198, 120, 0.20)',
      minimap: TERRAIN_INFO.map((t) => t.color),
    },
  },

  /**
   * Under the headquarters. Chambers cut out of solid rock, joined by
   * tunnels, lit by whatever is growing in the walls — the map is the
   * negative space rather than the obstacles, which is why it needs its own
   * generator rather than a recoloured surface.
   */
  cavern: {
    id: 'cavern',
    name: 'The Undercroft',
    generator: 'chambers',
    /** Cut rock. Wide enough for a firing line, narrow enough to hold. */
    corridor: 3,
    chamberRadius: [5, 9],
    /** Scenery, rolled per chamber. */
    scenery: ['pillar', 'crystal', 'rubble'],
    /** Chance a given scenery roll is the volatile one. */
    hazard: 'crystal',
    palette: {
      // Cut rock reads as *cut* only if the floor is clearly lighter than the
      // wall. The first pass sat both in the high thirties and the chambers
      // dissolved into the rock at any zoom — down here the terrain is the
      // whole map, so this contrast is load-bearing rather than decorative.
      ground: [48, 42, 55],
      cliff: [15, 12, 19],
      water: [8, 7, 13],
      road: [60, 52, 58],
      lit: 'rgba(196, 130, 210, 0.20)',
      glint: 'rgba(210, 140, 240, 0.10)',
      dash: 'rgba(198, 146, 226, 0.11)',
      minimap: ['#2a2530', '#342c38', '#12101a', '#0a0910', '#3b3338'],
    },
  },

  /**
   * Behind the castle door. The same chamber generator — a keep interior *is*
   * rooms joined by corridors — with masonry for walls, flagstone for the
   * fast ground, and a moat you still cannot cross.
   */
  keep: {
    id: 'keep',
    name: 'The Iron Keep',
    generator: 'chambers',
    corridor: 2,
    chamberRadius: [4, 8],
    scenery: ['statue', 'brazier', 'rubble'],
    hazard: 'brazier',
    palette: {
      ground: [56, 51, 45],
      cliff: [24, 22, 20],
      water: [16, 30, 42],
      road: [70, 63, 55],
      lit: 'rgba(214, 186, 130, 0.24)',
      glint: 'rgba(150, 195, 225, 0.08)',
      dash: 'rgba(222, 196, 146, 0.13)',
      minimap: ['#3a352f', '#443d35', '#1d1b19', '#122029', '#4a443b'],
    },
  },
};

export const DEFAULT_BIOME = 'surface';

/** The biome record for a map, falling back to the surface for old saves. */
export function biomeOf(map) {
  return BIOMES[(map && map.biome) || DEFAULT_BIOME] || BIOMES[DEFAULT_BIOME];
}

/**
 * Gateway kinds — the two ways off a map.
 *
 * A gateway is not scenery and not a structure: it is a *way out*, and the
 * only thing the simulation does with one is notice that it opened and notice
 * that somebody walked into it. Everything else about it — what unlocks it,
 * where it goes — is mission data. See `engine/gateways.js`.
 */
export const GATEWAY_KINDS = {
  /** A hole in the ground, uncovered by knocking down what was built on it. */
  shaft: {
    id: 'shaft',
    name: 'Shaft',
    verb: 'Descend',
    /** How close a machine has to get to be counted as having gone in. */
    radius: 1.7,
    sealed: 'Something is buried here.',
    opened: 'The floor has given way. There is a way down.',
  },
  /** A door in a wall, opened by killing what is standing in front of it. */
  gate: {
    id: 'gate',
    name: 'Gate',
    verb: 'Enter',
    radius: 2.0,
    sealed: 'Barred from the inside.',
    opened: 'The great door is open.',
  },
};

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
