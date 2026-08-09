# Rocke — Battlefield Districts Design Spec

**Status:** design, ready to implement. This document is a spec for the
*authored* battlefield in `Dan8NOD/Rocke` — the scene that
`Assets/SourceFiles/Scripts/Editor/BuildPrototypeScene.cs` builds. It is
written to be dropped into the Rocke repo alongside the other `*_SPEC.md`
files and handed to an implementing agent. It changes **map content only**:
no new gameplay systems, no runtime generation, no terrain heightfield.

**What was asked for:** structures of different heights and sizes, a
factory, a block of residential homes — "mix it up; it's a test ground for
different environments for combat purposes." The map being large, with room
for several distinct looks, is the advantage to lean into.

---

## 0. Context that must not be relearned the hard way

A runtime map generator (noise terrain, chunked meshes, prop scattering)
was recently **removed** from this game (`git log`: "Remove the
generated-map system; restore the game's own battlefield"). It came from a
different, 2D project and it replaced the authored battlefield at the call
level — `BuildGround` and its siblings stopped running — which broke the
game. The lesson is structural, so it is rule one of this spec:

> **Rule 1 — Everything here is additive to `BuildPrototypeScene.cs`.**
> Nothing replaces `BuildGround`, `BuildCorridorWalls`, `BuildStructures`,
> the bake, or any existing call. New districts are new hand-authored
> placement tables and new builder functions called from `Build()` in the
> existing sequence. If an implementation step seems to require rerouting
> an existing call through new machinery, stop — that is the exact failure
> that was just reverted. `MAP_GENERATION_CONTRACT.md` and the `Map/`
> scripts are **gone from the working tree**; do not resurrect them.

Rules two through six are the codebase's own, restated because every one
has already bitten this project once:

2. **All static geometry before `BakeNavMesh()`.** A `NavMeshAgent` attaches
   to the mesh exactly once, in its own `OnEnable`. Anything built after
   the bake either isn't in the mesh (units path straight through it and
   grind on the collider — looks exactly like broken pathfinding) or never
   gets walked on.
3. **Measure prefabs, never trust authored size.** Instantiate a probe,
   read `CalculateRendererBounds`, destroy it, derive the tiling/scale —
   the pattern the corridor walls, base perimeters, hangar and roads all
   follow. Synty and Quaternius assets ship at arbitrary scales (the
   crossbow-covering-the-character bug).
4. **The magenta hazard.** Several Synty materials — confirmed for
   PolygonGeneric's ground set and the character packs — ride a Shader
   Graph this project's URP version does not resolve, and render magenta.
   Every prefab kind newly introduced by this spec gets a material audit
   (§8, step 2) before it ships; the fallback is a shared URP-Lit repaint
   via the existing `MetalMaterial` helper, exactly as `BuildRoboMarinePrefab`
   does for character meshes.
5. **Destructible vs. permanent is a NavMesh decision.** Permanent
   structures are `NavigationStatic` (baked). Destructible barriers are
   **not** baked — they block via a carving `NavMeshObstacle`
   (`MakeWallDestructible`) so the hole closes when they die and units
   path through the breach.
6. **No EA anything** — no names, numbers, or layouts traceable to
   Generals. District names below are original.

Coordinate convention used throughout: **hand-placed units**, the same
space as the existing `placements` table — world metres = hand units ×
`SpreadScale` (2.5). The ground plane is 1400 × 1400 m (±700 m), so the
usable hand-unit range is roughly ±280. The fortified line runs east–west
along z = 0; attackers approach from −z, defenders hold +z. Corner HQs sit
at (±275, ±275); the hangar landmark at (−200, −200).

---

## 1. What the map is today, and what it lacks

Current inventory (all from `BuildPrototypeScene.cs`):

- A flat 1400 m prairie plane with a fortified wall + gate chokepoint at
  the centre, ramparts behind it.
- ~28 scattered Synty BattleRoyale buildings — houses, small buildings,
  wooden shacks, one warehouse kind — **all 1–2 storeys**, spread singly so
  no two form a street.
- Grey-box primitives: four ramp watchtowers, three bridges, one plaza.
- The hangar (SW corner): the one composite, enterable, tall-interior
  structure, and currently the only place the Jet Pack ceiling clamp fires.
- Rock clusters, treelines, sandbag positions, tunnels, random
  indestructible barriers, four straight road lanes, ground-variety quads.

What it lacks, measured against the reference look (War Robots-style
industrial map) and the request:

- **Silhouette variety.** Nothing between a 2-storey house and nothing.
  No mid-rise, no tower, no smokestack, no crane. The skyline is flat, so
  the map reads the same from every direction and the Jet Pack's 30.5 m
  hover never has anything at its own altitude.
- **Density variety.** Buildings are scattered evenly; there is no
  district anywhere — no street you fight down, no yard you clear
  building-to-building. Every engagement is "one structure in open grass."
- **A factory.** No industrial anything: no stack, tanks, pipes, fences,
  yard.
- **A residential block.** Houses exist but never adjacent; there is no
  neighbourhood.

The empty mid-ring — roughly 340 m to 640 m from the centre, between the
existing scattered content and the corner HQs — is where all of this fits
without touching anything that exists.

---

## 2. The design in one paragraph

Four **districts**, one per compass direction, each a deliberately
different combat environment sitting in the empty mid-ring, each built
from packs already imported (PolygonBattleRoyale, PolygonConstruction,
PolygonGeneric). Together with the existing centre chokepoint, hangar,
and open prairie they make the map a sampler of fights: **street fighting**
(residential block, west), **industrial yard fighting** (factory quarter,
east), **vertical/LOS fighting** (high-rise strip, north), **multi-level
open-frame fighting** (construction site, south-east). Distinct
silhouettes at four heights — house, hall, tower, smokestack — make every
part of the map recognisable at a glance and give the minimap and the Jet
Pack real geography.

Layout (top-down, hand units; not to scale):

```
                 N  (defender side, +z)
        ┌──────────────────────────────────────┐
        │ HQ-B                          HQ-B   │  275
        │        THE STEPS (high-rise)         │  ~150
        │           rally · tunnels            │
        │ MILLBROOK                 IRONWORKS  │
        │ TERRACES     ═══╦═══      (factory)  │  ~0  (wall + gate)
        │ (residential)   ║                    │
        │           tunnels · spawn            │
        │ Hangar             GRAVELINE YARD    │  ~-150
        │ HQ-A               (construction)    │
        │                               HQ-A   │  -275
        └──────────────────────────────────────┘
      -275                                   275
```

Asymmetry is deliberate and safe: Rocke is currently hero-versus-waves,
not mirrored PvP (`MAP_GENERATION_CONTRACT.md` said the same of the
generator's starts). Districts are test environments first; if mirrored
multiplayer ever lands, mirroring districts is a placement-table edit.

**Spacing rule:** keep ≥ 60 hand units (150 m) of open ground between
district edges and between any district and existing content. Marines
carry 500 m rifles (`SpreadScale`'s own rationale); districts that bleed
into each other become one continuous firefight and stop reading as
distinct places.

---

## 3. District I — **Ironworks** (factory quarter, east)

*The look the reference screenshot asks for: stack, tanks, pipes, big
halls, fenced yard.* Centre **(150, 10)**, extent roughly 50 × 40 hand
units (125 × 100 m). Clear of the existing east-side scatter at (96, 30),
(118, 92), (124, −58).

### 3.1 The factory hall

The centrepiece, and the map's **second enterable building** (the hangar
is the first). Build it exactly the way `BuildHangar()` builds — measured
Base-kit pieces (`PolygonGeneric/Prefabs/Base/SM_Bld_Base_Wall_01`,
`_Pillar_01`, roof pieces) tiled at 2.5× scale, walls `NavigationStatic`,
a real roof slab with a real collider:

- Footprint **55 × 28 m**, eaves ~**14 m**, interior clear height ~**13 m**.
- **Two full-height doorways on opposite short ends** (drive-through, unlike
  the hangar's single door) — a tank column can enter one end and exit the
  other, so holding the hall means holding two doors. Doorway width ≥ 8 m
  (tank + margin).
- Interior: two rows of Base-kit pillars flanking a clear centre aisle;
  `SM_Prop_Generator_Large_01` ×2 and pallet stacks along the walls as
  interior cover (collider + `NavigationStatic`).
- The roof gives the Jet Pack its second ceiling-clamp environment: hover
  clamps to ~10.5 m inside (13 − 2.5 clearance), and the **MAX HEADROOM**
  achievement is earnable here, not just in the hangar.
- Factory-pattern function `BuildFactoryHall(Vector3 centre, float yaw)` —
  parameterised, because §6 wants nothing hard-coded twice.

### 3.2 The yard

Around the hall, inside a fence perimeter:

| Piece | Prefab (existing, imported) | Count | Role |
|---|---|---|---|
| Smokestack | `PolygonConstruction/Prefabs/Buildings/SM_Bld_SmokeStack_01` | 1 | **Tallest object on the map — scale to 45 m** (measure-then-scale). Navigation landmark visible from everywhere. Indestructible (no `Health`), `NavigationStatic`. |
| Water tower | `SM_Bld_WaterTower_01` | 1 | Second vertical accent, scale to ~20 m. |
| Storage tanks | `SM_Bld_WaterTank_01/02/03` | 3–4 | The reference image's silo cluster. ~8–10 m. Hard cover; destructible via the standard volume rule (§7). |
| Pipe runs | `SM_Prop_Pipe_Concrete_Huge_01/02/03` + `_Corner_01` | 8–10 segments | Two runs of hull-height (~2.5 m) hard cover crossing the yard — infantry fights over them, tanks and the hero shoot over them. Collider + `NavigationStatic`. |
| Generators, pallets, barrel stacks | `SM_Prop_Generator_01`, `SM_Prop_PalletStack_01/02`, BattleRoyale barrel props | ~12 | Scatter cover. Collider + static; **no** `CoverProvider` (that stays with the sandbag lines). |
| Warehouses | `PolygonBattleRoyale .. SM_Bld_Warehouse_01` | 2 | Garrisonable anchors flanking the hall — added to the **existing `BuildGarrisonHouses` placements table** (role 0) so they inherit health, armour, ladder, regen and health-bar wiring for free. |
| Perimeter fence | `SM_Prop_Fence_MetalSheet_01/02/03` | as tiled | Ring the yard, **two gate gaps** (≥ 10 m) on opposite sides. Fence segments use the `MakeWallDestructible` pattern (carving obstacle, low health, bullet multiplier 0.08 / explosive 3): blowing a third way into the yard is a real tactic, and the breach must open in the NavMesh. |

Why this shape: the yard is one enclosed space with exactly two honest
entrances plus as many as you're willing to blast — a siege-in-miniature
that tests breach mechanics, interior fighting, and the ceiling clamp in
one place.

---

## 4. District II — **Millbrook Terraces** (residential block, west)

*The requested "block of residential homes" — the map's first actual
streets.* Centre **(−150, 20)**, extent ~44 × 44 hand units (110 × 110 m).
Clear of the west scatter at (−96, 62), (−78, −12), (−116, 96), (−128, −52).

### 4.1 Street grid

A 3 × 3 grid of house lots on a ~36 m pitch, streets between them:

- **Streets** from the BattleRoyale road set —
  `SM_Env_Road_Straight_01/02/03`, `_Corner_01`, `_Cross_01`, plus one or
  two `_Damaged_` variants for wear. Same treatment as `BuildRoads()`:
  measured tiling, +0.02 m Y offset against z-fighting, **colliders
  stripped** (roads must never block shots or movement). The existing
  `BuildRoads()` lanes are untouched; one new east–west connector road may
  join the block to the nearest existing lane so the district doesn't
  float in grass.
- **Twelve houses** on the eight outer lots and centre — the full
  BattleRoyale residential range, no two identical neighbours:
  `SM_Bld_House_01/02/03`, `SM_Bld_House_Glass_01` (first use in the
  game), `SM_Bld_SmallBuilding_01/02/03`, one `SM_Bld_WoodenShack_01`.
  Yaw each house to face its street (0/90/180/270 ± a few degrees), the
  way real houses sit on real lots — the current map's arbitrary yaws are
  half of why it reads as scattered rather than settled.
- **All twelve go into the `BuildGarrisonHouses` placements table**
  (role 0). That single decision buys everything: volume-derived health,
  the two-drums armour rule, roof ladders + NavMeshLinks, regeneration,
  health bars, and `GarrisonPopulator` treating the block as prime
  garrison real estate. A populated Millbrook is the game's
  house-to-house clearing exercise.
- **Garden walls** between back yards: `SM_Bld_Retainer_Wall_Stone_01`
  runs (Construction pack), waist-to-chest height, `MakeWallDestructible`
  — infantry funnel through gaps until somebody makes a new one.
- Dressing: bushes (`SM_Gen_Env_Bush_*`), the existing tree-cluster
  pattern at the block's edges, a couple of BattleRoyale street props.
  Decoration gets `StripColliders` + batching-static, per the standing
  rule.

Why this shape: nine lots is the smallest arrangement that produces real
streets (two intersections, enclosed back yards) while staying inside one
minimap glance. Rooftop garrisons at house height (~6 m) versus the
hero's shoulder guns' −55° depression is exactly the close-quarters test
the flat map never provides.

---

## 5. District III — **The Steps** (high-rise strip, north)

*Structures of genuinely different heights — the skyline.* Centre
**(60, 150)**, a strip ~70 × 24 hand units (175 × 60 m) running east–west,
offset east so the centre axis (rally point, north tunnel at (0, 62))
stays clear.

- **Five towers** from `PolygonGeneric/Prefabs/Building/SM_Gen_Bld_Background_01..11`
  (pick five distinct silhouettes), **scaled by measurement to a stepped
  height sequence: 12 m, 18 m, 24 m, 30 m, 38 m** — ascending west to
  east, hence the name.
- These are *background* meshes: single-sided detail, no interiors, and
  possibly **no colliders as authored — `EnsureCollider` each one**, and
  audit their materials first (they are PolygonGeneric, the pack with the
  confirmed magenta shader). They are solid LOS blocks, not enterable.
- **Not garrisonable** and **not in the garrison table** — no windows or
  door geometry to justify it. Give each a plain `Health` + `Armor` via
  the same volume formula but clamped at `buildingHealthMax`, so they are
  destructible in principle without becoming bullet-sponge objectives.
- No roof ladders. The roofs belong to the Jet Pack: hover height is
  30.5 m above *detected ground or platform* and terrain-following, so
  drifting over the strip climbs the steps tower by tower, and the 38 m
  roof is a landable perch with the whole map below it (press-to-land on
  the roof, then B to drop the lock, exactly the roof-to-roof chain the
  hydraulic-touchdown note in `MECHANICS.md` celebrates). Enemy marines'
  500 m rifles still reach it — a perch, not a safe room.
- Alleys between towers are 8–12 m — wide enough for units, tight enough
  that a tank in an alley is committed. Ground floor gets a handful of
  BattleRoyale barrier/dumpster props as alley cover.

Why this shape: the strip finally puts geometry *at* and *above* the Jet
Pack's altitude, creates the map's only true LOS canyons for the 600 m
gun range to matter in, and the stepped sequence is readable teaching —
the player learns "each roof is a rung" by looking at it.

---

## 6. District IV — **Graveline Yard** (construction site, south-east)

*The mixed-height, multi-level open-frame fight — and the district that
uses the Construction pack for what it is.* Centre **(90, −150)**, extent
~40 × 40 hand units (100 × 100 m). East of the attacker spawn axis so
spawn rows at x ≈ 0 stay clear.

- **The unfinished building**: a 3-deck concrete skeleton from the
  Construction kit — `SM_Bld_Concrete_Pillar_01..03` +
  `SM_Bld_Concrete_Floor_01..04` (and `ConcreteRebar` variants on the top
  deck, reading as "still being poured"). Footprint ~30 × 20 m, decks at
  ~4.5 m intervals (measure the pillar, derive the deck spacing — rule 3).
  **Open on all sides** — the anti-hangar: full sightlines through it,
  cover only at pillars.
  - Deck access: two of the existing grey-box `BuildRamp` runs (they are
    already NavMesh-proven) placed as formwork ramps, ground → deck 1 →
    deck 2; deck 3 is Jet-Pack-only. Infantry fighting up an open
    multi-storey frame is a scenario nothing else on the map produces.
  - The whole frame is `NavigationStatic`, indestructible (bare concrete
    frame; keeping it standing keeps the ramps meaningful).
- **The crane** — `SM_Bld_Crane_01` (the building crane, not the vehicle),
  scaled to ~30 m: the south's landmark, answering the north's stack.
  Indestructible, `NavigationStatic`.
- **Vehicles as cover**: `SM_Veh_Bulldozer_01`, `SM_Veh_Excavator_01`,
  `SM_Veh_Truck_01_ConcreteMixer`, `SM_Veh_Roller_01` — parked hull-height
  hard cover, collider + `NavigationStatic`, colliders **kept** (unlike
  decoration). No `Health`: wrecks don't need hit points.
- **Portable offices** (`SM_Bld_Portable_Office_01/02`) ×2 → the garrison
  table (role 0): small, fragile, garrisonable — the site's only
  defensible interiors.
- Dressing: dirt piles (`SM_Env_Dirt_Pile_*`), brick/pipe stacks, wire
  fence (`SM_Prop_Fence_Wire_01`) on two sides only — wire fence is
  **decoration** (strip colliders); the site reads open by design.
- Ground: reuse `BuildGroundVariety`'s dirt material for two large
  patches under the site, so the district sits on brown, not prairie.

---

## 7. Cross-cutting rules

### 7.1 Height taxonomy (the "different heights and sizes" contract)

Every structure the map places now falls in a named tier; anything new
should too. Heights are targets for measure-then-scale, not trusted
authored sizes.

| Tier | Height | On this map |
|---|---|---|
| Ground cover | 1–3 m | barriers, pipes, vehicles, garden walls |
| Low | 4–7 m | houses, shacks, portable offices |
| Mid | 8–14 m | warehouses, tanks (storage), factory-hall eaves, plaza/towers (grey-box) |
| Tall | 15–28 m | water tower, Steps towers 1–3, construction frame + crane deck |
| Landmark | 30–45 m | Steps towers 4–5 (30, 38 m), crane (~30 m), **smokestack (45 m, unique tallest)** |

Jet Pack interactions this taxonomy is tuned around (numbers from
`MECHANICS.md` / `HeroTuning`): hover = 30.5 m above detected platform,
terrain-following; ceiling clamp = detected ceiling − 2.5 m; airborne =
−50 % damage taken, 4× rocket damage. Low/mid tiers are flown *over*;
tall tiers are climbed step-wise; landmark tier is the perch-and-survey
tier; the two enclosed interiors (hangar, factory hall) are the clamp
environments.

### 7.2 One-glance placement summary (hand units, × 2.5 = metres)

| District | Anchor | Extent (hu) | New builder function |
|---|---|---|---|
| Ironworks | (150, 10) | 50 × 40 | `BuildIronworks()` (calls `BuildFactoryHall`) |
| Millbrook Terraces | (−150, 20) | 44 × 44 | `BuildResidentialBlock()` |
| The Steps | (60, 150) | 70 × 24 | `BuildHighriseStrip()` |
| Graveline Yard | (90, −150) | 40 × 40 | `BuildConstructionYard()` |

Garrisonable structures in each district do **not** live in these
functions — they are rows appended to the existing `BuildGarrisonHouses`
placements table (all role 0), which is what wires them. The district
functions build everything else.

### 7.3 `Build()` call-site ordering

Insert the four district calls in `Build()` **after
`BuildDefensivePositions()` and before `BuildStructures()`** — with all
other static geometry, safely before `BakeNavMesh()`. Then:

- Append each district's garrisonable rows to the `BuildGarrisonHouses`
  table (they build when it runs, no ordering change).
- Add each district anchor to the `keepClear` list — random barriers must
  not spawn inside a district, and reachability then **verifies every
  district is connected** to the rest of the map at bake time, loudly,
  the same way the hangar doorway is verified today.
- Add Millbrook's two intersection centres to `keepClear` as well:
  streets stay open.

### 7.4 Wiring recap (which pattern applies to what)

| Kind | Pattern | Examples |
|---|---|---|
| Garrisonable building | row in `BuildGarrisonHouses` table | houses, warehouses, portable offices |
| Composite enterable | `BuildHangar` pattern (measure, tile, static, real roof) | factory hall |
| Permanent hard cover / landmark | `EnsureCollider` + `MarkNavigationStatic` + `SetBatchingStatic` | tanks, pipes, vehicles, towers, stack, crane, frame |
| Breachable barrier | `MakeWallDestructible` (carving obstacle, never baked) | yard fence, garden walls |
| Decoration | `StripColliders` + `SetBatchingStatic` | bushes, wire fence, roads, dressing props |

### 7.5 Budget

Rough new-instance count: Ironworks ~45, Millbrook ~55 (houses + road
segments + walls), Steps ~15, Graveline ~40 — **~155 placed objects**, of
the same kinds and cost class as the several hundred already in the
scene, all batching-static. Synty packs ship no LODs (known); if
on-device profiling (bootstrap step 3) shows prop count as the
bottleneck, the lever is LOD1s for the ~10 kinds used in bulk here
(houses, fence, pipes, road) — noted, not required now.

---

## 8. Implementation order and verification

Do it in this order; each step leaves the game playable.

1. **Millbrook Terraces** — pure placement-table work plus roads; proves
   the street-grid pattern with zero new construction code.
2. **Material audit** for every prefab kind this spec introduces
   (Background towers, SmokeStack, WaterTower/Tanks, Crane, concrete kit,
   vehicles, fences, road set): instantiate in editor, look for magenta /
   error shader. Any failure → shared URP-Lit repaint via `MetalMaterial`
   (one material per family so they batch), as `BuildRoboMarinePrefab`
   already does. Do this **before** the districts that depend on the risky
   packs (Steps, Graveline are the exposure).
3. **Ironworks** — factory hall first (it's the hangar pattern with two
   doors), then yard + fence.
4. **The Steps**, then **Graveline Yard**.
5. After each district: **Rocke > Build Chokepoint Prototype Scene**, then
   check —
   - Console: zero missing-prefab warnings, bake completes, reachability
     check passes for every `keepClear` point (districts included).
   - Play: units path through the district (order a squad across it);
     `GarrisonPopulator` fills the new buildings; roof ladders climbable.
   - Ironworks: Jet Pack inside the hall clamps visibly low; MAX HEADROOM
     achievable; fence breach opens a route units actually take.
   - Steps: hover-climb the steps west→east, land on the 38 m roof;
     no magenta anywhere on the skyline.
   - Graveline: infantry ramp up to deck 2; hero lands on deck 3.
   - Minimap: four districts read as four distinct masses.
6. **Device pass** (bootstrap step 3 discipline): frame rate on iPad with
   the full unit cap fighting inside Millbrook and Ironworks — the two
   dense districts.

Acceptance = the checklist in step 5 fully green plus step 6 within
frame budget.

---

## 9. Explicitly out of scope

- Any runtime/procedural generation, `MapGrid`, or resurrection of the
  removed `Map/` workstream — see Rule 1.
- Terrain elevation/heightfield changes; the plane stays flat, height
  comes from structures.
- New gameplay systems (capture points, district ownership, destruction
  physics). Districts use only components that already exist.
- Art authoring: no new meshes, no new packs; everything above uses the
  four imported Synty packs. Silhouette gaps that need bought/made art
  (a real factory kit, a proper castle) stay in the known-gaps list.
- Rebalancing tuning assets. The volume-derived health rule and the
  two-drums rule apply to new buildings *as written*; if a 38 m tower's
  clamped health feels wrong in play, that is a tuning-asset conversation
  for later, not this change.
