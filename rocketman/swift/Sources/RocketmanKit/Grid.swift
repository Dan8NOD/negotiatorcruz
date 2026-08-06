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
]

/// Footprint sizes for the destructible scenery placed by `createMap`. Only
/// `size` from engine/content.js PROPS — the rest (hp, armor, death
/// explosions) belongs to entities/combat and has no reader here.
public let propSizes: [String: (width: Int, height: Int)] = [
    "tower": (2, 2),
    "house": (1, 1),
    "gasstation": (2, 1),
    "tree": (1, 1),
    "statue": (1, 1),
    "tank": (1, 1),
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

public func createMap(seed: Int, width: Int = 72, height: Int = 72) -> GameMap {
    var rng = RNG(signedSeed: Int32(truncatingIfNeeded: seed) ^ seedMix)
    var map = GameMap(width: width, height: height)

    carveTerrain(&map, &rng)

    // Start positions on opposing corners of the usable area, mirrored.
    let inset = jsRoundInt(Double(min(width, height)) * 0.16)
    map.starts = [
        GameMap.Start(x: inset, y: inset),
        GameMap.Start(x: width - 1 - inset, y: height - 1 - inset),
    ]

    for s in map.starts { clearArea(&map, s.x, s.y, 6) }

    // One guaranteed field per start, plus contested fields toward the middle.
    // Every field is generated once and then mirrored, never generated twice
    // from the same stream — two independent rolls would give the two halves
    // subtly different scrap, which is the kind of unfairness a player can
    // feel but not name.
    let home = map.starts[0]
    addFieldPair(&map, home.x + 5, home.y + 1, 4, 1500, &rng)
    addFieldPair(&map, jsRoundInt(Double(width) * 0.33), jsRoundInt(Double(height) * 0.62), 5, 1900, &rng)
    addFieldPair(&map, jsRoundInt(Double(width) * 0.5), jsRoundInt(Double(height) * 0.5), 6, 2600, &rng)

    // Scenery last: it reads the finished terrain and the wreck fields so it
    // can refuse to stand on either.
    addNeighbourhood(&map, jsRoundInt(Double(width) * 0.3), jsRoundInt(Double(height) * 0.44), &rng)
    addNeighbourhood(&map, jsRoundInt(Double(width) * 0.62), jsRoundInt(Double(height) * 0.24), &rng)
    addLandmarks(&map, &rng)

    return map
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
        let x = horizontal ? cx + i : cx
        let y = horizontal ? cy : cy + i
        road.append((x: x, y: y))
        // The street itself is kept clear so the block is walkable, not a wall.
        if inBounds(map, x, y) && map.terrain[y * map.width + x] == Terrain.rough.rawValue {
            paintMirrored(&map, x, y, .ground)
        }
    }

    // Houses face the street from both sides, with gaps for driveways.
    for cell in road {
        for side in [-2, 2] {
            if rng.chance(0.28) { continue }
            let x = horizontal ? cell.x : cell.x + side
            let y = horizontal ? cell.y + side : cell.y
            addPropPair(&map, rng.chance(0.18) ? "tree" : "house", x, y)
        }
    }

    // Street trees in the verge.
    for cell in road {
        if !rng.chance(0.3) { continue }
        let side = rng.chance(0.5) ? -1 : 1
        let x = horizontal ? cell.x : cell.x + side
        let y = horizontal ? cell.y + side : cell.y
        addPropPair(&map, "tree", x, y)
    }

    // The corner station.
    let end = road[road.count - 1]
    addPropPair(
        &map, "gasstation",
        horizontal ? end.x + 1 : end.x - 2,
        horizontal ? end.y + 2 : end.y + 1)
}

/**
 * Everything that is not suburbia: a tower cluster downtown, industrial fuel
 * tanks, a monument, and old growth scattered over the rough ground.
 */
private func addLandmarks(_ map: inout GameMap, _ rng: inout RNG) {
    let width = map.width
    let height = map.height

    // Two tower blocks toward the middle — tall cover on the contested ground.
    for _ in 0..<3 {
        let x = jsRoundInt(Double(width) * 0.36) + rng.int(6) - 3
        let y = jsRoundInt(Double(height) * 0.3) + rng.int(8) - 4
        addPropPair(&map, "tower", x, y)
    }

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

    // A tank farm: several volatile props close enough to chain.
    let fx = jsRoundInt(Double(width) * 0.22)
    let fy = jsRoundInt(Double(height) * 0.68)
    for i in 0..<4 {
        addPropPair(&map, "tank", fx + (i % 2) * 2, fy + (i / 2) * 2)
    }

    // Old growth, thickest on rough ground where it reads as untended.
    let trees = jsRoundInt(Double(width * height) / 260)
    for _ in 0..<trees {
        addPropPair(&map, "tree", rng.int(width), rng.int(height))
    }
}

// MARK: - Terrain carving

/**
 * Random-walk blobs of cliff and rough, mirrored as they are written so the
 * two halves stay identical without a second pass.
 */
private func carveTerrain(_ map: inout GameMap, _ rng: inout RNG) {
    let width = map.width
    let height = map.height
    let blobs = jsRoundInt(Double(width * height) / 220)

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

    // A water feature or two, purely to break up sightlines.
    for _ in 0..<2 {
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

    // Keep a one-cell impassable border so nothing walks off the world.
    for x in 0..<width {
        map.terrain[x] = Terrain.cliff.rawValue
        map.terrain[(height - 1) * width + x] = Terrain.cliff.rawValue
    }
    for y in 0..<height {
        map.terrain[y * width] = Terrain.cliff.rawValue
        map.terrain[y * width + width - 1] = Terrain.cliff.rawValue
    }
}

private func paintMirrored(_ map: inout GameMap, _ x: Int, _ y: Int, _ kind: Terrain) {
    let width = map.width
    let height = map.height
    if x < 0 || y < 0 || x >= width || y >= height { return }
    map.terrain[y * width + x] = kind.rawValue
    map.terrain[(height - 1 - y) * width + (width - 1 - x)] = kind.rawValue
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
private func heuristic(_ ax: Double, _ ay: Double, _ bx: Double, _ by: Double) -> Double {
    let dx = abs(ax - bx)
    let dy = abs(ay - by)
    return dx + dy + (sqrt2 - 2) * min(dx, dy)
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
    goalRadius: Int = 0, maxNodes: Int = 9000
) -> [(x: Int, y: Int)]? {
    if !inBounds(map, sx, sy) || !inBounds(map, gx, gy) { return nil }
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
