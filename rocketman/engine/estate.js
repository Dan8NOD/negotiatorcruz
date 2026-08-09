/**
 * The castle estate's resolved geometry. GENERATED — do not edit by hand.
 *
 * Every coordinate here was produced by `tools/build-estate.mjs`; change the
 * parameters there and re-run `npm run rocketman:estate`.
 *
 * The coordinates are baked as literals rather than computed for the reason
 * `numeric.js` gives at length: a spiral needs sin and cos, those are
 * implementation-approximated, and an engine that computes its own map geometry
 * would generate subtly different terrain under V8, JavaScriptCore and Swift.
 * A decimal literal round-trips exactly in all three. So the trig happens once,
 * offline, and the engine only ever reads coordinates.
 *
 * Units are cells. Origin is the hill's centre, +x east and +y south.
 */

/** Metres per cell, for the 3D export only. The game never reads this. */
export const CELL_METRES = 8;

/** Rings of the hill, measured from the origin. `rims` are bands of cliff. */
export const HILL = {
  plateau: 7,
  outer: 12,
  rims: [9.5, 12],
};

/**
 * What stands on the hill.
 *
 * `at` is the structure's **centre**, offset from the origin — not its corner.
 * Footprints are odd-sized where they need to centre exactly, and the map
 * generator converts to the top-left origin that `PROPS` placement expects.
 *
 * `height` is the same presentation-only elevation the props table uses — the
 * renderer offsets the roof by `height * CELL * 0.34` pixels to fake relief.
 * The keep's 13 is two Jump Jet leaps, and roughly 3.8x the nine-storey Tower
 * Block, which is what makes it read as a landmark rather than a big building.
 */
export const STRUCTURES = [
  { id: "keep", at: [0, 0], size: [5, 5], height: 13 },
  { id: "tower_nw", at: [-4, -4], size: [2, 2], height: 9 },
  { id: "tower_ne", at: [4, -4], size: [2, 2], height: 9 },
  { id: "tower_sw", at: [-4, 4], size: [2, 2], height: 9 },
  { id: "tower_se", at: [4, 4], size: [2, 2], height: 9 },
  { id: "gatehouse", at: [0, 7], size: [3, 2], height: 4 },
];

/**
 * The approach road, as a polyline climbing the hill to the gatehouse.
 *
 * Consecutive points are close enough together that paving straight segments
 * between them reads as a curve, so the map generator can reuse `paveLine`
 * rather than growing a second rasteriser. A 3D importer should treat the same
 * points as spline control points instead.
 *
 * The last point is the gatehouse door, not an approximation of it — the
 * spiral is sampled backwards from the gate for exactly that reason.
 */
export const ROAD_LANES = 2;

export const ROAD_APPROACH = [15, 0];

export const ROAD_POINTS = [
  [15, 0],
  [14.828252, 1.460455],
  [14.515622, 2.887337],
  [14.067023, 4.267185],
  [13.488641, 5.587178],
  [12.787858, 6.835253],
  [11.973162, 8.000211],
  [11.054049, 9.071824],
  [10.040916, 10.040916],
  [8.944945, 10.899447],
  [7.777983, 11.640575],
  [6.552415, 12.258706],
  [5.281031, 12.749538],
  [3.9769, 13.110083],
  [2.653228, 13.33868],
  [1.323231, 13.434994],
  [0, 13.4],
  [-1.303628, 13.235957],
  [-2.575192, 12.946366],
  [-3.802729, 12.535918],
  [-4.974885, 12.010434],
  [-6.081018, 11.376784],
  [-7.111299, 10.642811],
  [-8.056795, 9.817233],
  [-8.909545, 8.909545],
  [-9.662631, 7.929916],
  [-10.310223, 6.889071],
  [-10.847632, 5.79818],
  [-11.27133, 4.668738],
  [-11.578978, 3.512445],
  [-11.769423, 2.341084],
  [-11.842698, 1.166404],
  [-11.8, 0],
  [-11.643661, -1.146801],
  [-11.377109, -2.263048],
  [-11.004814, -3.338274],
  [-10.532227, -4.362591],
  [-9.96571, -5.326783],
  [-9.31246, -6.222387],
  [-8.580416, -7.041765],
  [-7.778175, -7.778175],
  [-6.914887, -8.425814],
  [-6.000159, -8.979872],
  [-5.043945, -9.436558],
  [-4.056444, -9.793123],
  [-3.047989, -10.047874],
  [-2.028939, -10.200167],
  [-1.009577, -10.250403],
  [0, -10.2],
  [0.989973, -10.051366],
  [1.950903, -9.807853],
  [2.873818, -9.473709],
  [3.750298, -9.054019],
  [4.572548, -8.554636],
  [5.333474, -7.982108],
  [6.026736, -7.343599],
  [6.646804, -6.646804],
  [7.188997, -5.899858],
  [7.64952, -5.111246],
  [8.025484, -4.28971],
  [8.314916, -3.444151],
  [8.516769, -2.583534],
  [8.63091, -1.716795],
  [8.658107, -0.852749],
  [8.6, 0],
  [8.45907, 0.833146],
  [8.238596, 1.638759],
  [7.942605, 2.409363],
  [7.575812, 3.138004],
  [7.143562, 3.818314],
  [6.651757, 4.444562],
  [6.106783, 5.011707],
  [5.515433, 5.515433],
  [4.884828, 5.95218],
  [4.222334, 6.319169],
  [3.535476, 6.614409],
  [2.831857, 6.836709],
  [2.119078, 6.985664],
  [1.40465, 7.061654],
  [0.695922, 7.065812],
  [0, 7],
];

/** Everything above, in the shape the exporter and the tests both want. */
export const CASTLE_ESTATE = {
  id: "castle",
  name: "Hillcrest",
  cellMetres: CELL_METRES,
  hill: HILL,
  structures: STRUCTURES,
  road: { lanes: ROAD_LANES, approach: ROAD_APPROACH, points: ROAD_POINTS },
};
