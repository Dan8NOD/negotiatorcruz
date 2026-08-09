/*
 * Terrain, map generation and pathfinding — the Swift half of engine/grid.js.
 *
 * Mirrors the JavaScript function for function, including RNG draw order:
 * the map fixture in Fixtures/map.json was captured by running the real
 * engine, so this only counts as correct when it reproduces that terrain,
 * resource and prop layout cell for cell on every fixture seed. Map
 * generation is the heaviest single consumer of the RNG anywhere in the
 * engine, so agreeing on a generated map is a much stronger statement than
 * agreeing on a raw stream — it means every draw happened in the same order.
 *
 * Generation is 180°-rotationally symmetric on purpose, same reasoning as the
 * JS: an RTS map that is not mirrored is a map where one player's expansion
 * is closer to the middle.
 */

#if canImport(Darwin)
import Darwin
#else
import Glibc
#endif

// MARK: - Terrain (grid's slice of engine/content.js)

/// Terrain classes. Raw value indexes into a map's terrain array, matching
/// the JS engine's Uint8Array of TERRAIN constants.
public enum Terrain: UInt8 {
    case ground = 0
    case rough = 1
    case cliff = 2
    case water = 3
    /// Tarmac. Appended rather than inserted, for the same reason the JS
    /// engine appended it: both sides read these as raw indices, and
    /// renumbering `ground` out from under a stored map would be a silent,
    /// map-wide corruption.
    case road = 4
}

/// Movement cost per terrain, and whether ground units may enter at all.
public struct TerrainInfo {
    public let passable: Bool
    public let cost: Double
}

/// Indexed by `Terrain.rawValue`, same order as engine/content.js TERRAIN_INFO.
public let terrainInfo: [TerrainInfo] = [
    TerrainInfo(passable: true, cost: 1.0),  // ground
    TerrainInfo(passable: true, cost: 1.7),  // rough
    TerrainInfo(passable: false, cost: .infinity),  // cliff
    TerrainInfo(passable: false, cost: .infinity),  // water
    TerrainInfo(passable: true, cost: 0.72),  // road
]

/// The cheapest step any ground unit can take, mirroring `MIN_TERRAIN_COST`.
///
/// Octile distance assumes one unit of cost per step, which was true while the
/// cheapest terrain cost exactly 1. Roads made it false, and a heuristic that
/// over-estimates stops A* returning shortest paths — it would route units
/// around the very network they were built to use.
public let minTerrainCost: Double = terrainInfo.reduce(Double.infinity) {
    $1.passable && $1.cost < $0 ? $1.cost : $0
}

/// Footprint sizes for the destructible scenery placed by `createMap`. Only
/// `size` from engine/content.js PROPS — the rest (hp, armor, death
/// explosions) belongs to entities/combat and has no reader here.
public let propSizes: [String: (width: Int, height: Int)] = [
    "apartment": (2, 3),
    "barn": (3, 2),
    "billboard": (2, 1),
    "boxcar": (3, 1),
    "bunker": (2, 2),
    "bus": (2, 1),
    "chapel": (2, 2),
    "crusher": (3, 3),
    "depot": (2, 2),
    "fountain": (2, 2),
    "gasstation": (2, 1),
    "hedge": (2, 1),
    "house": (1, 1),
    "mast": (1, 1),
    "pine": (1, 1),
    "signal": (1, 1),
    "silo": (2, 2),
    "statue": (1, 1),
    "tank": (1, 1),
    "tanker": (3, 1),
    "tower": (2, 2),
    "tree": (1, 1),
    "warehouse": (3, 2),
    "watertower": (2, 2),
    "windpump": (1, 1),
]

// MARK: - Map

public struct GameMap {
    public let width: Int
    public let height: Int

    public var terrain: [UInt8]
    /// Scrap remaining per cell.
    public var resource: [UInt16]
    /// The richness each cell started with — the ceiling regrowth restores to.
    public var resourceMax: [UInt16]
    /// Entity id occupying each cell, or 0. Structures only.
    public var occupied: [UInt32]

    public struct Start {
        public let x: Int
        public let y: Int
    }
    public var starts: [Start] = []

    /// A wreck field, kept as metadata so collectors can find a whole patch.
    public struct Field {
        public let x: Int
        public let y: Int
        public let cells: [(x: Int, y: Int)]
    }
    public var fields: [Field] = []

    /// Destructible scenery, as placement data. `sim.js` (unported) turns
    /// each into an entity at world creation, because only the sim can mint
    /// ids — generation stays free of entity concerns.
    public struct PropPlacement {
        public let defId: String
        public let cx: Int
        public let cy: Int
    }
    public var props: [PropPlacement] = []
    /// Cells already claimed by a prop, so placement never double-books.
    public var propCells: [UInt8]

    /// Which kind of place this map is. Rolled once from the seed and then
    /// consulted by every later pass, which is what stops two seeds producing
    /// the same map with the trees moved.
    public var character: String? = nil

    /// The watercourse, if this map has one: the channel's centre and width at
    /// every step along its axis. Kept as arrays rather than as a cell mask
    /// because everything that asks about the river asks *which side of it*
    /// something is on, and that is one lookup rather than a flood fill.
    public struct River {
        public let horizontal: Bool
        public let span: Int
        public let cross: Int
        public let margin: Int
        public var centres: [Int]
        public var widths: [Int]
    }
    public var river: River? = nil

    /// A bridge, the ford, or a run of channel something later flattened.
    /// `x0…y1` is the deck's rectangle; `x`,`y` its centre.
    public struct Crossing {
        public let kind: String
        public let x: Int
        public let y: Int
        public let horizontal: Bool
        public let x0: Int
        public let x1: Int
        public let y0: Int
        public let y1: Int
    }

    /// A gap cut through a ridgeline. `primary` marks the half that was rolled;
    /// its twin is the mirror. `cache` is the scrap that makes it worth holding.
    public struct Chokepoint {
        public let kind: String
        public let x: Int
        public let y: Int
        public let primary: Bool
        public let cache: Bool
    }

    /// Every place the map narrows to something worth holding. Recorded rather
    /// than rediscovered because three separate things need them and none can
    /// find one by looking: the road network routes *through* chokepoints
    /// instead of bulldozing its own, the scenery placer garrisons them, and a
    /// renderer draws a bridge deck as a bridge rather than as tarmac that
    /// happens to be over water.
    public var crossings: [Crossing] = []
    public var chokepoints: [Chokepoint] = []

    /// Sidings in the rail yards, as rectangles. Rails are `.road` like every
    /// other prepared surface — the five terrain indices are fixed — so this is
    /// the only thing that tells a renderer to draw sleepers instead of a
    /// centre line. Without it a yard reads as four parallel roads.
    public struct Rail {
        public let x0: Int
        public let y0: Int
        public let x1: Int
        public let y1: Int
    }
    public var rails: [Rail] = []

    init(width: Int, height: Int) {
        self.width = width
        self.height = height
        terrain = [UInt8](repeating: 0, count: width * height)
        resource = [UInt16](repeating: 0, count: width * height)
        resourceMax = [UInt16](repeating: 0, count: width * height)
        occupied = [UInt32](repeating: 0, count: width * height)
        propCells = [UInt8](repeating: 0, count: width * height)
    }
}

/// Matches JavaScript's `seed ^ 0x9e3779b9` — both ToInt32'd before the xor,
/// which is what `RNG(signedSeed:)` exists to consume directly.
private let seedMix = Int32(bitPattern: 0x9e3779b9)

/// Default map edge, doubled from the 72 the game shipped with. At 144 there
/// is room for a route to be a *choice* rather than a walk down the only
/// corridor, which is the whole point of having terrain at all.
public let defaultMapSize = 144

/**
 * A surface map, built in this order, and the order is load-bearing:
 *
 *   character   one roll, and every pass below reads it
 *   ridgelines  long walls, with the gaps recorded as they are cut
 *   blobs       weathering over the ridges
 *   ponds       sightline breakers
 *   river       last, so nothing can be painted into the channel
 *   starts      the landing zones, and the ground cleared around them
 *   passes      the recorded gaps widened — needs the starts to keep clear of
 *   fields      wreck fields, nudged off the water
 *   breaches    read the channel back: anything dry is a crossing
 *   districts   the places, and the roads that join them through the crossings
 *               and the passes
 *   scenery     trees, hedgerow, masts, and the garrisons at the chokepoints
 *
 * The chambers biome and the by-fiat landmark placement are not ported: no
 * fixture exercises them, and an unverified port of a pass that consumes rng is
 * worse than an absent one. `hasLandmark` is threaded through as the constant
 * it is here so the one decision it gates — whether this map gets a river —
 * reads the same as the JavaScript's.
 */
public func createMap(seed: Int, width: Int = defaultMapSize, height: Int = defaultMapSize)
    -> GameMap
{
    var rng = RNG(signedSeed: Int32(truncatingIfNeeded: seed) ^ seedMix)
    var map = GameMap(width: width, height: height)

    // Rolled before anything is written, so every terrain pass below can bias
    // itself the same way. One roll, one map: an agricultural map has fewer
    // ridges *and* fewer tower blocks *and* more hedgerow, and that coherence
    // is the difference between a different map and the same map reshuffled.
    map.character = mapCharacters[rng.int(mapCharacters.count)].id
    let passes = carveTerrain(&map, &rng, characterOf(map), hasLandmark: false)

    // Start positions on opposing corners of the usable area, mirrored.
    let inset = jsRoundInt(Double(min(width, height)) * 0.16)
    map.starts = [
        GameMap.Start(x: inset, y: inset),
        GameMap.Start(x: width - 1 - inset, y: height - 1 - inset),
    ]

    for s in map.starts { clearArea(&map, s.x, s.y, 6) }

    // Ridge gaps become *passes*: the good ones widened, all of them recorded
    // so the road network and the scenery placer can find them. Deferred until
    // the landing zones exist, because a pass twelve cells from a Command Rig
    // is not a chokepoint, it is a back door into somebody's base.
    if !passes.isEmpty { openPasses(&map, &rng, passes) }

    // One guaranteed field per start, plus contested fields toward the middle.
    // Every field is generated once and then mirrored, never generated twice
    // from the same stream — two independent rolls would give the two halves
    // subtly different scrap, which is the kind of unfairness a player can
    // feel but not name.
    //
    // Anchors are nudged clear of the water first. `stampField` flattens
    // impassable terrain so scrap is never stranded on a cliff — which, the
    // moment there was a river, meant a field landing on the channel quietly
    // punched a free crossing through it. The centre field is the one that did
    // it every time, because the centre of the map is exactly where a
    // rotationally symmetric watercourse has to pass.
    let home = map.starts[0]
    addFieldPair(&map, home.x + 5, home.y + 1, 4, 1500, &rng)
    addDryFieldPair(&map, jsRoundInt(Double(width) * 0.33), jsRoundInt(Double(height) * 0.62), 5, 1900, &rng)
    addDryFieldPair(&map, jsRoundInt(Double(width) * 0.5), jsRoundInt(Double(height) * 0.5), 6, 2600, &rng)

    // Expansion fields, so a doubled map has something worth crossing it for.
    // Scaled by area: on the old 72×72 this adds none and the map is exactly
    // the three-field economy it always was.
    let extraFields = max(0, jsRoundInt(Double(width * height) / 4200) - 1)
    for _ in 0..<extraFields {
        let fx = 6 + rng.int(width - 12)
        let fy = 6 + rng.int(height - 12)
        if nearAny(map.starts.map { (x: $0.x, y: $0.y) }, fx, fy, 14) { continue }
        addDryFieldPair(&map, fx, fy, 4 + rng.int(2), 1400 + rng.int(700), &rng)
    }

    // A small, rich cache at the widened passes. A chokepoint is only worth
    // holding if holding it pays: scrap in the gap turns the pass into the
    // contested expansion every good RTS map has — an income you can take, and
    // cannot defend cheaply.
    for c in map.chokepoints {
        if !c.primary || c.kind != "pass" || !c.cache { continue }
        addDryFieldPair(&map, c.x, c.y, 3, 2200, &rng)
    }

    // The opening Command Rig is 3×3 anchored one cell up and left of the
    // start, and `canPlace` refuses any footprint with scrap under it. Clearing
    // the footprint after every field is stamped makes "your base fits where
    // the game put you" structural instead of lucky.
    for s in map.starts { clearResource(&map, s.x, s.y, 2) }

    // Anything that flattens ground flattens water too, and a wreck field does
    // exactly that. So the river is re-read here rather than trusted: wherever
    // it is no longer wet, that is a crossing, and the map says so.
    if map.river != nil { noteRiverBreaches(&map) }

    // Scenery last: it reads the finished terrain and the wreck fields so it
    // can refuse to stand on either.
    let districts = planDistricts(map, &rng, characterOf(map))
    for d in districts { buildDistrict(&map, d, &rng) }
    connectDistricts(&map, districts)
    garrisonChokepoints(&map, &rng)
    addLandmarks(&map, &rng, characterOf(map))
    ensureConnected(&map)

    return map
}

// MARK: - Map character

/**
 * What kind of place this map is, rolled once from the seed.
 *
 * The generator was good and it was also the same map every time: seven
 * districts of assorted kinds, a couple of ridges and a fixed helping of trees,
 * reshuffled. Ten matches in, a player can feel that — every map has the same
 * *density*, and density is most of what a place feels like.
 *
 * The numbers are multipliers against the counts that were already there, so no
 * character can produce a map the generator could not have produced before — it
 * can only produce one it would rarely have chosen, which is exactly the
 * difference between variety and chaos.
 *
 * `mix` is an array of pairs rather than a dictionary because the weighted pick
 * walks it in order, and a dictionary's order is not a thing to bet a seed on.
 */
struct MapCharacter {
    let id: String
    let districts: Double
    let ridges: Double
    let blobs: Double
    let trees: Double
    let hedges: Double
    let ponds: Int
    /// A channel this many cells wide, and this many mirrored pairs of bridges.
    let riverWidth: Int
    let riverPairs: Int
    let mix: [(kind: String, weight: Int)]
}

/// Order is load-bearing: the character is chosen with a single `rng.int` into
/// this list, so reordering it would generate a different world from the seed.
let mapCharacters: [MapCharacter] = [
    // A narrow channel with hard banks: a city river is a canal.
    MapCharacter(
        id: "sprawl", districts: 1.5, ridges: 0.6, blobs: 0.8, trees: 0.45, hedges: 0.5,
        ponds: 1, riverWidth: 3, riverPairs: 2,
        mix: [
            ("downtown", 4), ("suburb", 4), ("industrial", 2), ("railyard", 2), ("park", 2),
        ]),
    MapCharacter(
        id: "pastoral", districts: 0.9, ridges: 0.7, blobs: 0.8, trees: 1.4, hedges: 1.5,
        ponds: 2, riverWidth: 3, riverPairs: 2,
        mix: [
            ("farm", 6), ("suburb", 2), ("park", 2), ("railyard", 1), ("industrial", 1),
        ]),
    MapCharacter(
        id: "broken", districts: 0.8, ridges: 2.0, blobs: 1.35, trees: 0.8, hedges: 0.6,
        ponds: 1, riverWidth: 3, riverPairs: 2,
        mix: [
            ("quarry", 5), ("industrial", 2), ("suburb", 2), ("railyard", 1), ("park", 1),
            ("farm", 1),
        ]),
    MapCharacter(
        id: "works", districts: 1.3, ridges: 0.9, blobs: 0.9, trees: 0.5, hedges: 0.5,
        ponds: 1, riverWidth: 4, riverPairs: 2,
        mix: [
            ("railyard", 5), ("industrial", 5), ("suburb", 2), ("downtown", 1), ("quarry", 1),
        ]),
    // The wide one, and the reason this character exists. A five-cell channel
    // with three ponds around it is a different map from a three-cell one: more
    // of the ground is water, so more of the fighting happens where it is not.
    MapCharacter(
        id: "delta", districts: 1.0, ridges: 0.5, blobs: 0.7, trees: 1.0, hedges: 1.0,
        ponds: 3, riverWidth: 5, riverPairs: 2,
        mix: [
            ("farm", 3), ("suburb", 3), ("park", 2), ("industrial", 2), ("railyard", 1),
            ("downtown", 1),
        ]),
]

/// The character record for a map, falling back to the first for old saves.
func characterOf(_ map: GameMap) -> MapCharacter {
    mapCharacters.first { $0.id == map.character } ?? mapCharacters[0]
}

/// Weighted pick from `(value, weight)` pairs. One rng draw, order-stable.
private func pickWeighted(_ rng: inout RNG, _ pairs: [(kind: String, weight: Int)]) -> String {
    var total = 0
    for p in pairs { total += p.weight }
    var roll = rng.next() * Double(total)
    for p in pairs {
        roll -= Double(p.weight)
        if roll < 0 { return p.kind }
    }
    return pairs[pairs.count - 1].kind
}

// MARK: - Districts

/// The kinds of place a map can contain. Every character's `mix` names its own,
/// so this is here for the same reason the JS exports it: a district kind that
/// no character ever rolls is a district kind nobody will ever see.
///
/// The three later ones were each chosen for the shape of the fight in them
/// rather than for how they draw: a rail yard is parallel firing lanes with
/// hard cover across them, a farm is open ground cut into rooms by hedge you
/// can see over and cannot walk through, and a quarry is a hole in the map with
/// one ramp and the richest scrap on it at the bottom.
public let districtKinds = [
    "suburb", "downtown", "industrial", "park", "railyard", "farm", "quarry",
]

private struct District {
    let x: Int
    let y: Int
    let kind: String
}

/// Choose district anchors: how many, where, and of what kind.
///
/// A bounded number of attempts, not a loop until success: on a small or
/// cliff-heavy map there may be nowhere left, and spinning forever waiting for
/// a seed to cooperate is not a generation strategy.
private func planDistricts(_ map: GameMap, _ rng: inout RNG, _ character: MapCharacter)
    -> [District]
{
    let width = map.width
    let height = map.height
    let wanted = max(2, jsRoundInt(Double(width * height) / 1500 * character.districts))
    var chosen: [District] = []

    var attempt = 0
    while attempt < wanted * 12 && chosen.count < wanted {
        attempt += 1
        let x = 8 + rng.int(max(1, width - 16))
        let y = 8 + rng.int(max(1, height - 16))
        if nearAny(map.starts.map { (x: $0.x, y: $0.y) }, x, y, 16) { continue }
        if nearAny(chosen.map { (x: $0.x, y: $0.y) }, x, y, 15) { continue }
        chosen.append(District(x: x, y: y, kind: pickWeighted(&rng, character.mix)))
    }
    return chosen
}

private func nearAny(_ points: [(x: Int, y: Int)], _ x: Int, _ y: Int, _ distance: Int) -> Bool {
    points.contains { abs($0.x - x) < distance && abs($0.y - y) < distance }
}

private func buildDistrict(_ map: inout GameMap, _ district: District, _ rng: inout RNG) {
    switch district.kind {
    case "downtown": addDowntown(&map, district.x, district.y, &rng)
    case "industrial": addIndustrial(&map, district.x, district.y, &rng)
    case "park": addPark(&map, district.x, district.y, &rng)
    case "railyard": addRailYard(&map, district.x, district.y, &rng)
    case "farm": addFarm(&map, district.x, district.y, &rng)
    case "quarry": addQuarry(&map, district.x, district.y, &rng)
    default: addNeighbourhood(&map, district.x, district.y, &rng)
    }
}

/// Tower blocks on a street grid, with the mast and the billboards that make a
/// skyline legible from across the map. A grid casts long straight firing
/// lanes, which is a different kind of fight from the suburbs.
private func addDowntown(_ map: inout GameMap, _ cx: Int, _ cy: Int, _ rng: inout RNG) {
    let blocks = 2 + rng.int(2)
    for by in 0..<blocks {
        for bx in 0..<blocks {
            let x = cx + bx * 6
            let y = cy + by * 6
            if rng.chance(0.22) { continue }
            addPropPair(&map, rng.chance(0.45) ? "tower" : "apartment", x, y)
            if rng.chance(0.4) { addPropPair(&map, "billboard", x + 3, y + 1) }
        }
    }
    // Streets through the grid, so downtown is walkable rather than a wall.
    for i in 0...blocks {
        paveLine(&map, cx - 2, cy + i * 6 - 2, cx + blocks * 6, cy + i * 6 - 2, 2)
        paveLine(&map, cx + i * 6 - 2, cy - 2, cx + i * 6 - 2, cy + blocks * 6, 2)
    }
    addPropPair(&map, "mast", cx + blocks * 3, cy - 3)
    if rng.chance(0.6) { addPropPair(&map, "bus", cx - 1, cy + rng.int(blocks * 6)) }
}

/// The dangerous one: fuel, grain dust and propane inside one blast radius of
/// each other, which makes the estate a weapon rather than an obstacle.
private func addIndustrial(_ map: inout GameMap, _ cx: Int, _ cy: Int, _ rng: inout RNG) {
    addPropPair(&map, "warehouse", cx, cy)
    if rng.chance(0.7) { addPropPair(&map, "warehouse", cx + 4, cy + 3) }
    addPropPair(&map, "silo", cx - 3, cy + 1)
    if rng.chance(0.55) { addPropPair(&map, "silo", cx - 3, cy + 4) }

    // The tank farm, tight enough that one rocket takes the row.
    for i in 0..<4 {
        addPropPair(&map, "tank", cx + 1 + (i % 2) * 2, cy + 4 + (i / 2) * 2)
    }
    addPropPair(&map, "depot", cx + 4, cy - 2)
    addPropPair(&map, "watertower", cx - 3, cy - 3)
    if rng.chance(0.5) { addPropPair(&map, "mast", cx + 7, cy + 1) }
    paveLine(&map, cx - 5, cy + 8, cx + 8, cy + 8, 2)
}

/// Green space: old growth, hedges, and something to stand around.
private func addPark(_ map: inout GameMap, _ cx: Int, _ cy: Int, _ rng: inout RNG) {
    addPropPair(&map, "fountain", cx, cy)
    let trees = 6 + rng.int(7)
    for i in 0..<trees {
        let off = ringOffset(i + 1, radius: Double(3 + rng.int(5)))
        addPropPair(
            &map,
            rng.chance(0.45) ? "pine" : "tree",
            cx + jsRoundInt(off.x),
            cy + jsRoundInt(off.y))
    }
    for _ in 0..<3 {
        if !rng.chance(0.6) { continue }
        addPropPair(&map, "hedge", cx - 4 + rng.int(9), cy - 4 + rng.int(9))
    }
    if rng.chance(0.4) { addPropPair(&map, "statue", cx + 3, cy - 3) }
}

/**
 * A rail yard: three or four sidings, the stock left standing on them, and a
 * shed at one end.
 *
 * Parallel tracks are parallel *fast lanes*, so a yard is several routes
 * through one district; the wagons standing on them are hard cover across those
 * lanes rather than along them; and the tank wagons are a chain hazard strung
 * out down a lane rather than piled in a corner the way the estate's tank farm
 * is. Pushing down a siding and pushing *across* one are different problems.
 *
 * Stock goes down *before* the track is laid, because `paveLine` refuses to
 * pave a cell a prop has claimed and `propFits` refuses to stand a prop on
 * road. Doing it the other way round produces a yard with no wagons in it.
 */
private func addRailYard(_ map: inout GameMap, _ cx: Int, _ cy: Int, _ rng: inout RNG) {
    let sidings = 3 + rng.int(2)
    let length = 16 + rng.int(10)
    let x0 = cx - jsRoundInt(Double(length) / 2)
    let x1 = x0 + length

    for i in 0..<sidings {
        let y = cy + i * 3
        let wagons = 1 + rng.int(3)
        for _ in 0..<wagons {
            let at = x0 + 2 + rng.int(max(1, length - 6))
            // One wagon in six is a tanker: enough that a yard is dangerous,
            // few enough that a player has to look at which one they are
            // standing next to rather than treating the district as a minefield.
            addPropPair(&map, rng.chance(0.17) ? "tanker" : "boxcar", at, y)
        }
        paveLine(&map, x0, y, x1, y, 1)
        addRailPair(&map, x0, y, x1, y)
    }

    // The shed and the yard buildings, clear of the running lines.
    addPropPair(&map, "warehouse", x0 - 4, cy)
    if rng.chance(0.6) { addPropPair(&map, "warehouse", x0 - 4, cy + 3) }
    addPropPair(&map, "watertower", x1 + 1, cy + sidings * 3 - 4)

    // Signals at both throats, which is what makes a yard read as a yard from
    // across the map — they are the only tall thing in it.
    addPropPair(&map, "signal", x0 - 1, cy - 2)
    addPropPair(&map, "signal", x1 + 1, cy - 2)
    if rng.chance(0.5) { addPropPair(&map, "signal", x1 + 1, cy + sidings * 3) }

    // The yard road, along the far side of the sidings.
    paveLine(&map, x0 - 4, cy + sidings * 3, x1 + 2, cy + sidings * 3, 2)
}

/**
 * A farm: a yard, and the fields around it marked out in hedge.
 *
 * The hedgerows are the district. They are low, so they block a walker and hide
 * nothing — which turns open country into a set of rooms you can see across and
 * cannot walk across, and that is a completely different fight from the
 * suburb's blind corners. The gaps rolled into each run are the gates, and a
 * gate is a chokepoint that costs one prop to make.
 *
 * The runs are kept deliberately short. A hedgerow is one prop every two cells
 * and the pastoral character puts six farms on a map, so a boundary that
 * reached eighteen cells rather than eleven is another four hundred neutral
 * entities for scenery nobody can see the far end of.
 */
private func addFarm(_ map: inout GameMap, _ cx: Int, _ cy: Int, _ rng: inout RNG) {
    addPropPair(&map, "barn", cx, cy)
    addPropPair(&map, "house", cx + 5, cy + 1)
    addPropPair(&map, "silo", cx - 3, cy - 1)
    if rng.chance(0.6) { addPropPair(&map, "silo", cx - 3, cy + 2) }
    addPropPair(&map, "windpump", cx + 5, cy - 3)
    if rng.chance(0.5) { addPropPair(&map, "tank", cx + 2, cy + 3) }

    // Field boundaries, out past the yard in both directions. Two runs each way
    // makes a grid of fields; one would read as a fence.
    let runs = 2
    let reach = 9 + rng.int(4)
    for i in 0..<runs {
        let y = cy - reach + jsRoundInt(Double(i + 1) / Double(runs + 1) * Double(reach) * 2)
        for x in stride(from: cx - reach, to: cx + reach, by: 2) {
            if rng.chance(0.16) { continue }
            addPropPair(&map, "hedge", x, y)
        }
    }
    for i in 0..<runs {
        let x = cx - reach + jsRoundInt(Double(i + 1) / Double(runs + 1) * Double(reach) * 2)
        for y in (cy - reach)..<(cy + reach) {
            if rng.chance(0.2) { continue }
            addPropPair(&map, "hedge", x, y)
        }
    }

    // Trees in the boundaries, because a hedgerow with nothing standing in it
    // is a wall rather than a hedgerow.
    let trees = 3 + rng.int(4)
    for i in 0..<trees {
        let off = ringOffset(i + 1, radius: Double(6 + rng.int(reach - 6)))
        addPropPair(&map, "tree", cx + jsRoundInt(off.x), cy + jsRoundInt(off.y))
    }

    // The farm track out to wherever the road network finds it.
    paveLine(&map, cx + 2, cy + 2, cx + 2, cy + reach, 1)
}

/**
 * A quarry: a hole in the map with one or two ramps into it, and the best scrap
 * on the map at the bottom.
 *
 * The only district that is terrain rather than scenery, and that is the point
 * of it. A rim of cliff with two gaps is a chokepoint that was not cut into a
 * ridgeline, in the middle of open ground, with a reason to go in — you cannot
 * hold the pit, you can only hold the ramp.
 */
private func addQuarry(_ map: inout GameMap, _ cx: Int, _ cy: Int, _ rng: inout RNG) {
    // Not on top of a chokepoint. This is the only district that writes cliff,
    // and it writes it *after* the passes have been widened and the crossings
    // laid — so a pit whose rim happened to land on a pass filled the pass back
    // in, leaving a chokepoint that the road routes to, the scenery garrisons,
    // and nothing can walk through.
    if nearAny(map.chokepoints.map { (x: $0.x, y: $0.y) }, cx, cy, 16)
        || nearAny(map.crossings.map { (x: $0.x, y: $0.y) }, cx, cy, 16)
    {
        return addIndustrial(&map, cx, cy, &rng)
    }

    let r = 6 + rng.int(4)

    for y in (cy - r)...(cy + r) {
        for x in (cx - r)...(cx + r) {
            let d = len(Double(x - cx), Double(y - cy))
            if d > Double(r) { continue }
            // Never over the channel: a working with water through it is a
            // flooded working; a river with a quarry through it is a bug. Never
            // over scrap either — this is the only pass that writes *cliff*
            // after the wreck fields are stamped, and a rim laid across a field
            // buries scrap somewhere nothing can reach it.
            //
            // Both tests read something symmetric — the river record and the
            // resource grid — rather than the terrain being written, which is
            // what keeps the decision the same for a cell and for its mirror. A
            // pit big enough to overlap its own mirror image is painted in
            // whatever order the loop reaches the cells, and only a symmetric
            // *decision* survives that.
            if inChannel(map, x, y) { continue }
            // A pit's rim can reach a cell outside the grid — the anchor comes
            // no closer than eight cells to the edge and the radius goes to
            // nine. The JavaScript indexes a flat typed array, so an `x` off
            // the side of a row is a genuine read of the neighbouring row and
            // is reproduced as one; only an index off the *array* is undefined
            // there, which reads as falsy. That is the case this range check
            // is for, and it is the difference between agreeing with the
            // oracle and trapping.
            let i = y * map.width + x
            if i >= 0 && i < map.resource.count && map.resource[i] > 0 { continue }
            if d > Double(r) - 1.7 { paintMirrored(&map, x, y, .cliff) }
            else if d > Double(r) - 3.4 { paintMirrored(&map, x, y, .rough) }
            else { paintMirrored(&map, x, y, .ground) }
        }
    }

    // Haul ramps: a run of spoil cut straight out through the rim. Two at most —
    // a pit with a gap on every side is a bowl, not a quarry.
    let ramps = 1 + rng.int(2)
    for _ in 0..<ramps {
        let off = ringOffset(rng.int(8) + 1, radius: 1)
        let alongX = abs(off.x) > abs(off.y)
        for step in 0...(r + 3) {
            for lane in -1...1 {
                let x = jsRoundInt(Double(cx) + off.x * Double(step)) + (alongX ? 0 : lane)
                let y = jsRoundInt(Double(cy) + off.y * Double(step)) + (alongX ? lane : 0)
                paintMirroredIf(&map, x, y, .rough, .cliff)
            }
        }
    }

    // The reason to go down there. Rich and small: an income worth taking and
    // impossible to defend cheaply, which is what an expansion should be.
    addFieldPair(&map, cx, cy, max(2, r - 5), 2500, &rng)

    // The plant, outside the rim where there is ground to stand it on.
    addPropPair(&map, "crusher", cx + r + 1, cy - 1)
    addPropPair(&map, "warehouse", cx - r - 4, cy)
    addPropPair(&map, "tank", cx + r + 1, cy + 3)
    if rng.chance(0.6) { addPropPair(&map, "tank", cx + r + 3, cy + 3) }
    if rng.chance(0.5) { addPropPair(&map, "watertower", cx - r - 4, cy - 4) }
    paveLine(&map, cx + r + 1, cy + 5, cx + r + 9, cy + 5, 2)
}

/// Tarmac between the districts — the reason the map has a shape.
///
/// Each district is joined to its nearest neighbour rather than to all of
/// them: a complete graph paves half the map and stops meaning anything.
private func connectDistricts(_ map: inout GameMap, _ districts: [District]) {
    for i in 0..<districts.count {
        var best = -1
        var bestD = Double.infinity
        for j in 0..<districts.count {
            if i == j { continue }
            let d = len(
                Double(districts[i].x - districts[j].x), Double(districts[i].y - districts[j].y))
            if d < bestD {
                bestD = d
                best = j
            }
        }
        if best < 0 { continue }
        routeRoad(
            &map, (x: districts[i].x, y: districts[i].y),
            (x: districts[best].x, y: districts[best].y))
    }

    // Every bridge is joined to the nearest district on each bank, whether or
    // not any pair of districts happened to want to cross there. A bridge the
    // network does not reach is a bridge nobody walks over: road is the fastest
    // ground in the game, so the network is most of what decides where a player
    // *goes*, and a chokepoint off it is scenery.
    for c in map.crossings {
        if c.kind == "ford" { continue }
        for side in [-1, 1] {
            guard let near = nearestOnBank(map, districts, (x: c.x, y: c.y), side) else { continue }
            routeRoad(&map, (x: c.x, y: c.y), near)
        }
    }
}

/**
 * Tarmac from `a` to `b`, through whatever the map narrows to in between.
 *
 * The old version paved a dog-leg and let `paveLine` bulldoze anything in the
 * way, which is what kept the map connected and also what made the ridgelines
 * pointless: a road cut its own pass wherever it met rock, so every ridge ended
 * up with as many gaps as there were roads crossing it and none of them meant
 * anything. Routing through the gaps that are already there is what turns a
 * pass into *the* pass.
 *
 * Waypoints are ordered by how far along the run they are, so a route that
 * needs both a bridge and a pass takes them in the order it meets them.
 */
private func routeRoad(_ map: inout GameMap, _ a: (x: Int, y: Int), _ b: (x: Int, y: Int)) {
    var via: [(x: Int, y: Int)] = []

    if let crossing = crossingBetween(map, a, b) { via.append(crossing) }
    if let pass = passBetween(map, a, b) { via.append(pass) }

    // At most two waypoints, so the JS `sort` is one comparison — written out
    // rather than delegated because Swift's sort is not stable and a tie here
    // would silently reorder a bridge and a pass that are equidistant.
    if via.count == 2 {
        let d0 = len(Double(via[0].x - a.x), Double(via[0].y - a.y))
        let d1 = len(Double(via[1].x - a.x), Double(via[1].y - a.y))
        if d0 > d1 { via.swapAt(0, 1) }
    }

    var from = a
    for point in via + [b] {
        // Dog-leg rather than diagonal: roads meet at junctions, and a diagonal
        // road across a square grid is a staircase that reads as a bug.
        paveLine(&map, from.x, from.y, point.x, from.y, 2)
        paveLine(&map, point.x, from.y, point.x, point.y, 2)
        from = point
    }
}

/// The crossing a route between two banks should use, or nil if it stays put.
private func crossingBetween(_ map: GameMap, _ a: (x: Int, y: Int), _ b: (x: Int, y: Int))
    -> (x: Int, y: Int)?
{
    if map.river == nil || map.crossings.isEmpty { return nil }
    let sideA = bankOf(map, a.x, a.y)
    let sideB = bankOf(map, b.x, b.y)
    if sideA == 0 || sideB == 0 || sideA == sideB { return nil }

    var best: (x: Int, y: Int)? = nil
    var bestD = Double.infinity
    for c in map.crossings {
        let d =
            len(Double(a.x - c.x), Double(a.y - c.y)) + len(Double(b.x - c.x), Double(b.y - c.y))
        if d < bestD {
            bestD = d
            best = (x: c.x, y: c.y)
        }
    }
    return best
}

/**
 * The pass a route through a ridgeline should use, or nil if it is not in one's
 * way.
 *
 * "In the way" is measured rather than assumed: the direct dog-leg is walked
 * and its cliff cells counted. Under four the road is skirting a boulder and
 * paving straight through is right; over it the route is going through a wall,
 * and a wall is what passes are for.
 *
 * The detour budget is what stops this producing absurd roads. A pass on the
 * far side of the map is not the answer to a ridge in front of you.
 */
private func passBetween(_ map: GameMap, _ a: (x: Int, y: Int), _ b: (x: Int, y: Int))
    -> (x: Int, y: Int)?
{
    var blocked = 0
    func count(_ x0: Int, _ y0: Int, _ x1: Int, _ y1: Int) {
        let steps = max(abs(x1 - x0), abs(y1 - y0))
        for s in 0...steps {
            let x = jsRoundInt(Double(x0) + Double((x1 - x0) * s) / Double(max(1, steps)))
            let y = jsRoundInt(Double(y0) + Double((y1 - y0) * s) / Double(max(1, steps)))
            if terrainAt(map, x, y) == .cliff { blocked += 1 }
        }
    }
    count(a.x, a.y, b.x, a.y)
    count(b.x, a.y, b.x, b.y)
    if blocked < 4 { return nil }

    let direct = len(Double(a.x - b.x), Double(a.y - b.y))
    var best: (x: Int, y: Int)? = nil
    var bestD = Double.infinity
    for c in map.chokepoints {
        if c.kind != "pass" { continue }
        let d =
            len(Double(a.x - c.x), Double(a.y - c.y)) + len(Double(b.x - c.x), Double(b.y - c.y))
        if d > direct * 1.6 + 12 { continue }
        if d < bestD {
            bestD = d
            best = (x: c.x, y: c.y)
        }
    }
    return best
}

/// The district nearest a crossing on one particular bank of the river.
private func nearestOnBank(
    _ map: GameMap, _ districts: [District], _ crossing: (x: Int, y: Int), _ side: Int
) -> (x: Int, y: Int)? {
    var best: (x: Int, y: Int)? = nil
    var bestD = Double.infinity
    for d in districts {
        if bankOf(map, d.x, d.y) != side { continue }
        let dist = len(Double(d.x - crossing.x), Double(d.y - crossing.y))
        if dist < bestD {
            bestD = dist
            best = (x: d.x, y: d.y)
        }
    }
    return best
}

/**
 * Record a siding and its mirror.
 *
 * Rails are `.road`, because there are five terrain indices and there is never
 * going to be a sixth — pathfinding, vision and every saved replay read raw
 * indices. So the track is fast ground like any other prepared surface, and
 * this is the note that tells a renderer to draw sleepers on it.
 */
private func addRailPair(_ map: inout GameMap, _ x0: Int, _ y0: Int, _ x1: Int, _ y1: Int) {
    map.rails.append(
        GameMap.Rail(
            x0: min(x0, x1), y0: min(y0, y1), x1: max(x0, x1), y1: max(y0, y1)))
    map.rails.append(
        GameMap.Rail(
            x0: map.width - 1 - max(x0, x1),
            y0: map.height - 1 - max(y0, y1),
            x1: map.width - 1 - min(x0, x1),
            y1: map.height - 1 - min(y0, y1)))
}

/// Lay tarmac along a straight run, `lanes` cells wide, mirrored as it goes.
///
/// Paves over cliff as well as ground, so a road is also a mountain pass.
/// Water is the exception — the surface stops at the bank and picks up on the
/// far side, which reads as a ford. Never paves near a start: roads are
/// unbuildable, and a dual carriageway through your only flat ground is not a
/// difficulty setting.
///
/// Never paves a ford either, and that one is a game rule rather than a
/// courtesy. The ford is the map's slow crossing — wide, shallow and rough —
/// and the whole reason it plays differently from the bridges is that it costs
/// 1.7 to walk instead of 0.72. A road laid over it is a second bridge that
/// happens to be eight cells wide, and the map has lost its safe crossing.
private func paveLine(
    _ map: inout GameMap, _ x0: Int, _ y0: Int, _ x1: Int, _ y1: Int, _ lanes: Int = 2
) {
    let steps = max(abs(x1 - x0), abs(y1 - y0))
    if steps == 0 { return }
    let stepX = Double(x1 - x0) / Double(steps)
    let stepY = Double(y1 - y0) / Double(steps)
    // Lanes are laid perpendicular to travel, so a vertical road widens
    // sideways and a horizontal one widens up and down.
    let acrossX = abs(stepX) > abs(stepY) ? 0 : 1
    let acrossY = acrossX == 1 ? 0 : 1

    let starts = map.starts.map { (x: $0.x, y: $0.y) }
    for s in 0...steps {
        let bx = jsRoundInt(Double(x0) + stepX * Double(s))
        let by = jsRoundInt(Double(y0) + stepY * Double(s))
        for lane in 0..<lanes {
            let x = bx + acrossX * lane
            let y = by + acrossY * lane
            if !inBounds(map, x, y) { continue }
            // Leave the sealed border alone.
            if x < 1 || y < 1 || x >= map.width - 1 || y >= map.height - 1 { continue }
            let i = y * map.width + x
            if map.terrain[i] == Terrain.water.rawValue { continue }
            if map.resource[i] > 0 { continue }
            if map.propCells[i] != 0 { continue }
            if nearAny(starts, x, y, 9) { continue }
            if inFord(map, x, y) { continue }
            paintMirrored(&map, x, y, .road)
        }
    }
}

/// Is this cell part of a ford's shallows? See `paveLine`.
private func inFord(_ map: GameMap, _ x: Int, _ y: Int) -> Bool {
    for c in map.crossings {
        if c.kind != "ford" { continue }
        if x >= c.x0 && x <= c.x1 && y >= c.y0 && y <= c.y1 { return true }
    }
    return false
}

// MARK: - Connectivity

/// Guarantee the two starts can reach each other on foot.
///
/// A long ridge on an unlucky seed could partition the map, at which point no
/// objective can be completed and the match is unwinnable. In practice the
/// passes cut into every ridge plus the road network leave every swept seed
/// connected without this, so it is a backstop — one flood fill against a
/// failure that would otherwise reach a player rather than a test.
public func ensureConnected(_ map: inout GameMap) {
    guard map.starts.count >= 2 else { return }
    let a = map.starts[0]
    let b = map.starts[1]
    if reachable(map, (x: a.x, y: a.y), (x: b.x, y: b.y)) { return }

    // Cuts ground rather than road: a road is unbuildable, and this runs
    // straight through the middle of both bases.
    cutCorridor(&map, a.x, a.y, b.x, a.y)
    cutCorridor(&map, b.x, a.y, b.x, b.y)
}

/// Breadth-first flood over passable cells. Terrain only — buildings move.
private func reachable(_ map: GameMap, _ from: (x: Int, y: Int), _ to: (x: Int, y: Int)) -> Bool {
    var seen = [UInt8](repeating: 0, count: map.width * map.height)
    var queue = [from.y * map.width + from.x]
    seen[queue[0]] = 1
    let goal = to.y * map.width + to.x

    var head = 0
    while head < queue.count {
        let at = queue[head]
        head += 1
        if at == goal { return true }
        let x = at % map.width
        let y = at / map.width
        for dy in -1...1 {
            for dx in -1...1 {
                if dx == 0 && dy == 0 { continue }
                let nx = x + dx
                let ny = y + dy
                if !inBounds(map, nx, ny) { continue }
                let ni = ny * map.width + nx
                if seen[ni] != 0 { continue }
                if !terrainInfo[Int(map.terrain[ni])].passable { continue }
                seen[ni] = 1
                queue.append(ni)
            }
        }
    }
    return false
}

/// Flatten a two-cell-wide run to walkable ground, mirrored.
private func cutCorridor(_ map: inout GameMap, _ x0: Int, _ y0: Int, _ x1: Int, _ y1: Int) {
    let steps = max(abs(x1 - x0), abs(y1 - y0))
    if steps == 0 { return }
    let stepX = Double(x1 - x0) / Double(steps)
    let stepY = Double(y1 - y0) / Double(steps)
    let acrossX = abs(stepX) > abs(stepY) ? 0 : 1
    let acrossY = acrossX == 1 ? 0 : 1

    for s in 0...steps {
        for lane in 0..<2 {
            let x = jsRoundInt(Double(x0) + stepX * Double(s)) + acrossX * lane
            let y = jsRoundInt(Double(y0) + stepY * Double(s)) + acrossY * lane
            if !inBounds(map, x, y) { continue }
            if x < 1 || y < 1 || x >= map.width - 1 || y >= map.height - 1 { continue }
            if terrainInfo[Int(map.terrain[y * map.width + x])].passable { continue }
            paintMirrored(&map, x, y, .ground)
        }
    }
}

// MARK: - Props

/// Place a prop and its exact 180° mirror. Same discipline as the wreck
/// fields: rolled once, stamped twice.
///
/// The mirrored anchor is not `(W-1-cx, H-1-cy)` — that mirrors the top-left
/// corner and puts a 2x2 footprint one cell off. It is the mirror of the
/// *bottom-right* corner, `(W-w-cx, H-h-cy)`.
private func addPropPair(_ map: inout GameMap, _ defId: String, _ cx: Int, _ cy: Int) {
    guard let size = propSizes[defId] else { return }
    let (w, h) = size
    let twin = (x: map.width - w - cx, y: map.height - h - cy)

    for at in [(x: cx, y: cy), twin] {
        if !propFits(map, size, at.x, at.y) { continue }
        // A prop on the mirror line can map onto itself; placing it twice
        // would stack two entities on one footprint.
        if map.props.contains(where: { $0.cx == at.x && $0.cy == at.y }) { continue }
        map.props.append(GameMap.PropPlacement(defId: defId, cx: at.x, cy: at.y))
        for y in at.y..<(at.y + h) {
            for x in at.x..<(at.x + w) {
                if inBounds(map, x, y) { map.propCells[y * map.width + x] = 1 }
            }
        }
    }
}

/**
 * Place a prop pair at an anchor, or as near to it as will take one.
 *
 * `addPropPair` refuses anything that does not fit and says nothing, which is
 * right for scattered scenery and wrong for a bridgehead: that is a
 * *composition*, and one of its two blockhouses landing on the cliff at the end
 * of the deck meant half the bridges on the map had a garrison on one side
 * only. Nothing failed; it just looked like nobody had bothered.
 *
 * The search is a deterministic spiral, not a roll, so a crowded anchor does not
 * consume rng that an empty one would leave alone.
 */
private func addPropPairNear(
    _ map: inout GameMap, _ defId: String, _ cx: Int, _ cy: Int, _ spread: Int = 3
) {
    let before = map.props.count
    addPropPair(&map, defId, cx, cy)
    if map.props.count > before { return }
    for r in 1...spread {
        for a in 0..<8 {
            let off = ringOffset(a + 1, radius: Double(r))
            addPropPair(&map, defId, cx + jsRoundInt(off.x), cy + jsRoundInt(off.y))
            if map.props.count > before { return }
        }
    }
}

/// Buildable ground, inside the border, clear of starts, fields and other props.
private func propFits(_ map: GameMap, _ size: (width: Int, height: Int), _ cx: Int, _ cy: Int) -> Bool {
    let (w, h) = size
    for y in cy..<(cy + h) {
        for x in cx..<(cx + w) {
            if x < 2 || y < 2 || x >= map.width - 2 || y >= map.height - 2 { return false }
            let i = y * map.width + x
            if map.terrain[i] != Terrain.ground.rawValue { return false }
            if map.resource[i] > 0 { return false }
            if map.propCells[i] != 0 { return false }
            // Keep the landing zones clear — opening a mission walled into
            // your own base by a tower block is not a difficulty setting.
            for s in map.starts {
                if abs(x - s.x) <= 7 && abs(y - s.y) <= 7 { return false }
            }
        }
    }
    return true
}

/**
 * A block of suburbia: a street with houses down both sides, trees between
 * them, and a fuel station on the corner.
 *
 * Deliberately gridded rather than scattered. Scattered props read as
 * scenery; a street reads as a place, and a place is something a player
 * routes through, fights over and remembers.
 */
private func addNeighbourhood(_ map: inout GameMap, _ cx: Int, _ cy: Int, _ rng: inout RNG) {
    let horizontal = rng.chance(0.5)
    let length = 5 + rng.int(4)
    var road: [(x: Int, y: Int)] = []

    for i in -length...length {
        road.append((x: horizontal ? cx + i : cx, y: horizontal ? cy : cy + i))
    }

    // The street is tarmac, not just cleared ground: a suburb you can drive
    // through fast is a suburb worth driving through.
    let first = road[0]
    let last = road[road.count - 1]
    paveLine(&map, first.x, first.y, last.x, last.y, 1)

    // Houses face the street from both sides, with gaps for driveways.
    for cell in road {
        for side in [-2, 2] {
            if rng.chance(0.28) { continue }
            let x = horizontal ? cell.x : cell.x + side
            let y = horizontal ? cell.y + side : cell.y
            let roll = rng.next()
            let defId = roll < 0.14 ? "tree" : roll < 0.24 ? "chapel" : "house"
            addPropPair(&map, defId, x, y)
        }
    }

    // Street trees and hedges in the verge.
    for cell in road {
        if !rng.chance(0.34) { continue }
        let side = rng.chance(0.5) ? -1 : 1
        let x = horizontal ? cell.x : cell.x + side
        let y = horizontal ? cell.y + side : cell.y
        addPropPair(&map, rng.chance(0.3) ? "hedge" : "tree", x, y)
    }

    // A bus abandoned across the road, because an empty street is a corridor
    // and a blocked one is a decision.
    if rng.chance(0.45) {
        let at = road[rng.int(road.count)]
        addPropPair(&map, "bus", at.x + 1, at.y + 1)
    }

    // The corner station.
    addPropPair(
        &map, "gasstation",
        horizontal ? last.x + 1 : last.x - 2,
        horizontal ? last.y + 2 : last.y + 1)
}

/**
 * Everything that belongs to no district: the monument at the centre, the
 * relay masts on the high ground, and the old growth in between.
 */
private func addLandmarks(_ map: inout GameMap, _ rng: inout RNG, _ character: MapCharacter) {
    let width = map.width
    let height = map.height

    // A monument, spiralled out from the centre rather than dropped on a
    // fixed cell: the middle of the map is usually a wreck field, and a
    // landmark that only exists on some seeds is not a landmark.
    let mx = jsRoundInt(Double(width) * 0.5)
    let my = jsRoundInt(Double(height) * 0.5)
    guard let statueSize = propSizes["statue"] else { fatalError("missing statue size") }
    placed: for r in 4..<16 {
        for a in 0..<8 {
            let off = ringOffset(a + 1, radius: Double(r))
            let x = jsRoundInt(Double(mx) + off.x)
            let y = jsRoundInt(Double(my) + off.y)
            if !propFits(map, statueSize, x, y) { continue }
            addPropPair(&map, "statue", x, y)
            break placed
        }
    }

    // Relay masts, scattered wide. They are the tallest thing on the map and
    // cost almost nothing to draw, so they are what gives a big map a horizon.
    let masts = max(1, jsRoundInt(Double(width * height) / 5200))
    for _ in 0..<masts {
        addPropPair(&map, "mast", 4 + rng.int(width - 8), 4 + rng.int(height - 8))
    }

    // Old growth, thickest on rough ground where it reads as untended. Two
    // species mixed, because a forest of one tree is a texture and a forest of
    // two is a wood. Scaled by the map's character: this one number is most of
    // the difference between farmland and a conurbation at a glance.
    let trees = jsRoundInt(Double(width * height) / 210 * character.trees)
    for _ in 0..<trees {
        addPropPair(&map, rng.chance(0.35) ? "pine" : "tree", rng.int(width), rng.int(height))
    }

    // Hedgerows out in the open country, marking field boundaries nobody has
    // farmed in years.
    let hedges = jsRoundInt(Double(width * height) / 1300 * character.hedges)
    for _ in 0..<hedges {
        addPropPair(&map, "hedge", rng.int(width), rng.int(height))
    }
}

// MARK: - Terrain carving

/**
 * Random-walk blobs of cliff and rough, mirrored as they are written so the
 * two halves stay identical without a second pass.
 *
 * Returns the gaps punched through the ridgelines. They are not turned into
 * passes here because that needs the landing zones, which do not exist yet.
 */
private func carveTerrain(
    _ map: inout GameMap, _ rng: inout RNG, _ character: MapCharacter, hasLandmark: Bool
) -> [(x: Int, y: Int)] {
    let width = map.width
    let height = map.height
    let blobs = jsRoundInt(Double(width * height) / 220 * character.blobs)

    // Ridgelines first, so the blobs weather them rather than the other way
    // round. A map made only of random blobs has texture but no *shape* — no
    // line you can hold, no flank that means anything.
    var passes: [(x: Int, y: Int)] = []
    let ridges = max(1, jsRoundInt(Double(width * height) / 3400 * character.ridges))
    for _ in 0..<ridges {
        carveRidge(&map, &rng, &passes)
    }

    for _ in 0..<blobs {
        let kind: Terrain = rng.chance(0.55) ? .cliff : .rough
        var x = rng.int(width)
        var y = rng.int(height)
        let steps = 6 + rng.int(kind == .cliff ? 14 : 26)

        for _ in 0..<steps {
            paintMirrored(&map, x, y, kind)
            if rng.chance(0.4) { paintMirrored(&map, x + 1, y, kind) }
            if rng.chance(0.4) { paintMirrored(&map, x, y + 1, kind) }
            x += rng.int(3) - 1
            y += rng.int(3) - 1
            if x < 1 || y < 1 || x >= width - 1 || y >= height - 1 { break }
        }
    }

    // Ponds. Still purely to break up sightlines — the watercourse below is a
    // different feature with a different job.
    for _ in 0..<character.ponds {
        let cx = rng.int(width)
        let cy = rng.int(height)
        let r = 2 + rng.int(3)
        for y in (cy - r)...(cy + r) {
            for x in (cx - r)...(cx + r) {
                if (x - cx) * (x - cx) + (y - cy) * (y - cy) <= r * r {
                    paintMirrored(&map, x, y, .water)
                }
            }
        }
    }

    // The river last, so a blob cannot land in the channel and plug it.
    //
    // Not on a map that carries a landmark, and the reason is arithmetic rather
    // than taste: `placeLandmark` clears a ring around its footprint so there
    // is a way to the door — nineteen cells across for the castle, wider than
    // any channel — and it runs after this, by fiat, on ground it does not
    // check. A watercourse that partitions the map on some seeds and not others
    // is worse than one that never does.
    if !hasLandmark && min(width, height) >= 64 { carveRiver(&map, &rng, character) }

    // Keep a one-cell impassable border so nothing walks off the world.
    for x in 0..<width {
        map.terrain[x] = Terrain.cliff.rawValue
        map.terrain[(height - 1) * width + x] = Terrain.cliff.rawValue
    }
    for y in 0..<height {
        map.terrain[y * width] = Terrain.cliff.rawValue
        map.terrain[y * width + width - 1] = Terrain.cliff.rawValue
    }

    return passes
}

/**
 * A long wall of cliff with passes cut through it.
 *
 * Walks a mostly-straight line with a wandering thickness, and punches a gap
 * every so often. The gaps are the point: a solid ridge partitions the map,
 * and a ridge with three passes in it is a map where holding a pass is worth
 * something. Written mirrored, so the pass on your side is the pass on theirs.
 *
 * The gaps are recorded as they are cut. Rediscovering them afterwards would
 * mean looking for holes in a wall that the blob pass has already weathered and
 * the river may have cut through, and a pass found that way is wherever the
 * erosion happened to leave one rather than where the ridge was designed to
 * have one.
 */
private func carveRidge(_ map: inout GameMap, _ rng: inout RNG, _ passes: inout [(x: Int, y: Int)])
{
    let width = map.width
    let height = map.height
    let horizontal = rng.chance(0.5)
    let span = horizontal ? width : height
    let length = jsRoundInt(Double(span) * (0.45 + rng.next() * 0.35))

    // Start off-centre and run across; a ridge through the exact middle would
    // mirror onto itself and read as a wall rather than as terrain.
    var drift = horizontal ? 6 + rng.int(height - 12) : 6 + rng.int(width - 12)
    let from = rng.int(max(1, span - length))

    var sinceGap = 0
    for s in 0..<max(0, length) {
        sinceGap += 1
        // A pass every eight to eighteen cells, four cells wide.
        if sinceGap > 8 + rng.int(10) {
            sinceGap = -4
            passes.append(
                (
                    x: horizontal ? from + s + 2 : drift + 1,
                    y: horizontal ? drift + 1 : from + s + 2
                ))
            continue
        }
        if sinceGap < 0 { continue }

        let thickness = 1 + rng.int(3)
        for t in 0..<thickness {
            let x = horizontal ? from + s : drift + t
            let y = horizontal ? drift + t : from + s
            paintMirrored(&map, x, y, .cliff)
        }
        // Rough ground at the foot of the ridge — scree, and a movement
        // penalty that makes going round it feel like going round something.
        let footX = horizontal ? from + s : drift - 1
        let footY = horizontal ? drift - 1 : from + s
        if rng.chance(0.5) { paintMirroredIf(&map, footX, footY, .rough, .ground) }

        if rng.chance(0.34) { drift += rng.int(3) - 1 }
        if drift < 3 { drift = 3 }
        if drift > (horizontal ? height : width) - 5 { drift = (horizontal ? height : width) - 5 }
    }
}

// MARK: - The river

/// Steps the channel centre may take, weighted toward not turning at all.
private let meander = [-1, 0, 0, 1]

/**
 * A watercourse across the middle of the map, and the crossings over it.
 *
 * The strongest thing a map can have. Two decorative ponds break up a
 * sightline; a river makes every approach a *decision about which crossing*.
 * Both landing zones sit on opposite corners, so a channel through the middle
 * lies across the line between them however it is oriented.
 *
 * Only the half from the map's centre out to one edge is walked. Every cell is
 * written through `paintMirrored`, so the far half is the exact 180° image of
 * the near one and the two meet at the centre by construction — the same
 * rolled-once-stamped-twice discipline as the wreck fields and the props.
 *
 * The river is deliberately *not* a hard partition, and that was measured
 * rather than chosen: water edge to edge ran six-minute AI skirmishes to
 * sixteen or never, and left two campaign missions unwinnable. Marsh at each
 * end at 1.7 against open ground's 1.0 means going round is always available
 * and always expensive, which keeps the crossings the routes that matter.
 *
 * The middle crossing is a ford rather than a bridge for the same reason.
 * Wide, shallow, rough underfoot — the slow, safe way over, and nothing can
 * drop it because it is not built. The flanking bridges are the fast, narrow
 * way, and they are the ones worth holding.
 */
private func carveRiver(_ map: inout GameMap, _ rng: inout RNG, _ character: MapCharacter) {
    let width = map.width
    let height = map.height
    let horizontal = rng.chance(0.5)
    let span = horizontal ? width : height
    let cross = horizontal ? height : width
    let half = (span - 1) / 2

    // Where exactly the water stops is the most important number in this pass.
    // It starts a clear eight cells past the landing zone rather than at some
    // fraction of the span, because `clearArea` levels a thirteen-cell box
    // around each zone *after* this runs. A channel reaching further out than
    // that gets flattened into a causeway at somebody's front door — on those
    // seeds the start ended up inside a hole in its own river, and shutting the
    // crossings walled the base in completely.
    //
    // Symmetric by construction: the water stops at `margin` and its mirror
    // stops at `span - 1 - margin`, so each player has the same marsh to wade.
    let inset = jsRoundInt(Double(min(width, height)) * 0.16)
    let margin = inset + 8

    let baseWidth = max(3, character.riverWidth + rng.int(2))
    var centres = [Int](repeating: 0, count: span)
    var widths = [Int](repeating: 0, count: span)

    // The channel that self-mirrors: an interval [c, c+w) maps onto itself only
    // at c = (cross - w) / 2. Starting there is what makes the two halves join
    // at the centre instead of meeting in a diagonal kink.
    let mid = (cross - baseWidth) / 2
    let band = jsRoundInt(Double(cross) * 0.17)

    // The channel's position is tracked as a fraction and rounded to a cell.
    // Stepping a whole cell per turn means a held direction runs at exactly 45°,
    // which draws a zigzag rather than a river. Half a cell per step gives a
    // shallow reach that takes twenty cells to move ten — and keeps the
    // channel's movement under one cell per step, so consecutive spans always
    // overlap and nothing can slip diagonally between them.
    var pos = Double(mid)
    var c = mid
    var drift = 0
    for s in stride(from: half, through: margin, by: -1) {
        // A little breathing in the width. Never below three: at two cells a
        // diagonal step can find the corner between two water cells, and a
        // river you can walk over is a decorative stripe.
        let w = max(3, baseWidth + (rng.chance(0.12) ? 1 : 0))
        centres[s] = c
        widths[s] = w

        for t in 0..<w { paintChannel(&map, horizontal, s, c + t, .water) }
        // Silt on both banks: texture, and a cost on the approach that makes
        // the crossings feel like crossings for one extra cell either side.
        if rng.chance(0.55) { paintChannelIf(&map, horizontal, s, c - 1, .rough) }
        if rng.chance(0.55) { paintChannelIf(&map, horizontal, s, c + w, .rough) }

        // Meander: a held direction rather than a fresh coin flip per cell,
        // which is the difference between a curve and a jitter. Straight is
        // twice as likely as either turn — an even three-way pick spends two
        // thirds of its length at exactly 45°, which on the minimap is not a
        // river but a lightning bolt.
        if rng.chance(0.3) { drift = meander[rng.int(meander.count)] }
        pos += Double(drift) * 0.5
        if pos < Double(mid - band) {
            pos = Double(mid - band)
            drift = 1
        }
        if pos > Double(mid + band) {
            pos = Double(mid + band)
            drift = -1
        }
        c = jsRoundInt(pos)
    }

    // The marsh, running on from where the water stops out to the edge. Wider
    // than the channel and widening as it goes, because a river ends in a fan
    // rather than a stub — and because the wider it is the more it costs to
    // wade, which is the whole job it is doing.
    for m in stride(from: margin - 1, through: 1, by: -1) {
        let spread = margin - m
        for t in (-1 - spread)..<(widths[margin] + 1 + spread) {
            // Only over open ground: the marsh is what the river leaves behind,
            // not something that eats the cliffs and the districts at the edge.
            paintChannelIf(&map, horizontal, m, centres[margin] + t, .rough)
        }
    }

    // Mirror the record. The cells are already mirrored on the grid; this is so
    // `bankOf` can answer for the far half without a second walk.
    for s in (half + 1)..<(span - margin) {
        let ms = span - 1 - s
        widths[s] = widths[ms]
        centres[s] = cross - centres[ms] - widths[ms]
    }

    map.river = GameMap.River(
        horizontal: horizontal, span: span, cross: cross, margin: margin,
        centres: centres, widths: widths)

    // The ford, dead centre, self-mirroring. Fourteen cells of shallows, and
    // the width is the load-bearing number in the whole feature: an army that
    // has to file through a narrow gap arrives piecemeal, gets broken at the
    // crossing and goes home to rebuild, and neither side can ever land a blow.
    addCrossing(&map, half, 6, "ford", 0, .rough)

    // Two pairs of bridges, spread down each half of the channel. Spread across
    // the *water's* reach rather than the map's span, which is the only version
    // of this that survives the marsh: positioned as a fraction of the span, a
    // bridge could land out past where the channel stops, and a deck over a
    // channel that is not there is five cells of road at the map's edge.
    let pairs = character.riverPairs
    let from = margin + 5
    let to = half - 6
    for i in 0..<pairs {
        let t = (Double(i) + 0.35 + rng.next() * 0.3) / Double(pairs)
        addCrossing(
            &map, jsRoundInt(Double(from) + Double(to - from) * t), 2, "bridge", 2, .road)
    }
}

/// One cell of the channel, in river coordinates, mirrored.
private func paintChannel(
    _ map: inout GameMap, _ horizontal: Bool, _ along: Int, _ across: Int, _ kind: Terrain
) {
    paintMirrored(&map, horizontal ? along : across, horizontal ? across : along, kind)
}

/// The same, but only over open ground — used for banks, not for the channel.
private func paintChannelIf(
    _ map: inout GameMap, _ horizontal: Bool, _ along: Int, _ across: Int, _ kind: Terrain
) {
    paintMirroredIf(
        &map, horizontal ? along : across, horizontal ? across : along, kind, .ground)
}

/**
 * Lay a crossing over the channel and record it.
 *
 * `reach` is how far along the river the deck runs either side of its centre,
 * so a bridge is a five-cell strip and the ford is fourteen. The deck is
 * painted over everything in its footprint including cliff, for the same reason
 * `paveLine` paves cliff: a crossing that dead-ends into a rock face on one
 * bank is a crossing nobody can use, and the whole map's connectivity now runs
 * through these.
 *
 * Written directly rather than through `paintMirrored`, then recorded twice,
 * because the deck's *extent* differs between the two halves — the channel is
 * not the same width at `along` as at its mirror — and a mirrored write would
 * stamp the near half's rectangle onto the far half's channel.
 */
private func addCrossing(
    _ map: inout GameMap, _ along: Int, _ reach: Int, _ kind: String, _ bank: Int,
    _ terrain: Terrain
) {
    guard let river = map.river else { return }
    let twin = river.span - 1 - along
    if abs(twin - along) <= 1 {
        // A crossing on the mirror line is its own twin, and on an even span
        // the two centres land one cell apart. Recording both would put two
        // overlapping fords where the map has one — but taking just one of them
        // is worse: its deck would run from 66 to 76 where its own mirror image
        // runs from 67 to 77, and a crossing that is not its own mirror is a
        // crossing one player reaches a cell sooner. So it is written once,
        // over the union of the two.
        recordCrossing(
            &map, river, min(along, twin) - reach, max(along, twin) + reach, kind, bank, terrain)
        return
    }
    recordCrossing(&map, river, along - reach, along + reach, kind, bank, terrain)
    recordCrossing(&map, river, twin - reach, twin + reach, kind, bank, terrain)
}

private func recordCrossing(
    _ map: inout GameMap, _ river: GameMap.River, _ from: Int, _ to: Int, _ kind: String,
    _ bank: Int, _ terrain: Terrain
) {
    let horizontal = river.horizontal
    var lo = Int.max
    var hi = Int.min

    // `stride` rather than a range, because `from` can exceed `to` — a deck
    // whose reach falls off the end of the channel records nothing, where a
    // Swift range would trap.
    for s in stride(from: from, through: to, by: 1) {
        if s < 1 || s >= river.span - 1 { continue }
        let c = river.centres[s]
        let w = river.widths[s]
        // Outside the water's reach there is no channel to deck over, and the
        // record is all zeroes. Painting it anyway laid a bridge across the top
        // two rows of the map — unmirrored, because this writes terrain
        // directly — and the symmetry tests found it before anyone had to look
        // at the corner of a map and wonder what that was.
        if w == 0 { continue }
        // `bank` is how far up the dry ground the crossing reaches. A bridge
        // needs two cells of abutment so the deck lands on something; a ford is
        // nothing but the channel gone shallow, and painting *it* two cells onto
        // each bank turned the river's one soft feature into a hard grey
        // rectangle laid across it — visibly a block rather than a shallows.
        for t in (c - bank)..<(c + w + bank) {
            let x = horizontal ? s : t
            let y = horizontal ? t : s
            if !inBounds(map, x, y) { continue }
            if x < 1 || y < 1 || x >= map.width - 1 || y >= map.height - 1 { continue }
            map.terrain[y * map.width + x] = terrain.rawValue
            lo = min(lo, t)
            hi = max(hi, t)
        }
    }
    if lo == Int.max { return }

    let mid = jsRoundInt(Double(from + to) / 2)
    let across = jsRoundInt(Double(lo + hi) / 2)
    map.crossings.append(
        GameMap.Crossing(
            kind: kind,
            x: horizontal ? mid : across,
            y: horizontal ? across : mid,
            horizontal: horizontal,
            x0: horizontal ? from : lo,
            x1: horizontal ? to : hi,
            y0: horizontal ? lo : from,
            y1: horizontal ? hi : to))
}

/// Where along its own axis the river actually has a channel.
private func inReach(_ river: GameMap.River, _ s: Int) -> Bool {
    s >= river.margin && s < river.span - river.margin
}

/// Is this cell in the river's channel — the water, not the deck over it?
private func inChannel(_ map: GameMap, _ x: Int, _ y: Int) -> Bool {
    guard let r = map.river else { return false }
    let s = r.horizontal ? x : y
    let t = r.horizontal ? y : x
    // `inReach` is also what keeps `s` a legal index: it is `s >= margin &&
    // s < span - margin`, and margin is never negative.
    if !inReach(r, s) { return false }
    if t < r.centres[s] || t >= r.centres[s] + r.widths[s] { return false }
    return !onCrossing(map, x, y)
}

/**
 * Which side of the river a cell is on: -1, 1, or 0 for in the channel or on a
 * map with no river.
 *
 * One array lookup rather than a flood fill, which is the whole reason the
 * channel is stored as centres and widths instead of as a cell mask. Zero in
 * the open reach off each end of the channel, and that is the honest answer
 * rather than a fallback: out there the river separates nothing, so a road
 * between two points in it has no reason to detour to a bridge.
 */
public func bankOf(_ map: GameMap, _ x: Int, _ y: Int) -> Int {
    guard let r = map.river else { return 0 }
    let s = r.horizontal ? x : y
    let t = r.horizontal ? y : x
    if !inReach(r, s) { return 0 }
    if t < r.centres[s] { return -1 }
    if t >= r.centres[s] + r.widths[s] { return 1 }
    return 0
}

/**
 * Find the places the river is no longer wet, and call them crossings.
 *
 * A wreck field flattens impassable cells so scrap is never stranded on a
 * cliff, and it does that without asking what was under it. Field anchors are
 * nudged off the water for exactly this reason, but the nudge can fail on a
 * crowded map and then the channel has a hole in it.
 *
 * Rather than fight that, this reads the truth back off the grid. A dry run of
 * channel is a crossing whether or not anything meant it to be, and a hole the
 * map does not know about is a hole that gets no road, no bunkers and no bridge
 * deck drawn on it — which is how a player ends up walking over water.
 */
private func noteRiverBreaches(_ map: inout GameMap) {
    guard let river = map.river else { return }
    let horizontal = river.horizontal
    let span = river.span
    var runStart = -1

    func close(_ from: Int, _ to: Int) {
        // Under three cells is a chip out of the bank, not a way across.
        if from < 0 || to - from < 2 { return }
        let a = jsRoundInt(Double(from + to) / 2)
        let c = river.centres[a]
        let w = river.widths[a]
        map.crossings.append(
            GameMap.Crossing(
                kind: "causeway",
                x: horizontal ? a : c + w / 2,
                y: horizontal ? c + w / 2 : a,
                horizontal: horizontal,
                x0: horizontal ? from : c - 1,
                x1: horizontal ? to : c + w,
                y0: horizontal ? c - 1 : from,
                y1: horizontal ? c + w : to))
    }

    for s in river.margin..<(span - river.margin) {
        var wet = false
        for t in river.centres[s]..<(river.centres[s] + river.widths[s]) {
            let x = horizontal ? s : t
            let y = horizontal ? t : s
            if terrainAt(map, x, y) == .water {
                wet = true
                break
            }
        }
        // A deck is a dry run on purpose and is already recorded; skip it or
        // every bridge would be logged twice, once as itself and once as a
        // breach.
        let probeX = horizontal ? s : river.centres[s]
        let probeY = horizontal ? river.centres[s] : s
        if !wet && !onCrossing(map, probeX, probeY) {
            if runStart < 0 { runStart = s }
        } else {
            close(runStart, s - 1)
            runStart = -1
        }
    }
    close(runStart, span - river.margin - 1)
}

/// Is this cell inside any recorded crossing's rectangle?
private func onCrossing(_ map: GameMap, _ x: Int, _ y: Int) -> Bool {
    for c in map.crossings {
        if x >= c.x0 - 1 && x <= c.x1 + 1 && y >= c.y0 - 1 && y <= c.y1 + 1 { return true }
    }
    return false
}

// MARK: - The chokepoints

/**
 * Turn the ridgelines' gaps into passes worth the name.
 *
 * A four-cell gap in a ridge is a gap. What makes it a *pass* is that it is
 * wide enough to fight in rather than to file through, that the road goes
 * through it, that there is something at it worth taking, and that a player can
 * see all three from the minimap. This does the first; `routeRoad` does the
 * second, the pass cache does the third, and `garrisonChokepoints` the fourth.
 *
 * Not every gap: a map where every gap is a landmark has no landmarks. Under
 * half of them are widened, the rest stay as the goat tracks they were —
 * usable, unimproved, and the flank that a player who has read the map takes
 * while everybody else is at the pass.
 */
private func openPasses(_ map: inout GameMap, _ rng: inout RNG, _ passes: [(x: Int, y: Int)]) {
    let width = map.width
    let height = map.height
    var caches = 0

    for p in passes {
        if p.x < 10 || p.y < 10 || p.x >= width - 10 || p.y >= height - 10 { continue }
        // A pass inside somebody's base is a back door, not a chokepoint.
        if nearAny(map.starts.map { (x: $0.x, y: $0.y) }, p.x, p.y, 20) { continue }
        if nearAny(map.chokepoints.map { (x: $0.x, y: $0.y) }, p.x, p.y, 14) { continue }
        // A gap the river runs through is a gorge. Widening it makes a wider
        // riverbank, garrisoning it puts blockhouses on the wrong side of the
        // water from each other, and routing a road through it paves up to the
        // channel and stops. The map already has a name for the places you can
        // get over the river and this is not one of them.
        if wetWithin(map, p.x, p.y, 4) { continue }

        let major = rng.chance(0.45)
        if major {
            // Widen to about seven cells and skirt it in scree, so the shape of
            // the gap survives the blobs that were painted over it.
            for dy in -3...3 {
                for dx in -3...3 {
                    let d = len(Double(dx), Double(dy))
                    if d > 3.2 { continue }
                    if d > 2.2 { paintMirroredIf(&map, p.x + dx, p.y + dy, .rough, .cliff) }
                    else { paintMirroredIf(&map, p.x + dx, p.y + dy, .ground, .cliff) }
                }
            }
        }

        // At most two cached passes a map, and only major ones. Scrap at every
        // chokepoint is an economy, not a decision. Short-circuited exactly as
        // the JavaScript is: a minor gap, or a map that already has its two,
        // must not draw here at all.
        let cache = major && caches < 2 && rng.chance(0.7)
        if cache { caches += 1 }

        let kind = major ? "pass" : "gap"
        map.chokepoints.append(
            GameMap.Chokepoint(kind: kind, x: p.x, y: p.y, primary: true, cache: cache))
        map.chokepoints.append(
            GameMap.Chokepoint(
                kind: kind, x: width - 1 - p.x, y: height - 1 - p.y, primary: false, cache: cache))
    }
}

/**
 * Put something at the chokepoints.
 *
 * The map already routes its roads through them and puts scrap in some of them,
 * but neither of those is visible from a hundred cells away. Two blockhouses
 * either side of the gap are: they say *somebody held this*, which is the only
 * sentence a piece of scenery needs to say for a player to understand why they
 * are about to fight there.
 *
 * The fuel on a bridgehead is deliberate cruelty. A bridge is the one place on
 * the map where both sides have to come to the same twelve cells. Only some
 * bridges get one; a rule is a habit, and a habit is not a decision.
 *
 * The ford gets nothing, on purpose. Nobody built it — it is where the river
 * happens to be shallow — and a crossing with no cover on it is a different
 * proposition from one with blockhouses at both ends. That difference is the
 * whole reason the map has two kinds of crossing.
 */
private func garrisonChokepoints(_ map: inout GameMap, _ rng: inout RNG) {
    for c in map.chokepoints {
        if !c.primary || c.kind != "pass" { continue }
        addPropPairNear(&map, "bunker", c.x - 5, c.y - 1)
        addPropPairNear(&map, "bunker", c.x + 3, c.y + 1)
        if rng.chance(0.5) { addPropPairNear(&map, "mast", c.x - 1, c.y - 5) }
        if rng.chance(0.4) { addPropPairNear(&map, "bus", c.x + 1, c.y + 4) }
    }

    for c in map.crossings {
        if c.kind != "bridge" { continue }
        // Off the ends of the deck, on whichever bank has ground for them.
        for end in [-1, 1] {
            var atX = Double(c.x)
            var atY = Double(c.y)
            let step =
                Double(end * (c.horizontal ? c.y1 - c.y0 : c.x1 - c.x0)) / 2 + Double(end * 3)
            if c.horizontal {
                atY += step
                atX += 2
            } else {
                atX += step
                atY += 2
            }
            addPropPairNear(&map, "bunker", jsRoundInt(atX), jsRoundInt(atY))
        }
        if rng.chance(0.45) {
            addPropPairNear(&map, "gasstation", c.x - 4, c.y + (c.horizontal ? 4 : 1))
        }
    }
}

/// Paint only where the current terrain is `only` — used to skirt, not carve.
private func paintMirroredIf(
    _ map: inout GameMap, _ x: Int, _ y: Int, _ kind: Terrain, _ only: Terrain
) {
    if !inBounds(map, x, y) { return }
    if map.terrain[y * map.width + x] != only.rawValue { return }
    paintMirrored(&map, x, y, kind)
}

private func paintMirrored(_ map: inout GameMap, _ x: Int, _ y: Int, _ kind: Terrain) {
    let width = map.width
    let height = map.height
    if x < 0 || y < 0 || x >= width || y >= height { return }
    map.terrain[y * width + x] = kind.rawValue
    map.terrain[(height - 1 - y) * width + (width - 1 - x)] = kind.rawValue
}

/// Strip scrap from a radius. Symmetric by construction, because it is applied
/// to every start and the starts are each other's mirror.
private func clearResource(_ map: inout GameMap, _ cx: Int, _ cy: Int, _ r: Int) {
    for y in (cy - r)...(cy + r) {
        for x in (cx - r)...(cx + r) {
            if !inBounds(map, x, y) { continue }
            let i = y * map.width + x
            map.resource[i] = 0
            map.resourceMax[i] = 0
        }
    }
}

/// Flatten a radius to buildable ground — used around start positions.
private func clearArea(_ map: inout GameMap, _ cx: Int, _ cy: Int, _ r: Int) {
    for y in (cy - r)...(cy + r) {
        for x in (cx - r)...(cx + r) {
            if !inBounds(map, x, y) { continue }
            if x == 0 || y == 0 || x == map.width - 1 || y == map.height - 1 { continue }
            map.terrain[y * map.width + x] = Terrain.ground.rawValue
        }
    }
}

// MARK: - Wreck fields

/**
 * A wreck field, moved off the water first.
 *
 * `stampField` flattens impassable terrain so scrap is never stranded on a
 * cliff, and that rule quietly became a hole-punch the moment there was a
 * river: a field whose ragged edge reached the channel filled it in. The centre
 * field did it on every seed, because a 180°-symmetric watercourse has to pass
 * through the centre of the map and that is exactly where the richest field is
 * anchored.
 *
 * The nudge is a deterministic spiral rather than a roll — a field that
 * consumed rng only on maps with rivers would make every downstream decision
 * depend on the weather. Where the spiral finds nowhere dry the field is
 * stamped anyway: an unreachable start is a worse map than a breached river,
 * and `noteRiverBreaches` will notice and call the hole a causeway.
 */
private func addDryFieldPair(
    _ map: inout GameMap, _ cx: Int, _ cy: Int, _ r: Int, _ amountPerCell: Int, _ rng: inout RNG
) {
    let dry = map.river != nil ? driestNear(map, cx, cy, r) : (x: cx, y: cy)
    addFieldPair(&map, dry.x, dry.y, r, amountPerCell, &rng)
}

/// Spiral out for an anchor whose field would not touch water.
private func driestNear(_ map: GameMap, _ cx: Int, _ cy: Int, _ r: Int) -> (x: Int, y: Int) {
    if !wetWithin(map, cx, cy, r + 1) { return (x: cx, y: cy) }
    for d in stride(from: 3, through: 21, by: 3) {
        for a in 0..<8 {
            let off = ringOffset(a + 1, radius: Double(d))
            let x = jsRoundInt(Double(cx) + off.x)
            let y = jsRoundInt(Double(cy) + off.y)
            if x < r + 2 || y < r + 2 { continue }
            if x >= map.width - r - 2 || y >= map.height - r - 2 { continue }
            if nearAny(map.starts.map { (x: $0.x, y: $0.y) }, x, y, 10) { continue }
            if !wetWithin(map, x, y, r + 1) { return (x: x, y: y) }
        }
    }
    return (x: cx, y: cy)
}

private func wetWithin(_ map: GameMap, _ cx: Int, _ cy: Int, _ r: Int) -> Bool {
    for y in (cy - r)...(cy + r) {
        for x in (cx - r)...(cx + r) {
            if !inBounds(map, x, y) { continue }
            if map.terrain[y * map.width + x] == Terrain.water.rawValue { return true }
        }
    }
    return false
}

/**
 * A wreck field and its exact 180° mirror image. The shape is rolled once
 * and stamped twice, so both halves of the map are provably identical.
 *
 * A field centred on the map's own centre would mirror onto itself; that is
 * harmless — the second stamp simply rewrites the same cells.
 */
private func addFieldPair(
    _ map: inout GameMap, _ cx: Int, _ cy: Int, _ r: Int, _ amountPerCell: Int, _ rng: inout RNG
) {
    struct ShapeCell {
        let dx: Int
        let dy: Int
        let amount: Int
    }
    var shape: [ShapeCell] = []
    for y in (cy - r)...(cy + r) {
        for x in (cx - r)...(cx + r) {
            let d = len(Double(x - cx), Double(y - cy))
            if d > Double(r) { continue }
            if d > Double(r) * 0.55 && rng.chance(0.45) { continue }
            let amount = jsRoundInt(Double(amountPerCell) * (1 - (d / Double(r)) * 0.4))
            shape.append(ShapeCell(dx: x - cx, dy: y - cy, amount: amount))
        }
    }

    stampField(&map, cx, cy, shape.map { (dx: $0.dx, dy: $0.dy, amount: $0.amount) }, 1)
    stampField(&map, map.width - 1 - cx, map.height - 1 - cy, shape.map { (dx: $0.dx, dy: $0.dy, amount: $0.amount) }, -1)
}

private func stampField(
    _ map: inout GameMap, _ cx: Int, _ cy: Int, _ shape: [(dx: Int, dy: Int, amount: Int)], _ sign: Int
) {
    var cells: [(x: Int, y: Int)] = []
    for s in shape {
        let x = cx + s.dx * sign
        let y = cy + s.dy * sign
        if !inBounds(map, x, y) { continue }
        // Never into the channel, and this is a hard rule rather than a
        // preference. Flattening below is what stops scrap being stranded on a
        // cliff, and it does not care what it is flattening: a field whose
        // ragged edge reached the river drained a two-cell notch through it and
        // handed the map a free crossing nobody could see. `addDryFieldPair`
        // moves the anchors that can be moved; this catches the ones that
        // cannot — the quarry's pit field is anchored to the pit and has
        // nowhere else to go.
        if inChannel(map, x, y) { continue }
        let i = y * map.width + x
        // Scrap sitting on a cliff would be unreachable; flatten it.
        if !terrainInfo[Int(map.terrain[i])].passable { map.terrain[i] = Terrain.ground.rawValue }
        // Take the richer of the two where fields overlap. A centre field
        // mirrors onto itself and would otherwise have its own first stamp
        // overwritten by its second, quietly breaking the symmetry it was
        // meant to guarantee.
        if s.amount > Int(map.resource[i]) { map.resource[i] = UInt16(s.amount) }
        if s.amount > Int(map.resourceMax[i]) { map.resourceMax[i] = UInt16(s.amount) }
        cells.append((x: x, y: y))
    }
    if !cells.isEmpty { map.fields.append(GameMap.Field(x: cx, y: cy, cells: cells)) }
}

// MARK: - Queries

public func inBounds(_ map: GameMap, _ x: Int, _ y: Int) -> Bool {
    x >= 0 && y >= 0 && x < map.width && y < map.height
}

public func terrainAt(_ map: GameMap, _ x: Int, _ y: Int) -> Terrain {
    if !inBounds(map, x, y) { return .cliff }
    return Terrain(rawValue: map.terrain[y * map.width + x]) ?? .cliff
}

/// Can a ground unit stand here? Air callers should not ask — they never
/// consult the grid at all.
public func isWalkable(_ map: GameMap, _ x: Int, _ y: Int) -> Bool {
    if !inBounds(map, x, y) { return false }
    let i = y * map.width + x
    return terrainInfo[Int(map.terrain[i])].passable && map.occupied[i] == 0
}

/// Movement cost multiplier, or +infinity where a unit cannot go.
public func moveCost(_ map: GameMap, _ x: Int, _ y: Int) -> Double {
    if !inBounds(map, x, y) { return .infinity }
    let i = y * map.width + x
    if map.occupied[i] != 0 { return .infinity }
    return terrainInfo[Int(map.terrain[i])].cost
}

/// Every cell a structure of this size anchored at (cx, cy) would cover.
public func footprint(_ size: (width: Int, height: Int), _ cx: Int, _ cy: Int) -> [(x: Int, y: Int)] {
    var cells: [(x: Int, y: Int)] = []
    for y in 0..<size.height {
        for x in 0..<size.width {
            cells.append((x: cx + x, y: cy + y))
        }
    }
    return cells
}

/**
 * Placement legality: flat, unoccupied, resource-free ground.
 * Deliberately strict — a half-buildable footprint is the most common source
 * of "why is my refinery in the cliff" bug reports in every RTS ever shipped.
 */
public func canPlace(_ map: GameMap, _ size: (width: Int, height: Int), _ cx: Int, _ cy: Int) -> Bool {
    for c in footprint(size, cx, cy) {
        if !inBounds(map, c.x, c.y) { return false }
        let i = c.y * map.width + c.x
        if map.terrain[i] != Terrain.ground.rawValue { return false }
        if map.occupied[i] != 0 { return false }
        if map.resource[i] > 0 { return false }
    }
    return true
}

public func occupy(_ map: inout GameMap, _ size: (width: Int, height: Int), _ cx: Int, _ cy: Int, _ entityId: UInt32) {
    for c in footprint(size, cx, cy) {
        if inBounds(map, c.x, c.y) { map.occupied[c.y * map.width + c.x] = entityId }
    }
}

public func vacate(_ map: inout GameMap, _ size: (width: Int, height: Int), _ cx: Int, _ cy: Int) {
    for c in footprint(size, cx, cy) {
        if inBounds(map, c.x, c.y) { map.occupied[c.y * map.width + c.x] = 0 }
    }
}

/// Nearest walkable cell to (x, y), spiralling outward. Nil if hopeless.
public func nearestWalkable(_ map: GameMap, _ x: Int, _ y: Int, maxRadius: Int = 12) -> (x: Int, y: Int)? {
    if isWalkable(map, x, y) { return (x, y) }
    for r in 1...maxRadius {
        for dy in -r...r {
            for dx in -r...r {
                if max(abs(dx), abs(dy)) != r { continue }
                if isWalkable(map, x + dx, y + dy) { return (x: x + dx, y: y + dy) }
            }
        }
    }
    return nil
}

// MARK: - Pathfinding

/// Binary min-heap over integer items keyed by a Double, matching the
/// hand-rolled heap in grid.js — A* is the only place in the engine that
/// needs a priority queue, so it is not worth a dependency.
private struct MinHeap {
    private var items: [Int] = []
    private var keys: [Double] = []

    var size: Int { items.count }

    mutating func push(_ item: Int, _ key: Double) {
        items.append(item)
        keys.append(key)
        var i = items.count - 1
        while i > 0 {
            let p = (i - 1) >> 1
            if keys[p] <= keys[i] { break }
            swapAt(i, p)
            i = p
        }
    }

    mutating func pop() -> Int {
        let top = items[0]
        let lastItem = items.removeLast()
        let lastKey = keys.removeLast()
        if !items.isEmpty {
            items[0] = lastItem
            keys[0] = lastKey
            var i = 0
            while true {
                let l = i * 2 + 1
                let r = l + 1
                var m = i
                if l < keys.count && keys[l] < keys[m] { m = l }
                if r < keys.count && keys[r] < keys[m] { m = r }
                if m == i { break }
                swapAt(i, m)
                i = m
            }
        }
        return top
    }

    private mutating func swapAt(_ a: Int, _ b: Int) {
        items.swapAt(a, b)
        keys.swapAt(a, b)
    }
}

private let sqrt2 = 2.0.squareRoot()

/// Octile distance — the admissible heuristic for 8-way movement.
/// Octile distance, scaled to the cheapest terrain — the admissible heuristic
/// for 8-way movement over a grid where a step can cost less than one.
private func heuristic(_ ax: Double, _ ay: Double, _ bx: Double, _ by: Double) -> Double {
    let dx = abs(ax - bx)
    let dy = abs(ay - by)
    return (dx + dy + (sqrt2 - 2) * min(dx, dy)) * minTerrainCost
}

/**
 * A* over the cell grid.
 *
 * `goalRadius` lets a caller path *toward* something it cannot stand on — a
 * building, a wreck field, an enemy — by accepting any cell within that many
 * cells of the goal. Without it, every order issued onto an occupied cell
 * would search the entire map before failing.
 *
 * Returns an array of cell coordinates excluding the start, or nil.
 */
public func findPath(
    _ map: GameMap, _ sx: Int, _ sy: Int, _ gx: Int, _ gy: Int,
    goalRadius: Int = 0, maxNodes: Int = 0
) -> [(x: Int, y: Int)]? {
    // The node ceiling has to scale with the map or it stops being a runaway
    // guard and becomes a range limit: 9000 was most of a 72×72 map and is
    // under half of a 144×144 one, so a corner-to-corner order across a big map
    // would bail out early and walk as close as it got — which looks exactly
    // like a unit refusing to cross the map.
    let maxNodes = maxNodes > 0 ? maxNodes : max(9000, jsRoundInt(Double(map.width * map.height) * 1.5))
    if !inBounds(map, sx, sy) || !inBounds(map, gx, gy) { return nil }

    // A goal nobody can stand on is the expensive case, not the rare one: with
    // scenery on the map most stray clicks land on a tree, a wall or a wreck,
    // and A* can only discover "unreachable" by exhausting the search — a
    // whole-map expansion for a ten-cell order. Snapping to the nearest cell
    // that can be stood on turns that back into an ordinary short search.
    //
    // Only when the caller has not asked for a radius. `goalRadius` already
    // means "get near this", and moving the centre out from under it would
    // quietly change what near means.
    var gx = gx
    var gy = gy
    if goalRadius <= 0 && !isWalkable(map, gx, gy) {
        if let spot = nearestWalkable(map, gx, gy, maxRadius: 6) {
            gx = spot.x
            gy = spot.y
        }
    }

    if sx == gx && sy == gy { return [] }

    let w = map.width
    let size = w * map.height
    var cameFrom = [Int32](repeating: -1, count: size)
    var gScore = [Float](repeating: .infinity, count: size)
    var closed = [UInt8](repeating: 0, count: size)
    var open = MinHeap()

    let startIdx = sy * w + sx
    gScore[startIdx] = 0
    open.push(startIdx, heuristic(Double(sx), Double(sy), Double(gx), Double(gy)))

    func reached(_ x: Int, _ y: Int) -> Bool {
        goalRadius <= 0
            ? (x == gx && y == gy)
            : len(Double(x - gx), Double(y - gy)) <= Double(goalRadius)
    }

    var expanded = 0
    var best = -1
    var bestH = Double.infinity

    while open.size > 0 {
        let current = open.pop()
        if closed[current] != 0 { continue }
        closed[current] = 1

        let cx = current % w
        let cy = current / w

        let h = heuristic(Double(cx), Double(cy), Double(gx), Double(gy))
        if h < bestH {
            bestH = h
            best = current
        }

        if reached(cx, cy) { return reconstruct(cameFrom, current, w) }
        expanded += 1
        if expanded > maxNodes { break }

        for dy in -1...1 {
            for dx in -1...1 {
                if dx == 0 && dy == 0 { continue }
                let nx = cx + dx
                let ny = cy + dy
                let cost = moveCost(map, nx, ny)
                if !cost.isFinite { continue }

                // No cutting corners around a blocked cell — units would clip walls.
                if dx != 0 && dy != 0 {
                    if !moveCost(map, cx + dx, cy).isFinite || !moveCost(map, cx, cy + dy).isFinite {
                        continue
                    }
                }

                let ni = ny * w + nx
                if closed[ni] != 0 { continue }
                let step = (dx != 0 && dy != 0 ? sqrt2 : 1.0) * cost
                let tentative = Double(gScore[current]) + step
                if tentative >= Double(gScore[ni]) { continue }

                cameFrom[ni] = Int32(current)
                gScore[ni] = Float(tentative)
                open.push(ni, tentative + heuristic(Double(nx), Double(ny), Double(gx), Double(gy)))
            }
        }
    }

    // Unreachable goal: walk as close as the search got rather than refusing
    // the order outright. Players read a refused move order as the game
    // ignoring them.
    if best >= 0 && best != startIdx { return reconstruct(cameFrom, best, w) }
    return nil
}

private func reconstruct(_ cameFrom: [Int32], _ node: Int, _ w: Int) -> [(x: Int, y: Int)] {
    var path: [(x: Int, y: Int)] = []
    var cur = node
    while cur != -1 {
        path.append((x: cur % w, y: cur / w))
        cur = Int(cameFrom[cur])
    }
    path.removeLast()  // drop the start cell
    path.reverse()
    return path
}

/// Unobstructed straight line between two cell centres?
public func hasLineOfWalk(_ map: GameMap, _ x0: Int, _ y0: Int, _ x1: Int, _ y1: Int) -> Bool {
    let dx = abs(x1 - x0)
    let dy = abs(y1 - y0)
    let sx = x0 < x1 ? 1 : -1
    let sy = y0 < y1 ? 1 : -1
    var err = dx - dy
    var x = x0
    var y = y0

    while true {
        if !moveCost(map, x, y).isFinite { return false }
        if x == x1 && y == y1 { return true }
        let e2 = 2 * err
        if e2 > -dy {
            err -= dy
            x += sx
        }
        if e2 < dx {
            err += dx
            y += sy
        }
    }
}

/**
 * String-pulling: drop every waypoint that can be skipped in a straight
 * line. A* on a grid produces staircases; this is what stops units mincing
 * diagonally across open ground.
 */
public func smoothPath(_ map: GameMap, _ startX: Int, _ startY: Int, _ path: [(x: Int, y: Int)]?) -> [(x: Int, y: Int)] {
    guard let path = path, path.count >= 2 else { return path ?? [] }
    var out: [(x: Int, y: Int)] = []
    var anchorX = startX
    var anchorY = startY
    var i = 0

    while i < path.count {
        var furthest = i
        var j = path.count - 1
        while j > i {
            if hasLineOfWalk(map, anchorX, anchorY, path[j].x, path[j].y) {
                furthest = j
                break
            }
            j -= 1
        }
        out.append(path[furthest])
        anchorX = path[furthest].x
        anchorY = path[furthest].y
        i = furthest + 1
    }
    return out
}
