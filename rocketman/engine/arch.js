/**
 * The Arch's resolved geometry. GENERATED — do not edit by hand.
 *
 * Produced by `tools/build-arch.mjs`; change the parameters there and re-run
 * `npm run rocketman:arch`.
 *
 * Baked as literals rather than computed because a catenary needs `cosh`, and
 * `numeric.js` explains why the engine may not call it: implementation-
 * approximated functions differ between JavaScript engines and the C library a
 * Swift build links against, and map geometry feeds pathfinding.
 *
 * Units are cells. Origin is the arch's centre, on the ground, +x along the
 * span. The curve's second value is height above ground, not a y coordinate —
 * the arch stands *up* out of the map, which has no third axis.
 */

/** Metres per cell, for the 3D export only. The game never reads this. */
export const CELL_METRES = 8;

/** Crown height and foot-to-foot span, in cells. */
export const ARCH_HEIGHT = 30;
export const ARCH_SPAN = 30;

/** Footprint of each leg. The legs are solid; the span overhead is not. */
export const LEG_SIZE = [4, 4];

/** Leg centres as offsets from the arch's centre. */
export const LEGS = [
  [-15, 0],
  [15, 0],
];

/**
 * The centreline, as `[offsetFromCentre, heightAboveGround]` in cells.
 *
 * Symmetric about x = 0 by construction, which matters more than it looks: the
 * map generator mirrors everything 180°, and a shape that is its own mirror
 * image can be drawn at the twin position without swapping its halves.
 */
export const ARCH_CURVE = [
  [-15, 0],
  [-14.75, 1.616233],
  [-14.5, 3.15322],
  [-14.25, 4.614802],
  [-14, 6.004636],
  [-13.75, 7.326195],
  [-13.5, 8.582786],
  [-13.25, 9.777549],
  [-13, 10.913473],
  [-12.75, 11.993398],
  [-12.5, 13.020024],
  [-12.25, 13.995918],
  [-12, 14.923521],
  [-11.75, 15.805152],
  [-11.5, 16.643016],
  [-11.25, 17.439207],
  [-11, 18.195717],
  [-10.75, 18.914437],
  [-10.5, 19.597165],
  [-10.25, 20.245607],
  [-10, 20.861385],
  [-9.75, 21.446039],
  [-9.5, 22.001031],
  [-9.25, 22.527749],
  [-9, 23.027509],
  [-8.75, 23.501561],
  [-8.5, 23.951091],
  [-8.25, 24.377222],
  [-8, 24.781021],
  [-7.75, 25.163497],
  [-7.5, 25.525606],
  [-7.25, 25.868254],
  [-7, 26.192298],
  [-6.75, 26.498548],
  [-6.5, 26.787769],
  [-6.25, 27.060685],
  [-6, 27.317978],
  [-5.75, 27.560292],
  [-5.5, 27.788233],
  [-5.25, 28.00237],
  [-5, 28.203239],
  [-4.75, 28.391343],
  [-4.5, 28.567151],
  [-4.25, 28.731103],
  [-4, 28.88361],
  [-3.75, 29.025052],
  [-3.5, 29.155783],
  [-3.25, 29.276131],
  [-3, 29.386396],
  [-2.75, 29.486853],
  [-2.5, 29.577755],
  [-2.25, 29.659327],
  [-2, 29.731775],
  [-1.75, 29.79528],
  [-1.5, 29.849999],
  [-1.25, 29.896071],
  [-1, 29.93361],
  [-0.75, 29.96271],
  [-0.5, 29.983444],
  [-0.25, 29.995864],
  [0, 30],
  [0.25, 29.995864],
  [0.5, 29.983444],
  [0.75, 29.96271],
  [1, 29.93361],
  [1.25, 29.896071],
  [1.5, 29.849999],
  [1.75, 29.79528],
  [2, 29.731775],
  [2.25, 29.659327],
  [2.5, 29.577755],
  [2.75, 29.486853],
  [3, 29.386396],
  [3.25, 29.276131],
  [3.5, 29.155783],
  [3.75, 29.025052],
  [4, 28.88361],
  [4.25, 28.731103],
  [4.5, 28.567151],
  [4.75, 28.391343],
  [5, 28.203239],
  [5.25, 28.00237],
  [5.5, 27.788233],
  [5.75, 27.560292],
  [6, 27.317978],
  [6.25, 27.060685],
  [6.5, 26.787769],
  [6.75, 26.498548],
  [7, 26.192298],
  [7.25, 25.868254],
  [7.5, 25.525606],
  [7.75, 25.163497],
  [8, 24.781021],
  [8.25, 24.377222],
  [8.5, 23.951091],
  [8.75, 23.501561],
  [9, 23.027509],
  [9.25, 22.527749],
  [9.5, 22.001031],
  [9.75, 21.446039],
  [10, 20.861385],
  [10.25, 20.245607],
  [10.5, 19.597165],
  [10.75, 18.914437],
  [11, 18.195717],
  [11.25, 17.439207],
  [11.5, 16.643016],
  [11.75, 15.805152],
  [12, 14.923521],
  [12.25, 13.995918],
  [12.5, 13.020024],
  [12.75, 11.993398],
  [13, 10.913473],
  [13.25, 9.777549],
  [13.5, 8.582786],
  [13.75, 7.326195],
  [14, 6.004636],
  [14.25, 4.614802],
  [14.5, 3.15322],
  [14.75, 1.616233],
  [15, 0],
];

export const ARCH = {
  id: "arch",
  name: "The Arch",
  cellMetres: CELL_METRES,
  height: ARCH_HEIGHT,
  span: ARCH_SPAN,
  legSize: LEG_SIZE,
  legs: LEGS,
  curve: ARCH_CURVE,
};
