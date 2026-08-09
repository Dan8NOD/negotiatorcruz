# Hillcrest — the castle estate

A modern castle on a terraced hill, with a switchback road climbing to its
gatehouse. It exists as **one layout spec feeding two renderers**: the game's
2D canvas, and a 3D scene you assemble in Unity from your own assets.

```
tools/build-estate.mjs          the parameters + the geometry
    ├─→ engine/estate.js        baked literals, read by the game
    └─→ estate.json             plain data, read by a Unity importer
```

Change the design by editing `PARAMS` at the top of `tools/build-estate.mjs`
and running `npm run rocketman:estate`. Both artifacts are generated — editing
either by hand loses the change on the next run.

---

## Why the geometry is baked rather than computed

A spiral needs `sin` and `cos`, and `engine/numeric.js` explains at length why
the engine may not call them: ECMA-262 marks them implementation-approximated,
so V8, JavaScriptCore, and the C library a Swift build links against are each
free to return a different answer within tolerance. Map geometry feeds terrain,
terrain feeds pathfinding, and two engines that disagree about where a road went
do not agree about the match. A test in `test/sim.test.js` enforces this by
scanning `engine/` for raw trig.

So the trig happens once, offline, and the result is written as decimal
literals — decimal-to-double conversion *is* correctly rounded everywhere, so a
literal round-trips exactly where a `cos()` call would not. This is the same
approach `RING_COS` in `numeric.js` already takes, for the same reason.

The useful side effect is that the geometry is already resolved to plain
numbers, which is exactly what a 3D importer wants.

---

## The layout

| Piece | Footprint (cells) | Height (cells) | Height (m) |
|---|---|---|---|
| Keep | 5 × 5 | 13 | 104 |
| Corner towers (×4) | 2 × 2 | 9 | 72 |
| Gatehouse | 3 × 2 | 4 | 32 |

The hill is concentric rings from the origin: a flat `plateau` at radius 5, the
hillside out to `outer` at 11, and bands of cliff at the `rims` (8 and 11).

**The cliffs are load-bearing, not decoration.** A hill that is merely textured
gets walked over from any direction and the road becomes scenery. Ringed by
cliff, the hill can only be climbed where the road cuts through — which is what
makes the switchbacks a tactical fact. It is the same ridge-and-ramp idiom the
rest of the map generator already uses.

### Height 13, and where it comes from

The brief was "two hero robot jet jumps." There are two leap abilities in
`content.js` and they answer very differently:

- `jumpjet` — **"Jump Jets"**, 6.5 cells. Two is **13**.
- `skyfall` — the hero ability, 36 cells, described in its own comment as
  *"half a standard 72-cell map."* Two of those is the whole battlefield, which
  is a distance, not a height.

Thirteen cells is deliberately without precedent in this game: the tallest
existing prop is the Relay Mast at 4.2, and the nine-storey Tower Block is 3.4.
The keep is about 3.8× the tower block — roughly a thirty-storey silhouette,
meant to be the thing you navigate by from anywhere on the map.

---

## Importing into Unity

### Coordinates

The game is 2D top-down: **+x east, +y south**, measured in cells. Unity is
3D Y-up. The conversion is a single axis swap:

```
unity.x =  cell.x * cellMetres
unity.y =  height * cellMetres      // up
unity.z =  cell.y * cellMetres
```

`estate.json` carries **both** — every length appears once in cells and once in
metres, under `metres:` keys already converted to Unity's x/z ground plane. An
importer never has to know this game's cell size to place a mesh.

`cellMetres` is 8, derived from the props rather than picked: a `house` prop is
one cell across and two storeys tall, and a two-storey house is about eight
metres wide. Override it in `PARAMS` if your asset library assumes a different
scale — everything downstream rescales.

### The road

`road.pointsMetres` is 61 samples along the spiral, ordered **outer approach →
gatehouse**. The last point is the gatehouse door exactly, not an approximation
of it: the spiral is sampled backwards from the gate for that reason.

- **In Unity**, feed the points to a spline (Splines package, or any road tool)
  as control points and let it interpolate. `road.widthMetres` is 16.
- **In the canvas game**, the same points are paved as short straight segments,
  which reads as a curve at 24px per cell and lets the map generator reuse the
  existing `paveLine` rather than growing a second rasteriser.

Successive passes sit about 6.4 cells (51m) apart, which is wide enough to read
as separate switchbacks with hillside between them. Tightening `road.turns`
much past 1.5 merges them into a paved disc.

### Sourcing assets

Nothing here ships art — the spec is placement and scale only, so it composes
with whatever library you already own.

- **Keep and towers** — the silhouette does the work at this height. A modular
  wall/tower kit tiles vertically to 104m more convincingly than one hero mesh
  stretched to fit, and keeps the texel density even.
- **The four corner towers are one mesh, four times.** Instance them (GPU
  instancing or the SRP Batcher will collapse them) rather than importing four
  variants.
- **Terraces** — the rim radii are circles, so a radial mesh or a sculpted
  terrain with the rims as cliff bands both work. The rims are what the road
  cuts through; keep the cut aligned to the last few road points.
- **Road** — any spline-based road tool. The width is uniform.

### Performance on M-series iPads and A18

Both are far more capable than this scene needs; the practical ceilings are not
polygon count. In rough order of what actually bites on Apple's tile-based GPUs:

1. **Overdraw and fill rate.** Transparent layers stacked over each other —
   foliage cards, particle sheets, glow quads — cost far more than opaque
   geometry. This is usually the first thing to profile.
2. **Draw calls.** Batch aggressively; instance the repeated towers and any
   terrace or wall modules.
3. **Sustained thermals.** A scene that hits frame rate for thirty seconds may
   not hold it for ten minutes. Test a long session, not a short one, and treat
   120 Hz on an iPad Pro as a stretch target rather than the baseline.
4. **Texture memory.** Use ASTC compression and keep an eye on the total set —
   a large hero texture per module adds up faster than the meshes do.

Measure with Xcode's GPU frame capture rather than tuning blind; the bottleneck
on this hardware is rarely where a desktop instinct expects it.

---

## Regenerating

```bash
npm run rocketman:estate     # rewrites engine/estate.js and estate.json
npm run test:rocketman       # the spec invariants live in test/estate.test.js
```
