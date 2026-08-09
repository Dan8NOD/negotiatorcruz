/**
 * Generate the castle estate layout from its parameters.
 *
 * This script exists because of one constraint, and the constraint is worth
 * stating up front: **the estate's geometry is a spiral, and a spiral needs
 * sin and cos, and the engine is not allowed to call them.**
 *
 * `engine/numeric.js` explains why — ECMA-262 marks sin/cos/atan2 as
 * implementation-approximated, so V8, JavaScriptCore and the C library a Swift
 * build links against are each entitled to return a different answer within
 * tolerance. A test in `test/sim.test.js` scans every file in `engine/` and
 * fails on a raw `Math.cos(`. That test is right to exist: map generation feeds
 * terrain, terrain feeds pathfinding, and two engines that disagree about where
 * a road went do not agree about the match.
 *
 * The fix is the same one `RING_COS` already uses: do the trig **once, here**,
 * and emit the results as decimal literals. Decimal-to-double conversion *is*
 * correctly rounded in every language, so a literal round-trips exactly where a
 * `cos()` call would not. The engine then reads coordinates, never angles.
 *
 * Because the geometry has to be resolved to plain numbers anyway, the same
 * pass emits the portable JSON that a Unity importer reads. One generator, two
 * renderers, no second source of truth:
 *
 *     tools/build-estate.mjs
 *         ├─→ engine/estate.js   baked literals, imported by the game
 *         └─→ estate.json        plain data, imported by Unity
 *
 * Run it after changing any parameter below:
 *
 *     npm run rocketman:estate
 */

import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/* ------------------------------------------------------------ parameters -- */

/**
 * The whole design lives here. Everything below this block is derivation, so
 * tuning the castle means editing these numbers and re-running — not editing
 * generated coordinates by hand.
 *
 * Units are **cells** throughout, matching the rest of the engine. The origin
 * is the hill's centre, +x east and +y south, which is the map array's own
 * convention rather than a maths one.
 */
export const PARAMS = {
  id: 'castle',
  name: 'Hillcrest',

  /**
   * Metres per cell, used only when exporting for a 3D engine.
   *
   * Derived from the props already in the game rather than picked: a `house` is
   * one cell across and two storeys tall, and a two-storey house is about eight
   * metres wide. That puts the keep at 40m square and 104m tall — a thirty-odd
   * storey tower, which is the intended read.
   */
  cellMetres: 8,

  /**
   * Total height, in cells, of the keep.
   *
   * The brief was "two hero robot jet jumps". There are two leap abilities and
   * they answer very differently: `jumpjet` covers 6.5 cells, and `skyfall`
   * covers 36 — which its own comment calls "half a standard 72-cell map", so
   * two of those is the entire battlefield rather than a height. This is two
   * Jump Jets.
   *
   * For scale: the tallest thing in the game today is the Relay Mast at 4.2,
   * and the nine-storey Tower Block is 3.4. Thirteen is deliberately without
   * precedent — it is meant to be the thing you navigate by from anywhere.
   */
  keepHeight: 13,

  /** The keep itself. Odd footprint so it centres exactly on the origin. */
  keep: { size: [5, 5] },

  /**
   * Corner towers, at the diagonals of the keep.
   *
   * `offset` is chosen so their outer corners land on the plateau's edge —
   * corner towers belong on the perimeter of the platform, not floating inside
   * it. At offset 4 the far corner sits at radius 7.07, against a plateau of 7.
   */
  towers: { size: [2, 2], height: 9, offset: 4 },

  /**
   * The gatehouse, where the climbing road arrives. Due south of the keep.
   *
   * Its distance is *derived* from the plateau radius rather than written down,
   * so widening the hill moves the gate — and the road, which is sampled to end
   * at the gate — instead of silently leaving the door hanging over a cliff.
   */
  gatehouse: { size: [3, 2], height: 4 },

  /**
   * The hill, as concentric rings measured from the origin.
   *
   * `plateau` is the flat top the castle stands on. Between `plateau` and
   * `outer` the ground is rough, and each `rims` radius is a band of cliff.
   *
   * The cliffs are the point. A hill that is merely decorative gets walked over
   * from any direction and the road becomes scenery; a hill ringed by cliff can
   * only be climbed where the road cuts through, which is what makes the
   * switchbacks a tactical fact instead of a texture. It is the same
   * ridge-and-ramp idiom the rest of the map generator already uses.
   */
  hill: { plateau: 7, outer: 12, rims: [9.5, 12] },

  /**
   * The approach road: a spiral that starts out on flat ground, wraps the hill,
   * and arrives at the gatehouse.
   *
   * `turns` at 1.25 spaces successive passes about 6.4 cells apart, which is
   * wide enough to read as separate switchbacks with hillside between them.
   * Tightening it much past 1.5 merges the passes into a paved disc.
   *
   * `samples` is set by the outermost segment, which is the longest: arc length
   * per sample is `outerRadius * turns * TAU / samples`, so 80 keeps every
   * segment under 1.5 cells. The map generator paves straight lines between
   * consecutive points, and segments longer than about a cell and a half start
   * showing their corners instead of reading as a curve.
   */
  road: { turns: 1.25, outerRadius: 15, samples: 80, lanes: 2 },
};

/* ------------------------------------------------------------ derivation -- */

const TAU = Math.PI * 2;

/**
 * Sample the approach spiral.
 *
 * Angle runs *backwards* from the gate so the last point lands exactly on the
 * gatehouse rather than near it — the road has to meet the door, and a spiral
 * sampled forwards from an arbitrary start only meets it by luck.
 *
 * At theta = pi/2, (cos, sin) is (0, 1), which in this coordinate system is due
 * south. That is where the gatehouse is, so the gate is the natural anchor for
 * the whole curve.
 */
function spiral({ turns, outerRadius, samples }, gateRadius) {
  const thetaEnd = Math.PI / 2;
  const thetaStart = thetaEnd - turns * TAU;
  const points = [];

  for (let i = 0; i <= samples; i++) {
    const t = i / samples;
    const theta = thetaStart + (thetaEnd - thetaStart) * t;
    // Radius shrinks linearly with angle, which is what makes it a spiral
    // rather than a circle — the road is descending the whole way round.
    const r = outerRadius + (gateRadius - outerRadius) * t;
    points.push([round(Math.cos(theta) * r), round(Math.sin(theta) * r)]);
  }
  return points;
}

/**
 * Six decimal places is about 8mm at this scale — far below anything either
 * renderer can show, and it keeps the generated file readable. The value still
 * round-trips exactly, which is the property that actually matters.
 *
 * The `=== 0` branch is not redundant: `cos` returns **negative zero** at some
 * angles, and -0 survives `toFixed`. It then diverges between the two artifacts
 * — a template literal renders it as `0` in the JS module while `JSON.stringify`
 * also flattens it, but the in-memory generator output keeps it, so the module
 * and the generator compare unequal under a strict deep-equal. Comparing
 * against 0 catches -0 (they are `==` and `===`) and returns a clean +0, so all
 * three representations agree.
 */
function round(n) {
  const r = Number(n.toFixed(6));
  return r === 0 ? 0 : r;
}

/** Resolve the parameters into the plain geometry both renderers consume. */
export function buildEstate(params = PARAMS) {
  const { keep, towers, gatehouse, hill, road } = params;
  const o = towers.offset;
  // The gate sits on the plateau's perimeter, and the road is sampled to end
  // there — so this one number ties the hill, the gatehouse and the road
  // together. Deriving it means they cannot drift apart when the hill is tuned.
  const gateAt = hill.plateau;

  const structures = [
    { id: 'keep', at: [0, 0], size: keep.size, height: params.keepHeight },
    { id: 'tower_nw', at: [-o, -o], size: towers.size, height: towers.height },
    { id: 'tower_ne', at: [o, -o], size: towers.size, height: towers.height },
    { id: 'tower_sw', at: [-o, o], size: towers.size, height: towers.height },
    { id: 'tower_se', at: [o, o], size: towers.size, height: towers.height },
    {
      id: 'gatehouse',
      at: [0, gateAt],
      size: gatehouse.size,
      height: gatehouse.height,
    },
  ];

  const points = spiral(road, gateAt);

  return {
    id: params.id,
    name: params.name,
    cellMetres: params.cellMetres,
    hill,
    structures,
    road: {
      lanes: road.lanes,
      /** Where the estate road wants to meet the district network. */
      approach: points[0],
      points,
    },
  };
}

/* -------------------------------------------------------------- emitters -- */

const fmt = (v) => JSON.stringify(v);

function emitModule(estate) {
  const pairs = estate.road.points.map(([x, y]) => `  [${x}, ${y}],`).join('\n');
  const structures = estate.structures
    .map(
      (s) =>
        `  { id: ${fmt(s.id)}, at: [${s.at[0]}, ${s.at[1]}], ` +
        `size: [${s.size[0]}, ${s.size[1]}], height: ${s.height} },`
    )
    .join('\n');

  return `/**
 * The castle estate's resolved geometry. GENERATED — do not edit by hand.
 *
 * Every coordinate here was produced by \`tools/build-estate.mjs\`; change the
 * parameters there and re-run \`npm run rocketman:estate\`.
 *
 * The coordinates are baked as literals rather than computed for the reason
 * \`numeric.js\` gives at length: a spiral needs sin and cos, those are
 * implementation-approximated, and an engine that computes its own map geometry
 * would generate subtly different terrain under V8, JavaScriptCore and Swift.
 * A decimal literal round-trips exactly in all three. So the trig happens once,
 * offline, and the engine only ever reads coordinates.
 *
 * Units are cells. Origin is the hill's centre, +x east and +y south.
 */

/** Metres per cell, for the 3D export only. The game never reads this. */
export const CELL_METRES = ${estate.cellMetres};

/** Rings of the hill, measured from the origin. \`rims\` are bands of cliff. */
export const HILL = {
  plateau: ${estate.hill.plateau},
  outer: ${estate.hill.outer},
  rims: [${estate.hill.rims.join(', ')}],
};

/**
 * What stands on the hill.
 *
 * \`at\` is the structure's **centre**, offset from the origin — not its corner.
 * Footprints are odd-sized where they need to centre exactly, and the map
 * generator converts to the top-left origin that \`PROPS\` placement expects.
 *
 * \`height\` is the same presentation-only elevation the props table uses — the
 * renderer offsets the roof by \`height * CELL * 0.34\` pixels to fake relief.
 * The keep's 13 is two Jump Jet leaps, and roughly 3.8x the nine-storey Tower
 * Block, which is what makes it read as a landmark rather than a big building.
 */
export const STRUCTURES = [
${structures}
];

/**
 * The approach road, as a polyline climbing the hill to the gatehouse.
 *
 * Consecutive points are close enough together that paving straight segments
 * between them reads as a curve, so the map generator can reuse \`paveLine\`
 * rather than growing a second rasteriser. A 3D importer should treat the same
 * points as spline control points instead.
 *
 * The last point is the gatehouse door, not an approximation of it — the
 * spiral is sampled backwards from the gate for exactly that reason.
 */
export const ROAD_LANES = ${estate.road.lanes};

export const ROAD_APPROACH = [${estate.road.approach[0]}, ${estate.road.approach[1]}];

export const ROAD_POINTS = [
${pairs}
];

/** Everything above, in the shape the exporter and the tests both want. */
export const CASTLE_ESTATE = {
  id: ${fmt(estate.id)},
  name: ${fmt(estate.name)},
  cellMetres: CELL_METRES,
  hill: HILL,
  structures: STRUCTURES,
  road: { lanes: ROAD_LANES, approach: ROAD_APPROACH, points: ROAD_POINTS },
};
`;
}

/**
 * The Unity-facing artifact.
 *
 * Deliberately plain: no nesting a C# importer would need a custom serialiser
 * for, and every length carried twice — once in cells, once in metres — so the
 * importer never has to know this game's cell size to place a mesh.
 */
function emitJson(estate) {
  const m = estate.cellMetres;
  const scale = ([x, y]) => ({ x: round(x * m), z: round(y * m) });

  return JSON.stringify(
    {
      $comment:
        'GENERATED by rocketman/tools/build-estate.mjs — do not edit. ' +
        'Cell coordinates use +x east, +y south (2D map convention). ' +
        'Metre coordinates use x/z on the ground plane and y up, for Unity.',
      id: estate.id,
      name: estate.name,
      cellMetres: m,
      hill: {
        plateauCells: estate.hill.plateau,
        outerCells: estate.hill.outer,
        rimCells: estate.hill.rims,
        plateauMetres: round(estate.hill.plateau * m),
        outerMetres: round(estate.hill.outer * m),
        rimMetres: estate.hill.rims.map((r) => round(r * m)),
      },
      structures: estate.structures.map((s) => ({
        id: s.id,
        cells: { x: s.at[0], y: s.at[1], w: s.size[0], h: s.size[1], height: s.height },
        metres: {
          position: { ...scale(s.at), y: 0 },
          footprint: { x: round(s.size[0] * m), z: round(s.size[1] * m) },
          height: round(s.height * m),
        },
      })),
      road: {
        lanes: estate.road.lanes,
        widthMetres: round(estate.road.lanes * m),
        approachCells: { x: estate.road.approach[0], y: estate.road.approach[1] },
        pointsCells: estate.road.points.map(([x, y]) => ({ x, y })),
        pointsMetres: estate.road.points.map((p) => ({ ...scale(p), y: 0 })),
      },
    },
    null,
    2
  ) + '\n';
}

/* ------------------------------------------------------------------ main -- */

const here = (rel) => fileURLToPath(new URL(rel, import.meta.url));

if (process.argv[1] === here('build-estate.mjs')) {
  const estate = buildEstate();
  writeFileSync(here('../engine/estate.js'), emitModule(estate));
  writeFileSync(here('../estate.json'), emitJson(estate));
  const spacing = (
    (PARAMS.road.outerRadius - PARAMS.hill.plateau) /
    PARAMS.road.turns
  ).toFixed(1);
  console.log(
    `estate: keep ${PARAMS.keep.size.join('x')} at height ${PARAMS.keepHeight} cells ` +
      `(${PARAMS.keepHeight * PARAMS.cellMetres}m), ` +
      `${estate.road.points.length} road points, ~${spacing} cells between passes`
  );
  console.log('wrote engine/estate.js and estate.json');
}
