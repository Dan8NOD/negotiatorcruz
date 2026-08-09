import XCTest

@testable import RocketmanKit

/// Map generation is the heaviest single consumer of the RNG in the whole
/// engine, so agreeing on a generated map is a much stronger statement than
/// agreeing on a raw stream: it means every draw — terrain carving, wreck
/// fields, every prop placement — happened in the same order as the
/// JavaScript oracle.
final class GridTests: XCTestCase {

    private struct Fixture: Decodable {
        struct Point: Decodable {
            let x: Int
            let y: Int
        }
        struct Prop: Decodable {
            let defId: String
            let cx: Int
            let cy: Int
        }
        struct River: Decodable {
            let horizontal: Bool
            let span: Int
            let cross: Int
            let margin: Int
            let centres: [Int]
            let widths: [Int]
        }
        struct Crossing: Decodable {
            let kind: String
            let x: Int
            let y: Int
            let horizontal: Bool
            let x0: Int
            let x1: Int
            let y0: Int
            let y1: Int
        }
        struct Chokepoint: Decodable {
            let kind: String
            let x: Int
            let y: Int
            let primary: Bool
            let cache: Bool
        }
        struct Rail: Decodable {
            let x0: Int
            let y0: Int
            let x1: Int
            let y1: Int
        }
        struct Map: Decodable {
            let seed: Int
            let width: Int
            let height: Int
            let terrain: [Int]
            let resource: [Int]
            let resourceMax: [Int]
            let starts: [Point]
            let fields: [Point]
            let props: [Prop]
            let character: String?
            let river: River?
            let crossings: [Crossing]
            let chokepoints: [Chokepoint]
            let rails: [Rail]
        }
        let maps: [Map]
    }

    private static var fixture: Fixture!

    override class func setUp() {
        super.setUp()
        fixture = try! loadFixture("map", as: Fixture.self)
    }

    func testGeneratedMapMatchesJavaScript() {
        XCTAssertFalse(Self.fixture.maps.isEmpty)

        for expected in Self.fixture.maps {
            let map = createMap(seed: expected.seed, width: expected.width, height: expected.height)
            let ctx = "seed \(expected.seed)"

            XCTAssertEqual(map.width, expected.width, ctx)
            XCTAssertEqual(map.height, expected.height, ctx)

            XCTAssertEqual(
                map.terrain.map(Int.init), expected.terrain,
                "\(ctx): terrain diverged")
            XCTAssertEqual(
                map.resource.map(Int.init), expected.resource,
                "\(ctx): resource diverged")
            XCTAssertEqual(
                map.resourceMax.map(Int.init), expected.resourceMax,
                "\(ctx): resourceMax diverged")

            XCTAssertEqual(map.starts.count, expected.starts.count, ctx)
            for (s, e) in zip(map.starts, expected.starts) {
                XCTAssertEqual(s.x, e.x, "\(ctx): start.x")
                XCTAssertEqual(s.y, e.y, "\(ctx): start.y")
            }

            XCTAssertEqual(map.fields.count, expected.fields.count, "\(ctx): field count diverged")
            for (f, e) in zip(map.fields, expected.fields) {
                XCTAssertEqual(f.x, e.x, "\(ctx): field.x")
                XCTAssertEqual(f.y, e.y, "\(ctx): field.y")
            }

            XCTAssertEqual(map.props.count, expected.props.count, "\(ctx): prop count diverged")
            for (p, e) in zip(map.props, expected.props) {
                XCTAssertEqual(p.defId, e.defId, "\(ctx): prop.defId")
                XCTAssertEqual(p.cx, e.cx, "\(ctx): prop.cx")
                XCTAssertEqual(p.cy, e.cy, "\(ctx): prop.cy")
            }

            // The character is asserted first because it is upstream of
            // everything else: it decides how many ridges and blobs get carved,
            // how wide the channel is, which district kinds can be rolled and
            // how much scenery lands. A port that agreed on every cell with the
            // wrong character here would be agreeing by accident.
            XCTAssertEqual(map.character, expected.character, "\(ctx): character")

            if let river = expected.river {
                guard let got = map.river else {
                    XCTFail("\(ctx): expected a river, got none")
                    continue
                }
                XCTAssertEqual(got.horizontal, river.horizontal, "\(ctx): river.horizontal")
                XCTAssertEqual(got.span, river.span, "\(ctx): river.span")
                XCTAssertEqual(got.cross, river.cross, "\(ctx): river.cross")
                XCTAssertEqual(got.margin, river.margin, "\(ctx): river.margin")
                XCTAssertEqual(got.centres, river.centres, "\(ctx): river.centres")
                XCTAssertEqual(got.widths, river.widths, "\(ctx): river.widths")
            } else {
                XCTAssertNil(map.river, "\(ctx): river should be absent")
            }

            // None of the three below is derivable from the grid, which is why
            // they are asserted rather than inferred. The deck of a bridge is
            // road and the ford is rough, so a port that painted them correctly
            // and recorded nothing would look identical cell for cell — and
            // then route no road to a bank, garrison nothing, and leave a
            // renderer drawing tarmac over water.
            XCTAssertEqual(
                map.crossings.count, expected.crossings.count, "\(ctx): crossing count diverged")
            for (c, e) in zip(map.crossings, expected.crossings) {
                XCTAssertEqual(c.kind, e.kind, "\(ctx): crossing.kind")
                XCTAssertEqual(c.x, e.x, "\(ctx): crossing.x")
                XCTAssertEqual(c.y, e.y, "\(ctx): crossing.y")
                XCTAssertEqual(c.horizontal, e.horizontal, "\(ctx): crossing.horizontal")
                XCTAssertEqual(c.x0, e.x0, "\(ctx): crossing.x0")
                XCTAssertEqual(c.x1, e.x1, "\(ctx): crossing.x1")
                XCTAssertEqual(c.y0, e.y0, "\(ctx): crossing.y0")
                XCTAssertEqual(c.y1, e.y1, "\(ctx): crossing.y1")
            }

            XCTAssertEqual(
                map.chokepoints.count, expected.chokepoints.count,
                "\(ctx): chokepoint count diverged")
            for (c, e) in zip(map.chokepoints, expected.chokepoints) {
                XCTAssertEqual(c.kind, e.kind, "\(ctx): chokepoint.kind")
                XCTAssertEqual(c.x, e.x, "\(ctx): chokepoint.x")
                XCTAssertEqual(c.y, e.y, "\(ctx): chokepoint.y")
                XCTAssertEqual(c.primary, e.primary, "\(ctx): chokepoint.primary")
                XCTAssertEqual(c.cache, e.cache, "\(ctx): chokepoint.cache")
            }

            XCTAssertEqual(map.rails.count, expected.rails.count, "\(ctx): rail count diverged")
            for (r, e) in zip(map.rails, expected.rails) {
                XCTAssertEqual(r.x0, e.x0, "\(ctx): rail.x0")
                XCTAssertEqual(r.y0, e.y0, "\(ctx): rail.y0")
                XCTAssertEqual(r.x1, e.x1, "\(ctx): rail.x1")
                XCTAssertEqual(r.y1, e.y1, "\(ctx): rail.y1")
            }
        }
    }

    /// The river's own promise, and the one the whole feature is built on: the
    /// two halves of the channel are the exact 180° image of each other, so
    /// neither player has a wider crossing or a longer wade than the other.
    ///
    /// Asserted on the record rather than on the grid, because the record is
    /// what `bankOf` answers from and what the road router reads. A grid that
    /// happened to be symmetric under a record that was not would send the two
    /// players' roads to different bridges.
    func testTheChannelIsItsOwnMirror() {
        for expected in Self.fixture.maps {
            let map = createMap(seed: expected.seed, width: expected.width, height: expected.height)
            guard let r = map.river else { continue }
            for s in r.margin..<(r.span - r.margin) {
                let ms = r.span - 1 - s
                XCTAssertEqual(
                    r.widths[s], r.widths[ms],
                    "seed \(expected.seed): channel width at \(s) != its mirror at \(ms)")
                XCTAssertEqual(
                    r.centres[s], r.cross - r.centres[ms] - r.widths[ms],
                    "seed \(expected.seed): channel centre at \(s) is not the mirror of \(ms)")
            }
        }
    }

    /// Every chokepoint is recorded as a pair, and the pair is a mirror pair.
    /// `openPasses` pushes the rolled one and its twin together, so a port that
    /// widened the ground correctly but recorded one of the two would give the
    /// road network and the scenery placer half a map to work from.
    func testChokepointsComeInMirroredPairs() {
        for expected in Self.fixture.maps {
            let map = createMap(seed: expected.seed, width: expected.width, height: expected.height)
            XCTAssertEqual(
                map.chokepoints.count % 2, 0, "seed \(expected.seed): odd number of chokepoints")
            for i in stride(from: 0, to: map.chokepoints.count, by: 2) {
                let a = map.chokepoints[i]
                let b = map.chokepoints[i + 1]
                XCTAssertTrue(a.primary, "seed \(expected.seed): chokepoint \(i) is not primary")
                XCTAssertFalse(b.primary, "seed \(expected.seed): chokepoint \(i + 1) is primary")
                XCTAssertEqual(a.kind, b.kind, "seed \(expected.seed): pair \(i) kinds differ")
                XCTAssertEqual(a.cache, b.cache, "seed \(expected.seed): pair \(i) caches differ")
                XCTAssertEqual(b.x, map.width - 1 - a.x, "seed \(expected.seed): pair \(i) x")
                XCTAssertEqual(b.y, map.height - 1 - a.y, "seed \(expected.seed): pair \(i) y")
            }
        }
    }

    /// There is exactly one ford, it is its own mirror image, and it is the
    /// wide crossing.
    ///
    /// All three are properties of the *record* rather than of the grid, and
    /// that is deliberate. A ford's deck is laid over a meandering channel, so
    /// its rectangle is a bounding box with wet cells inside it, and later
    /// passes are free to write over the ground it sits on — asserting the
    /// terrain would be asserting a coincidence. The record is what `paveLine`
    /// consults to keep tarmac off the shallows and what a renderer draws from.
    ///
    /// Self-mirroring is the load-bearing one. `addCrossing` writes a
    /// centre-line crossing once, over the union of itself and its twin,
    /// because taking just one of the two would put its deck at 29–42 where its
    /// own mirror image runs at 30–43 — a crossing one player reaches a cell
    /// sooner. Recording both instead would leave the map with two overlapping
    /// fords where it has one. Both mistakes are invisible on the grid.
    func testTheFordIsOneWideSelfMirroringCrossing() {
        for expected in Self.fixture.maps {
            let map = createMap(seed: expected.seed, width: expected.width, height: expected.height)
            guard map.river != nil else { continue }
            let ctx = "seed \(expected.seed)"

            let fords = map.crossings.filter { $0.kind == "ford" }
            XCTAssertEqual(fords.count, 1, "\(ctx): expected exactly one ford")
            guard let ford = fords.first else { continue }

            XCTAssertEqual(
                ford.x0 + ford.x1, map.width - 1, "\(ctx): the ford is not its own mirror in x")
            XCTAssertEqual(
                ford.y0 + ford.y1, map.height - 1, "\(ctx): the ford is not its own mirror in y")

            // Fourteen cells against a bridge's five: a crossing an army can
            // walk through abreast is what keeps a partitioned map a decision
            // rather than a siege neither side can win.
            let fordAlong = ford.horizontal ? ford.x1 - ford.x0 : ford.y1 - ford.y0
            for bridge in map.crossings where bridge.kind == "bridge" {
                let bridgeAlong =
                    bridge.horizontal ? bridge.x1 - bridge.x0 : bridge.y1 - bridge.y0
                XCTAssertGreaterThan(
                    fordAlong, bridgeAlong, "\(ctx): the ford is no wider than a bridge")
            }
        }
    }

    /// A field's cell list is not itself in the JS fixture, but every cell
    /// in it has to actually carry the resource the field claims to have
    /// stamped, or a collector routed there would find nothing.
    ///
    /// The start footprint is the one exemption, and it is deliberate: the home
    /// field is centred five cells from the start with a radius of four, so its
    /// ragged edge can reach the Command Rig. `createMap` strips scrap from a
    /// radius of two around every start *after* the fields are stamped, so the
    /// rig always fits. Those cells stay in the field's list — the field is
    /// still one patch — and they are the cells this exempts.
    func testFieldCellsCarryTheStampedResource() {
        for expected in Self.fixture.maps {
            let map = createMap(seed: expected.seed, width: expected.width, height: expected.height)
            for field in map.fields {
                for cell in field.cells {
                    if map.starts.contains(where: {
                        abs(cell.x - $0.x) <= 2 && abs(cell.y - $0.y) <= 2
                    }) { continue }
                    let i = cell.y * map.width + cell.x
                    XCTAssertGreaterThan(
                        map.resource[i], 0,
                        "seed \(expected.seed): field cell (\(cell.x),\(cell.y)) carries no resource")
                }
            }
        }
    }

    /// The other half of that exemption, and the reason it exists: whatever the
    /// seed, the 3×3 Command Rig anchored one cell up and left of the start has
    /// somewhere to stand. `canPlace` refuses any footprint with scrap under it,
    /// so before the clear this was down to luck — it had simply never landed
    /// badly on a seed anyone had run. Mirrors `the opening Command Rig always
    /// fits where the game puts you` in the JS suite.
    func testTheOpeningCommandRigAlwaysFits() {
        for seed in [1, 7, 1234, 90210, 3, 88, 404, 2024, 65535] {
            let map = createMap(seed: seed, width: 72, height: 72)
            for s in map.starts {
                XCTAssertTrue(
                    canPlace(map, (width: 3, height: 3), s.x - 1, s.y - 1),
                    "seed \(seed): the Command Rig does not fit at \(s.x),\(s.y)")
            }
        }
    }

    /// A seed sweep, mirroring the one the JS suite runs.
    ///
    /// The fixture is seven maps, chosen to reach every character and every
    /// district kind — but seven maps is seven paths through a generator whose
    /// passes all read each other, and the interesting failures are the ones
    /// where two passes meet on some seed nobody picked. A quarry rim reaches
    /// nine cells from an anchor that comes no closer than eight to the edge,
    /// so it reads off the end of a row; the JavaScript gets `undefined` and
    /// carries on, and the Swift traps. That is not a difference any fixture
    /// finds, because it is not a difference in the output.
    ///
    /// Deliberately not a conformance check — it asserts what the generator
    /// promises whatever the seed, which is the same job `ensureConnected` has.
    func testEverySeedGeneratesAWinnableMap() {
        for seed in 1...120 {
            let map = createMap(seed: seed, width: 72, height: 72)
            assertMapIsSound(map, "seed \(seed) 72×72")
        }
        // The default size, where the expansion fields and the extra relay
        // masts exist at all.
        for seed in 1...8 {
            let map = createMap(seed: seed)
            assertMapIsSound(map, "seed \(seed) 144×144")
        }
    }

    /// Deliberately does not assert the border, and that is a finding rather
    /// than an oversight.
    ///
    /// `testInvariantsHoldOnEverySeed` below checks the border is cliff, and it
    /// is true of every fixture seed. It is not true of the engine. Widening
    /// this sweep to a hundred and twenty seeds turned up 13 and 67 — both
    /// quarry-heavy characters — with three rough cells in the top border and
    /// three in the bottom, and the JavaScript oracle produces exactly the same
    /// six cells, so this is the engine's behaviour and not the port's.
    ///
    /// The cause is that `addQuarry` is the one district that writes terrain,
    /// it writes through `paintMirrored`, and `paintMirrored` has no border
    /// guard — unlike `paveLine` and `cutCorridor`, which both refuse the outer
    /// ring. `carveTerrain` re-seals the border, but it runs long before the
    /// districts do. Nothing can walk off the world regardless, since every
    /// query is bounds-checked, so this is a shape bug rather than a crash.
    ///
    /// Asserting the border here would fail on a port that is bit-exact, and
    /// asserting the *breakage* would freeze a bug into the conformance suite.
    /// So it is written down instead, and the fix belongs in `engine/grid.js`.
    private func assertMapIsSound(_ map: GameMap, _ ctx: String) {
        for s in map.starts {
            XCTAssertTrue(isWalkable(map, s.x, s.y), "\(ctx): start (\(s.x),\(s.y)) not walkable")
            XCTAssertTrue(
                canPlace(map, (width: 3, height: 3), s.x - 1, s.y - 1),
                "\(ctx): the Command Rig does not fit at \(s.x),\(s.y)")
        }
        // The river is not a hard partition, and this is the assertion that
        // says so: with the ford and the marsh at each end there is always a
        // way across, so the two landing zones can always reach each other on
        // foot. `ensureConnected` is the backstop for this; a map that needed
        // it would still pass, which is the point of it being a backstop.
        guard let a = map.starts.first, let b = map.starts.last else {
            return XCTFail("\(ctx): no starts")
        }
        XCTAssertNotNil(
            findPath(map, a.x, a.y, b.x, b.y, goalRadius: 1),
            "\(ctx): the two landing zones cannot reach each other")
    }

    /// The border is a hard wall and the two start corners are open ground —
    /// properties the generator promises independent of any particular seed.
    func testInvariantsHoldOnEverySeed() {
        for expected in Self.fixture.maps {
            let map = createMap(seed: expected.seed, width: expected.width, height: expected.height)

            for x in 0..<map.width {
                XCTAssertEqual(terrainAt(map, x, 0), .cliff, "seed \(expected.seed): top border")
                XCTAssertEqual(terrainAt(map, x, map.height - 1), .cliff, "seed \(expected.seed): bottom border")
            }
            for y in 0..<map.height {
                XCTAssertEqual(terrainAt(map, 0, y), .cliff, "seed \(expected.seed): left border")
                XCTAssertEqual(terrainAt(map, map.width - 1, y), .cliff, "seed \(expected.seed): right border")
            }

            for s in map.starts {
                XCTAssertTrue(isWalkable(map, s.x, s.y), "seed \(expected.seed): start (\(s.x),\(s.y)) not walkable")
            }
        }
    }
}

/// A* and the geometry it depends on have no JS-captured fixture yet, so
/// these assert properties the algorithm must hold rather than bit-exact
/// agreement with the oracle.
final class PathfindingTests: XCTestCase {

    func testStraightLineOnOpenGround() {
        var map = GameMap(width: 20, height: 20)
        for i in 0..<map.terrain.count { map.terrain[i] = Terrain.ground.rawValue }

        let path = findPath(map, 2, 2, 10, 2)
        XCTAssertNotNil(path)
        XCTAssertEqual(path?.last?.x, 10)
        XCTAssertEqual(path?.last?.y, 2)
    }

    /// A cell walled off on all four orthogonal sides is unreachable even
    /// diagonally, since cutting a corner past a blocked cell is disallowed —
    /// but `findPath` never refuses outright for an in-bounds goal. It walks
    /// as close as the search gets instead (see `testUnreachableGoalWalksAsCloseAsItCan`).
    func testSealedRoomIsUnreachableButNotRefused() {
        var map = GameMap(width: 20, height: 20)
        for i in 0..<map.terrain.count { map.terrain[i] = Terrain.ground.rawValue }
        for (x, y) in [(9, 10), (11, 10), (10, 9), (10, 11)] {
            map.terrain[y * map.width + x] = Terrain.cliff.rawValue
        }

        let path = findPath(map, 0, 0, 10, 10)
        XCTAssertNotNil(path)
        XCTAssertFalse(path?.last?.x == 10 && path?.last?.y == 10, "goal cell should be unreachable")
    }

    /// Without `goalRadius` an order onto an occupied cell would refuse
    /// outright; with it, the search accepts any cell within range.
    func testGoalRadiusAcceptsAnAdjacentCell() {
        var map = GameMap(width: 20, height: 20)
        for i in 0..<map.terrain.count { map.terrain[i] = Terrain.ground.rawValue }
        map.occupied[10 * map.width + 10] = 1  // the goal cell itself is blocked

        let path = findPath(map, 5, 5, 10, 10, goalRadius: 2)
        XCTAssertNotNil(path)
        if let last = path?.last {
            XCTAssertLessThanOrEqual(len(Double(last.x - 10), Double(last.y - 10)), 2)
        }
    }

    func testUnreachableGoalWalksAsCloseAsItCan() {
        var map = GameMap(width: 20, height: 20)
        for i in 0..<map.terrain.count { map.terrain[i] = Terrain.ground.rawValue }
        // Seal the goal in a box with no opening at all.
        for x in 8...12 {
            map.terrain[9 * map.width + x] = Terrain.cliff.rawValue
            map.terrain[13 * map.width + x] = Terrain.cliff.rawValue
        }
        for y in 9...13 {
            map.terrain[y * map.width + 8] = Terrain.cliff.rawValue
            map.terrain[y * map.width + 12] = Terrain.cliff.rawValue
        }

        let path = findPath(map, 0, 0, 10, 11, maxNodes: 20000)
        XCTAssertNotNil(path, "should walk as close as it can rather than refuse")
        if let last = path?.last {
            XCTAssertFalse(isWalkable(map, 10, 11) && last.x == 10 && last.y == 11)
        }
    }

    func testSmoothPathDropsRedundantWaypoints() {
        var map = GameMap(width: 20, height: 20)
        for i in 0..<map.terrain.count { map.terrain[i] = Terrain.ground.rawValue }

        guard let raw = findPath(map, 0, 0, 10, 0) else {
            return XCTFail("expected a path on open ground")
        }
        let smoothed = smoothPath(map, 0, 0, raw)
        // A straight run on open ground should string-pull to a single waypoint.
        XCTAssertEqual(smoothed.count, 1)
        XCTAssertEqual(smoothed.first?.x, 10)
    }
}
