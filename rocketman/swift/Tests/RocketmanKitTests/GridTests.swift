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
        }
    }

    /// A field's cell list is not itself in the JS fixture, but every cell
    /// in it has to actually carry the resource the field claims to have
    /// stamped, or a collector routed there would find nothing.
    func testFieldCellsCarryTheStampedResource() {
        for expected in Self.fixture.maps {
            let map = createMap(seed: expected.seed, width: expected.width, height: expected.height)
            for field in map.fields {
                for cell in field.cells {
                    let i = cell.y * map.width + cell.x
                    XCTAssertGreaterThan(
                        map.resource[i], 0,
                        "seed \(expected.seed): field cell (\(cell.x),\(cell.y)) carries no resource")
                }
            }
        }
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
