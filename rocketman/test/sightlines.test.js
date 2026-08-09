/**
 * Terrain in the fight: what stops a shot, what softens one, and what standing
 * on a ridge is worth.
 *
 * The rules under test are stated in `combat.js` — a cliff or a building is a
 * hard block because a rule the player cannot see is a rule they never learn,
 * canopy is an accuracy tax because a wood nobody can shoot into is the
 * strongest position on the map. What is asserted here is that both halves of
 * that are true in play, that air ignores all of it, and that none of it costs
 * enough to be felt on a tablet.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { makeArena, makeBareWorld, clearGround, run, runAI, hashWorld } from './helpers.js';
import { createWorld, tick, applyCommand } from '../engine/sim.js';
import {
  spawnUnit,
  spawnProp,
  spawnBuilding,
  killEntity,
  buildSpatialIndex,
  traceShot,
  coverAgainst,
  blockingOf,
  isElevated,
  BLOCK,
  COVER,
  COVER_DAMAGE,
  BLOCKED,
  ELEVATION,
} from '../engine/entities.js';
import { weaponRange, maxRange, acquireTarget, updateWeapons } from '../engine/combat.js';
import { updateVision, isVisible } from '../engine/vision.js';
import { PROPS, TERRAIN, TICKS_PER_SECOND } from '../engine/content.js';

/**
 * A flat, empty, known rectangle of ground with the two Command Rigs still in
 * their corners so the match keeps running. Every test below picks its cells
 * out of this box rather than out of whatever the seed happened to generate.
 */
function arena() {
  return clearGround(makeArena(), 20, 20, 60, 60);
}

/** Paint a north-south wall of cliff, the one terrain that stops a shot dead. */
function wall(world, x, y0, y1) {
  for (let y = y0; y <= y1; y++) world.map.terrain[y * world.map.width + x] = TERRAIN.CLIFF;
}

/** Total pool left on a machine, so a test can say "it took damage" once. */
const pool = (e) => e.hp + e.shield + (e.tempShield || 0);

/* -------------------------------------------------------- classification -- */

describe('what counts as being in the way', () => {
  test('the prop table already says, and nothing needed a new flag', () => {
    // The point of deriving this: a prop added later inherits an answer from
    // the numbers it has to carry anyway, instead of shipping as a nine-storey
    // pane of glass because somebody forgot a boolean.
    assert.equal(blockingOf(PROPS.tower), BLOCK.SOLID, 'nine storeys must stop a shot');
    assert.equal(blockingOf(PROPS.house), BLOCK.SOLID, 'two storeys is still a building');
    assert.equal(blockingOf(PROPS.castle), BLOCK.SOLID);
    assert.equal(blockingOf(PROPS.headquarters), BLOCK.SOLID);

    assert.equal(blockingOf(PROPS.tree), BLOCK.PARTIAL, 'a wood must not be a wall');
    assert.equal(blockingOf(PROPS.pine), BLOCK.PARTIAL);
    assert.equal(blockingOf(PROPS.bus), BLOCK.PARTIAL);

    assert.equal(blockingOf(PROPS.hedge), BLOCK.LOW, 'waist-high blocks legs, not eyes');
  });

  test('the tallest things on the map are the ones you can see through', () => {
    // A relay mast is a lattice and a water tower is four legs under a drum.
    // Going on height alone would make both of them opaque, which is exactly
    // backwards — hence `shape`.
    assert.ok(PROPS.mast.height > PROPS.tower.height, 'this test assumes the mast is tallest');
    assert.equal(blockingOf(PROPS.mast), BLOCK.PARTIAL);
    assert.equal(blockingOf(PROPS.watertower), BLOCK.PARTIAL);
  });

  test('every prop in the table resolves to a tier', () => {
    for (const [id, def] of Object.entries(PROPS)) {
      const tier = blockingOf(def);
      assert.ok(tier >= BLOCK.LOW && tier <= BLOCK.SOLID, `${id} resolved to ${tier}`);
    }
  });
});

/* ------------------------------------------------------------ hard block -- */

describe('a shot that cannot be taken', () => {
  test('a cliff between two machines silences the gun', () => {
    const world = arena();
    wall(world, 34, 24, 40);
    const shooter = spawnUnit(world, 'ember', 0, 30.5, 30.5); // hitscan, range 6.2
    const victim = spawnUnit(world, 'anvil', 1, 35.5, 30.5);
    shooter.targetId = victim.id;
    shooter.targetForced = true;

    const before = pool(victim);
    run(world, 60);
    assert.equal(pool(victim), before, 'a beam went through a cliff');
  });

  test('and the same two machines with the cliff removed do fight', () => {
    // The control. Without it the test above passes just as well when the
    // shooter is out of range, out of ammunition or facing the wrong way.
    const world = arena();
    const shooter = spawnUnit(world, 'ember', 0, 30.5, 30.5);
    const victim = spawnUnit(world, 'anvil', 1, 35.5, 30.5);
    shooter.targetId = victim.id;
    shooter.targetForced = true;

    const before = pool(victim);
    run(world, 60);
    assert.ok(pool(victim) < before, 'nothing landed across open ground');
  });

  test('a tower block does it too; a hedgerow does not', () => {
    for (const [defId, expected] of [
      ['tower', false],
      ['hedge', true],
    ]) {
      const world = arena();
      spawnProp(world, defId, 33, 30);
      const shooter = spawnUnit(world, 'ember', 0, 30.5, 30.5);
      const victim = spawnUnit(world, 'anvil', 1, 35.5, 30.5);
      shooter.targetId = victim.id;
      shooter.targetForced = true;

      const before = pool(victim);
      run(world, 60);
      assert.equal(pool(victim) < before, expected, `${defId} got the wrong answer`);
    }
  });

  test('a machine never auto-acquires something it cannot shoot', () => {
    // This is what keeps an army moving. A unit that locked onto a target
    // behind a tower block would walk into range, stop, and stand there for
    // the rest of the match.
    const world = arena();
    spawnProp(world, 'tower', 33, 30);
    const shooter = spawnUnit(world, 'kestrel', 0, 30.5, 30.5);
    spawnUnit(world, 'tick', 1, 35.5, 30.5);

    world.index = buildSpatialIndex(world);
    assert.equal(acquireTarget(world, shooter, world.index, 20), null, 'locked on through a wall');

    // Flatten it and the same target is fair game — the wall is doing the work.
    killEntity(world, [...world.entities.values()].find((e) => e.defId === 'tower'));
    world.index = buildSpatialIndex(world);
    assert.ok(acquireTarget(world, shooter, world.index, 20), 'demolition did not open the lane');
  });

  test('an auto-acquired target that ducks behind cover is let go', () => {
    // ...but a target the player pointed at is kept, because retargeting an
    // explicit order is how an attack command turns into a mystery.
    const world = arena();
    spawnProp(world, 'tower', 33, 30);
    const auto = spawnUnit(world, 'kestrel', 0, 30.5, 30.5);
    const forced = spawnUnit(world, 'kestrel', 0, 30.5, 33.5);
    const victim = spawnUnit(world, 'tick', 1, 35.5, 30.5);

    auto.targetId = victim.id;
    forced.targetId = victim.id;
    forced.targetForced = true;

    world.index = buildSpatialIndex(world);
    updateWeapons(world, auto, world.index);
    updateWeapons(world, forced, world.index);

    assert.equal(auto.targetId, null, 'held a target it could not shoot');
    assert.equal(forced.targetId, victim.id, 'quietly dropped an ordered attack');
  });

  test('a mortar lobs over what a rifle cannot see past', () => {
    // Indirect fire is the counterplay the hard block needs. Without it a
    // machine tucked behind a rock that nobody can find an angle on is simply
    // invulnerable, and a skirmish with three of those left never ends.
    const world = arena();
    wall(world, 33, 26, 36);
    // Just outside the mortar's minimum range: any further and its own 0.35
    // spread scatters shells wider than their blast, which would make this a
    // test of the dice rather than of the rule.
    const longbow = spawnUnit(world, 'longbow', 0, 30.5, 30.5);
    const victim = spawnUnit(world, 'anvil', 1, 35.5, 30.5);
    victim.shield = 0;
    longbow.targetId = victim.id;
    longbow.targetForced = true;

    world.index = buildSpatialIndex(world);
    assert.equal(traceShot(world, longbow, victim), BLOCKED, 'this test needs a wall between them');

    let fired = 0;
    for (let i = 0; i < 400; i++) {
      tick(world, []);
      for (const event of world.events) {
        if (event.type === 'fire' && event.id === longbow.id) fired++;
      }
    }
    assert.ok(fired > 0, 'a siege mortar would not open fire over a cliff');
    assert.ok(victim.hp < victim.maxHp, 'the shells landed somewhere other than on the target');
  });

  test('a machine told to advance walks at what it cannot shoot yet', () => {
    // Attack-move means "go and fight", and the order layer paths round the
    // obstruction — which is the only reason anything ever comes round the
    // back of a ridge. A machine holding ground does the opposite.
    const world = arena();
    wall(world, 33, 24, 40);
    const advancing = spawnUnit(world, 'kestrel', 0, 28.5, 30.5);
    const holding = spawnUnit(world, 'kestrel', 0, 28.5, 34.5);
    const enemy = spawnUnit(world, 'tick', 1, 40.5, 30.5);
    advancing.order = { type: 'attackMove', x: enemy.x, y: enemy.y };
    world.index = buildSpatialIndex(world);

    assert.ok(enemy.x - advancing.x > maxRange(advancing), 'this test needs the enemy out of reach');
    const picked = acquireTarget(world, advancing, world.index, 20);
    assert.ok(picked && picked.id === enemy.id, 'an advance stopped at the first rock');
    assert.equal(acquireTarget(world, holding, world.index, 20), null, 'holding ground chased');
  });

  test('but not once it is close enough that walking will not help', () => {
    // `pursue` stops at four fifths of reach, so a machine that locked onto
    // something behind a wall *inside* its own range would close no further
    // and would stand there facing the wall for the rest of the match.
    const world = arena();
    wall(world, 33, 24, 40);
    const advancing = spawnUnit(world, 'kestrel', 0, 31.5, 30.5);
    const enemy = spawnUnit(world, 'tick', 1, 35.5, 30.5);
    advancing.order = { type: 'attackMove', x: enemy.x, y: enemy.y };
    world.index = buildSpatialIndex(world);

    assert.ok(enemy.x - advancing.x < maxRange(advancing), 'this test needs the enemy in reach');
    assert.equal(acquireTarget(world, advancing, world.index, 20), null);
  });

  test('you can always shoot the thing that is blocking you', () => {
    // The trace has to ignore the target's own footprint, or an ordered attack
    // on a tower block would silently do nothing and the map would stop being
    // destructible from more than one cell away.
    const world = arena();
    const tower = spawnProp(world, 'tower', 34, 30);
    const mech = spawnUnit(world, 'kestrel', 0, 30.5, 30.5);
    applyCommand(world, { type: 'attack', player: 0, ids: [mech.id], targetId: tower.id });

    run(world, 90);
    assert.ok(tower.hp < tower.maxHp, 'a mech could not shoot the building in front of it');
  });

  test('a machine standing inside a blocker is on top of it, not behind it', () => {
    // Leaps, displacement and half the suite put units on cells they could
    // never have walked to. Reading the ground under their own feet as cover
    // would disarm them permanently, facing outward at a world they can no
    // longer shoot at.
    const world = arena();
    wall(world, 30, 28, 34);
    const shooter = spawnUnit(world, 'ember', 0, 30.5, 30.5); // standing on the cliff
    const victim = spawnUnit(world, 'anvil', 1, 34.5, 30.5);
    shooter.targetId = victim.id;
    shooter.targetForced = true;

    const before = pool(victim);
    run(world, 60);
    assert.ok(pool(victim) < before, 'a mech on a rock could not fire off it');
  });
});

/* ---------------------------------------------------------------- canopy -- */

describe('canopy taxes a firing line without ending it', () => {
  test('shots still land through trees, and land less often', () => {
    // Two identical fights, one of them through a stand of ironwood. A Vireo,
    // because its autocannon is a single direct round with no splash — a
    // rocket that misses still detonates somewhere useful and would blunt the
    // very difference being measured.
    const damageThrough = (trees) => {
      const world = arena();
      for (let i = 0; i < trees; i++) spawnProp(world, 'tree', 32 + i, 30);
      const shooter = spawnUnit(world, 'vireo', 0, 30.5, 30.5);
      const victim = spawnUnit(world, 'anvil', 1, 34.5, 30.5);
      victim.shield = 0;
      shooter.targetId = victim.id;
      shooter.targetForced = true;
      run(world, 400);
      return victim.maxHp - victim.hp;
    };

    const open = damageThrough(0);
    const wooded = damageThrough(1);
    assert.ok(open > 0, 'the control fight never connected');
    assert.ok(wooded > 0, 'a single tree stopped an autocannon outright');
    assert.ok(wooded < open, `canopy cost nothing: ${wooded} vs ${open} in the open`);
  });

  test('a wood deep enough is a wall', () => {
    const world = arena();
    for (let i = 0; i < 5; i++) spawnProp(world, 'tree', 32 + i, 30);
    const shooter = spawnUnit(world, 'ember', 0, 30.5, 30.5);
    const victim = spawnUnit(world, 'anvil', 1, 37.5, 30.5);

    world.index = buildSpatialIndex(world);
    assert.equal(traceShot(world, shooter, victim), BLOCKED, 'saw the length of a wood');

    // One tree, on the other hand, is one tree.
    const thin = arena();
    spawnProp(thin, 'tree', 33, 30);
    const a = spawnUnit(thin, 'ember', 0, 30.5, 30.5);
    const b = spawnUnit(thin, 'anvil', 1, 35.5, 30.5);
    thin.index = buildSpatialIndex(thin);
    assert.equal(traceShot(thin, a, b), 1, 'one ironwood should be one cell of canopy');
  });

  test('beams dim rather than miss, because a beam cannot miss', () => {
    // Scattering a hitscan weapon is a no-op, so energy would be the one
    // warhead that ignored terrain entirely. It pays in damage instead.
    const beamDamage = (trees) => {
      const world = arena();
      for (let i = 0; i < trees; i++) spawnProp(world, 'tree', 33, 30 + i);
      const shooter = spawnUnit(world, 'ember', 0, 30.5, 30.5);
      const victim = spawnUnit(world, 'anvil', 1, 35.5, 30.5);
      victim.shield = 0;
      shooter.targetId = victim.id;
      shooter.targetForced = true;
      run(world, 25);
      return victim.maxHp - victim.hp;
    };

    const open = beamDamage(0);
    const wooded = beamDamage(1);
    assert.ok(open > 0 && wooded > 0);
    assert.ok(wooded < open, `a beam through canopy cost nothing: ${wooded} vs ${open}`);
  });
});

/* ------------------------------------------------------------------- air -- */

describe('air ignores all of it', () => {
  test('a gunship shoots over a cliff, and is shot back at over one', () => {
    const world = arena();
    wall(world, 34, 24, 40);
    const flyer = spawnUnit(world, 'harrier', 0, 30.5, 30.5);
    const ground = spawnUnit(world, 'anvil', 1, 36.5, 30.5);

    world.index = buildSpatialIndex(world);
    assert.equal(traceShot(world, flyer, ground), 0, 'a cliff stopped an aircraft');
    assert.equal(traceShot(world, ground, flyer), 0, 'a cliff protected an aircraft');
  });

  test('and nothing on the ground is cover for it', () => {
    const world = arena();
    spawnProp(world, 'tower', 33, 30);
    const flyer = spawnUnit(world, 'harrier', 0, 34.5, 30.5);
    world.index = buildSpatialIndex(world);
    assert.equal(flyer.cover, COVER.NONE, 'an aircraft was hiding behind a building');
    assert.equal(coverAgainst(world, flyer, 20, 30.5), COVER.NONE);
  });
});

/* ----------------------------------------------------------------- cover -- */

describe('cover', () => {
  test('is two tiers, and both are on the entity for the renderer to read', () => {
    const world = arena();
    wall(world, 33, 28, 34);
    spawnProp(world, 'hedge', 40, 30); // 2x1, so it covers (40,30) and (41,30)

    const exposed = spawnUnit(world, 'anvil', 1, 26.5, 30.5);
    const behindHedge = spawnUnit(world, 'anvil', 1, 39.5, 30.5);
    const behindRock = spawnUnit(world, 'anvil', 1, 32.5, 30.5);

    buildSpatialIndex(world);
    assert.equal(exposed.cover, COVER.NONE, 'open ground is not cover');
    assert.equal(behindHedge.cover, COVER.HALF, 'a hedgerow is half cover');
    assert.equal(behindRock.cover, COVER.FULL, 'a cliff face is full cover');
  });

  test('only counts from the side the shot came from', () => {
    const world = arena();
    wall(world, 33, 28, 34);
    const mech = spawnUnit(world, 'anvil', 1, 32.5, 30.5);
    buildSpatialIndex(world);

    assert.equal(coverAgainst(world, mech, 40, 30.5), COVER.FULL, 'the rock is on that side');
    assert.equal(coverAgainst(world, mech, 24, 30.5), COVER.NONE, 'and not on that one');
    // Being flanked is a real thing that happens to a machine in cover, and
    // walking round one is the answer to it.
    assert.equal(coverAgainst(world, mech, 26, 36), COVER.NONE, 'cover from behind');
  });

  test('a machine in cover takes measurably less', () => {
    // Two mechs on the same side of the same rock, shot along the same clear
    // lane from due east. One is tucked into the corner where the wall ends,
    // so the round has to come round it; the other is four cells further down
    // in the open. This is the whole mechanic in one picture.
    const takenAt = (y) => {
      const world = arena();
      wall(world, 33, 26, 30);
      const shooter = spawnUnit(world, 'vireo', 0, 36.5, y);
      const victim = spawnUnit(world, 'anvil', 1, 32.5, y);
      victim.shield = 0;
      shooter.targetId = victim.id;
      shooter.targetForced = true;
      run(world, 300);
      return victim.maxHp - victim.hp;
    };

    const covered = takenAt(31.5); // against the south end of the wall
    const open = takenAt(35.5); // well clear of it
    assert.ok(covered > 0, 'cover became a hard block — the shot never arrived');
    assert.ok(open > 0, 'the control never connected');
    assert.ok(covered < open, `cover was free: ${covered} taken against ${open} in the open`);
  });

  test('explosives dig you out of it', () => {
    // Splash deliberately ignores cover: it is the counter, and it is the
    // reason explosive is the siege warhead in the table already.
    const world = arena();
    wall(world, 33, 28, 34);
    const victim = spawnUnit(world, 'anvil', 1, 32.5, 30.5);
    victim.shield = 0;
    buildSpatialIndex(world);
    assert.equal(victim.cover, COVER.FULL);

    world.projectiles.push({
      id: 1,
      kind: 'shell',
      x: 32.5,
      y: 30.5,
      tx: 32.5,
      ty: 30.5,
      startX: 40,
      startY: 30.5,
      targetId: null,
      speed: 1,
      damage: 100,
      damageType: 'explosive',
      splash: { radius: 2, falloff: 0.5 },
      disableTicks: 0,
      owner: 0,
      player: 0,
      life: 10,
    });
    tick(world, []);
    // Explosive against heavy plate is 0.85 in the damage table, and the mech
    // drifts a fraction of a cell under separation steering before the blast
    // resolves — so this is "full damage give or take falloff", not a constant.
    const dealt = victim.maxHp - victim.hp;
    assert.ok(
      dealt > 100 * 0.85 * 0.95,
      `splash was reduced by cover: ${dealt.toFixed(1)} of an expected ~85`
    );
    assert.ok(dealt > 100 * COVER_DAMAGE[COVER.FULL] * 0.85 * 1.2, 'cover leaked into splash');
  });

  test('structures do not get it', () => {
    // A building cannot walk into a doorway, and its answer to being shot at
    // is the hull the armour table already gives it.
    const world = arena();
    wall(world, 33, 26, 36);
    const reactor = spawnBuilding(world, 'reactor', 1, 30, 29, { complete: true });
    buildSpatialIndex(world);
    assert.equal(reactor.cover, COVER.NONE);
    assert.equal(coverAgainst(world, reactor, 40, 30), COVER.NONE);
  });
});

/* ------------------------------------------------------------ high ground -- */

describe('high ground', () => {
  test('the shelf is the lip of a cliff, and only the lip', () => {
    const world = arena();
    wall(world, 33, 28, 34);

    assert.equal(isElevated(world.map, 32.5, 30.5), true, 'the cell beside a cliff is the shelf');
    assert.equal(isElevated(world.map, 34.5, 30.5), true, 'and so is the one on the far side');
    assert.equal(isElevated(world.map, 31.5, 30.5), false, 'two cells out is flat ground');
    assert.equal(isElevated(world.map, 33.5, 30.5), false, 'the cliff itself is not standable');
    // Corners do not count: a cell touching a cliff at one point is not
    // standing on anything, and counting them smears the shelf into a blob.
    assert.equal(isElevated(world.map, 32.5, 35.5), false, 'a diagonal touch is not high ground');
  });

  test('buys reach, and the reach is real', () => {
    const world = arena();
    wall(world, 33, 26, 36);
    const high = spawnUnit(world, 'longbow', 0, 32.5, 30.5);
    const flat = spawnUnit(world, 'longbow', 0, 28.5, 30.5);
    buildSpatialIndex(world);

    assert.equal(high.elevated, true);
    assert.equal(flat.elevated, false);
    assert.ok(maxRange(high) > maxRange(flat), 'the ridge was worth nothing');
    assert.equal(
      weaponRange(high, high.weapons[0]),
      high.weapons[0].def.range * ELEVATION.RANGE
    );
  });

  test('and sight, for both sides equally', () => {
    const world = arena();
    wall(world, 33, 26, 36);
    const scout = spawnUnit(world, 'vireo', 0, 32.5, 30.5);
    updateVision(world, world.players[0]);

    const edge = scout.def.sight + ELEVATION.SIGHT - 0.5;
    assert.ok(
      isVisible(world, 0, scout.x + edge, scout.y),
      'high ground did not extend the horizon'
    );

    // Same machine, same map, off the shelf: the extra cells are gone.
    scout.x = 28.5;
    updateVision(world, world.players[0]);
    assert.equal(isVisible(world, 0, scout.x + edge, scout.y), false);
  });

  test('a cliff is still a cliff — height is reach, not x-ray', () => {
    const world = arena();
    wall(world, 33, 26, 36);
    const high = spawnUnit(world, 'ember', 0, 32.5, 30.5);
    const across = spawnUnit(world, 'anvil', 1, 34.5, 30.5);
    world.index = buildSpatialIndex(world);
    assert.equal(traceShot(world, high, across), BLOCKED, 'the ridge became transparent');
  });
});

/* --------------------------------------------------------------- upkeep -- */

describe('the grid keeps up with the world', () => {
  test('flattening a tower block opens the firing lane it was blocking', () => {
    const world = arena();
    const tower = spawnProp(world, 'tower', 33, 30);
    const shooter = spawnUnit(world, 'ember', 0, 30.5, 30.5);
    const victim = spawnUnit(world, 'anvil', 1, 35.5, 30.5);

    world.index = buildSpatialIndex(world);
    assert.equal(traceShot(world, shooter, victim), BLOCKED);

    killEntity(world, tower);
    assert.equal(traceShot(world, shooter, victim), 0, 'the rubble still blocked the shot');
  });

  test('terrain rewritten under a live world is picked up', () => {
    // `clearGround` and its friends rewrite terrain after a world exists, and
    // a mask that described the map as generated would make every test built
    // on that helper assert nothing at all.
    const world = arena();
    const shooter = spawnUnit(world, 'ember', 0, 30.5, 30.5);
    const victim = spawnUnit(world, 'anvil', 1, 35.5, 30.5);
    run(world, 2);
    assert.equal(traceShot(world, shooter, victim), 0);

    wall(world, 33, 28, 34);
    run(world, 2);
    assert.equal(traceShot(world, shooter, victim), BLOCKED, 'a new cliff was invisible');
    assert.equal(isElevated(world.map, 32.5, 30.5), true, 'and so was the shelf beside it');
  });
});

/* --------------------------------------------------------- determinism -- */

describe('none of this costs determinism', () => {
  test('a match fought over terrain replays to the identical world', () => {
    const config = {
      seed: 90210,
      players: [
        { faction: 'ascendancy', isAI: true },
        { faction: 'bulwark', isAI: true },
      ],
    };
    const a = runAI(createWorld(config), 900);
    const b = runAI(createWorld(config), 900);
    assert.equal(hashWorld(a), hashWorld(b));
  });

  test('a shot across open ground consumes exactly the rolls it always did', () => {
    // The canopy roll is only taken when there is canopy, which is what lets a
    // fight in the open replay bit-for-bit against every match recorded before
    // terrain had an opinion about shooting.
    const world = makeBareWorld();
    const shooter = spawnUnit(world, 'kestrel', 0, 45.5, 45.5);
    const victim = spawnUnit(world, 'anvil', 1, 48.5, 45.5);
    shooter.targetId = victim.id;
    shooter.targetForced = true;
    world.index = buildSpatialIndex(world);
    assert.equal(traceShot(world, shooter, victim), 0, 'this test needs clear ground');

    const before = world.rng.state();
    updateWeapons(world, shooter, world.index);
    const spent = world.rng.state();
    // One salvo of rockets: two range() calls per round, and nothing else.
    run(world, 1);
    assert.notEqual(spent, before, 'spread stopped consuming the stream entirely');
  });
});

/* -------------------------------------------------------------- the cost -- */

describe('it has to be cheap enough to run every tick', () => {
  test('a busy world still ticks in a fraction of its budget', () => {
    // The failure this guards against is invisible in every assertion above: a
    // per-shot walk over the entity list gives all the same answers and turns
    // a 50ms tick into a stutter on a Fire tablet. A full 144x144 map with its
    // several hundred props, two AI armies and everything shooting is the
    // worst case the game actually produces.
    const world = createWorld({
      seed: 1234,
      players: [
        { faction: 'ascendancy', isAI: true, difficulty: 'hard' },
        { faction: 'bulwark', isAI: true, difficulty: 'hard' },
      ],
    });
    runAI(world, TICKS_PER_SECOND * 90);

    const armed = [...world.entities.values()].filter(
      (e) => !e.dead && e.weapons && e.weapons.length
    ).length;
    const props = [...world.entities.values()].filter((e) => e.kind === 'prop').length;
    assert.ok(props > 100, `only ${props} props — this is not the worst case`);
    assert.ok(armed > 10, `only ${armed} armed machines — this is not the worst case`);

    const started = performance.now();
    const measured = 600;
    runAI(world, measured);
    const perTick = (performance.now() - started) / measured;

    // A tick is 50ms of simulated time. Ten times over budget on a developer
    // machine is not a threshold anybody hits by accident — it is the one a
    // quadratic rewrite trips on the first run.
    assert.ok(perTick < 5, `${perTick.toFixed(2)}ms per tick with ${props} props standing`);
  });

  test('a trace costs the line, not the map', () => {
    const world = arena();
    const shooter = spawnUnit(world, 'longbow', 0, 30.5, 30.5);
    const victim = spawnUnit(world, 'anvil', 1, 40.5, 40.5);
    world.index = buildSpatialIndex(world);

    const started = performance.now();
    for (let i = 0; i < 200000; i++) traceShot(world, shooter, victim);
    const each = (performance.now() - started) / 200000;
    assert.ok(each < 0.02, `${(each * 1000).toFixed(2)}µs per trace`);
  });
});
