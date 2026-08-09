/**
 * Generate the Arch's geometry from its parameters.
 *
 * Same split, and the same reason, as `build-estate.mjs`: a catenary needs
 * `cosh`, `engine/numeric.js` forbids the engine from calling it, and a test in
 * `test/sim.test.js` scans `engine/` and fails on `Math.cosh(`. Terrain and prop
 * placement feed pathfinding, so an engine that computes its own curve would
 * generate subtly different maps under V8, JavaScriptCore and Swift. The trig
 * happens once here and the engine reads baked coordinates.
 *
 *     tools/build-arch.mjs
 *         ├─→ engine/arch.js   baked literals, imported by the game
 *         └─→ arch.json        plain data, imported by Unity
 *
 *     npm run rocketman:arch
 */

import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/* ------------------------------------------------------------ parameters -- */

export const PARAMS = {
  id: 'arch',
  name: 'The Arch',

  /** Metres per cell. Matches the estate; both feed the same 3D scene. */
  cellMetres: 8,

  /**
   * Height and span, in cells. Both 30, because arches are about as tall as
   * they are wide and this one is modelled on the Gateway Arch, which is 630ft
   * each way.
   *
   * 30 cells is 240m — roughly 790ft, and 2.3x the castle keep's 13. The brief
   * asked for 80ft, which is 3 cells here: shorter than the nine-storey Tower
   * Blocks already scattered around the map, and a quarter of the castle. At
   * this scale 80ft is street furniture, so the number moved rather than the
   * intent.
   */
  height: 30,
  span: 30,

  /**
   * Each leg's footprint.
   *
   * 4x4 is 32m square, which is what 240m of structure needs under it to look
   * like it could stand. It is also the same footprint as the Hangar, which is
   * the largest *building* in the game — a useful sanity check that the legs
   * read as massive rather than as pillars.
   */
  legSize: [4, 4],

  /**
   * Catenary shape parameter. Higher is pointier, lower is rounder.
   *
   * 3 gives the flattened catenary a real arch uses — the curve a hanging chain
   * makes, inverted, which is the shape that carries its own weight in pure
   * compression. A parabola would be close enough to look right and wrong for
   * the same reason a drawn spiral is wrong: it is the shape of something else.
   */
  shape: 3,

  /**
   * Samples along the curve.
   *
   * Set by the *feet*, not the crown. Sampling is uniform in x, and near the
   * ground the curve is almost vertical — so the first segment climbs nearly
   * four cells for half a cell across at 48 samples, which draws the feet as
   * two straight diagonal slabs. 120 holds every segment under a cell and a
   * half, and 120 baked pairs cost nothing.
   */
  samples: 120,
};

/* ------------------------------------------------------------ derivation -- */

/**
 * Height of the arch at horizontal offset `x` from its centre.
 *
 * `H * (cosh(c) - cosh(2cx/S)) / (cosh(c) - 1)` — which is `H` at the crown and
 * exactly 0 at both feet, so the curve lands on the ground rather than near it.
 */
function archHeight(x, { height, span, shape: c }) {
  const denom = Math.cosh(c) - 1;
  return (height * (Math.cosh(c) - Math.cosh((2 * c * x) / span))) / denom;
}

const round = (n) => {
  const r = Number(n.toFixed(6));
  // -0 survives toFixed and then diverges between the JS module and the JSON,
  // which is how the estate's two artifacts once compared unequal.
  return r === 0 ? 0 : r;
};

export function buildArch(params = PARAMS) {
  const { span, samples, legSize } = params;
  const half = span / 2;

  const curve = [];
  for (let i = 0; i <= samples; i++) {
    const x = -half + (span * i) / samples;
    curve.push([round(x), round(archHeight(x, params))]);
  }

  return {
    id: params.id,
    name: params.name,
    cellMetres: params.cellMetres,
    height: params.height,
    span,
    legSize,
    /** Leg centres, as offsets from the arch's own centre. */
    legs: [
      [-half, 0],
      [half, 0],
    ],
    curve,
  };
}

/* -------------------------------------------------------------- emitters -- */

function emitModule(a) {
  const curve = a.curve.map(([x, h]) => `  [${x}, ${h}],`).join('\n');

  return `/**
 * The Arch's resolved geometry. GENERATED — do not edit by hand.
 *
 * Produced by \`tools/build-arch.mjs\`; change the parameters there and re-run
 * \`npm run rocketman:arch\`.
 *
 * Baked as literals rather than computed because a catenary needs \`cosh\`, and
 * \`numeric.js\` explains why the engine may not call it: implementation-
 * approximated functions differ between JavaScript engines and the C library a
 * Swift build links against, and map geometry feeds pathfinding.
 *
 * Units are cells. Origin is the arch's centre, on the ground, +x along the
 * span. The curve's second value is height above ground, not a y coordinate —
 * the arch stands *up* out of the map, which has no third axis.
 */

/** Metres per cell, for the 3D export only. The game never reads this. */
export const CELL_METRES = ${a.cellMetres};

/** Crown height and foot-to-foot span, in cells. */
export const ARCH_HEIGHT = ${a.height};
export const ARCH_SPAN = ${a.span};

/** Footprint of each leg. The legs are solid; the span overhead is not. */
export const LEG_SIZE = [${a.legSize[0]}, ${a.legSize[1]}];

/** Leg centres as offsets from the arch's centre. */
export const LEGS = [
  [${a.legs[0][0]}, ${a.legs[0][1]}],
  [${a.legs[1][0]}, ${a.legs[1][1]}],
];

/**
 * The centreline, as \`[offsetFromCentre, heightAboveGround]\` in cells.
 *
 * Symmetric about x = 0 by construction, which matters more than it looks: the
 * map generator mirrors everything 180°, and a shape that is its own mirror
 * image can be drawn at the twin position without swapping its halves.
 */
export const ARCH_CURVE = [
${curve}
];

export const ARCH = {
  id: ${JSON.stringify(a.id)},
  name: ${JSON.stringify(a.name)},
  cellMetres: CELL_METRES,
  height: ARCH_HEIGHT,
  span: ARCH_SPAN,
  legSize: LEG_SIZE,
  legs: LEGS,
  curve: ARCH_CURVE,
};
`;
}

function emitJson(a) {
  const m = a.cellMetres;
  return (
    JSON.stringify(
      {
        $comment:
          'GENERATED by rocketman/tools/build-arch.mjs — do not edit. Cell coordinates ' +
          'use +x along the span, origin at the arch centre on the ground. Metre ' +
          'coordinates use x along the span and y up, for Unity.',
        id: a.id,
        name: a.name,
        cellMetres: m,
        heightCells: a.height,
        heightMetres: round(a.height * m),
        spanCells: a.span,
        spanMetres: round(a.span * m),
        leg: {
          footprintCells: { x: a.legSize[0], z: a.legSize[1] },
          footprintMetres: { x: round(a.legSize[0] * m), z: round(a.legSize[1] * m) },
          centresMetres: a.legs.map(([x, z]) => ({ x: round(x * m), y: 0, z: round(z * m) })),
        },
        curveCells: a.curve.map(([x, h]) => ({ x, height: h })),
        curveMetres: a.curve.map(([x, h]) => ({ x: round(x * m), y: round(h * m), z: 0 })),
      },
      null,
      2
    ) + '\n'
  );
}

/* ------------------------------------------------------------------ main -- */

const here = (rel) => fileURLToPath(new URL(rel, import.meta.url));

if (process.argv[1] === here('build-arch.mjs')) {
  const arch = buildArch();
  writeFileSync(here('../engine/arch.js'), emitModule(arch));
  writeFileSync(here('../arch.json'), emitJson(arch));
  const m = PARAMS.cellMetres;
  console.log(
    `arch: ${PARAMS.height} cells tall (${PARAMS.height * m}m, ` +
      `~${Math.round(PARAMS.height * m * 3.28084)}ft), span ${PARAMS.span} cells ` +
      `(${PARAMS.span * m}m), ${arch.curve.length} curve points`
  );
  console.log('wrote engine/arch.js and arch.json');
}
