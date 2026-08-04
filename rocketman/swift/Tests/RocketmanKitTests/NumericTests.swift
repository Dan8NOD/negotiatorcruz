import XCTest

@testable import RocketmanKit

/// The arithmetic contract: `len`, `jsRound` and the spawn ring must agree with
/// JavaScript to the bit, because everything above them inherits any drift.
final class NumericTests: XCTestCase {

    private struct Fixture: Decodable {
        struct Length: Decodable {
            let dx: String
            let dy: String
            let out: String
        }
        struct Round: Decodable {
            let `in`: String
            let out: String
        }
        struct Ring: Decodable {
            let n: Int
            let radius: String
            let x: String
            let y: String
        }
        let lengths: [Length]
        let rounds: [Round]
        let rings: [Ring]
    }

    private static var fixture: Fixture!

    override class func setUp() {
        super.setUp()
        fixture = try! loadFixture("numeric", as: Fixture.self)
    }

    func testLengthMatchesJavaScript() {
        let cases = Self.fixture.lengths
        XCTAssertGreaterThan(cases.count, 1000, "fixture looks truncated")

        for c in cases {
            let dx = double(fromBits: c.dx)
            let dy = double(fromBits: c.dy)
            XCTAssertSameBits(len(dx, dy), double(fromBits: c.out), "len(\(dx), \(dy))")
        }
    }

    func testJSRoundMatchesJavaScript() {
        for c in Self.fixture.rounds {
            let input = double(fromBits: c.in)
            XCTAssertSameBits(jsRound(input), double(fromBits: c.out), "jsRound(\(input))")
        }
    }

    /// Guards the specific reason `jsRound` exists rather than a call to
    /// `rounded()`. If this ever passes with the naive implementation, the
    /// fixture stopped covering negative ties.
    func testJSRoundDisagreesWithSwiftRoundingOnNegativeTies() {
        XCTAssertSameBits(jsRound(-2.5), -2)
        XCTAssertSameBits((-2.5).rounded(), -3)
        XCTAssertSameBits(jsRound(-0.5), -0.0)
        XCTAssertSameBits(jsRound(0.5), 1)
        // floor(x + 0.5) reports 1 here; JavaScript and this both say 0.
        XCTAssertSameBits(jsRound(0.49999999999999994), 0)
        XCTAssertSameBits((0.49999999999999994 + 0.5).rounded(.down), 1)
    }

    func testSpawnRingMatchesJavaScript() {
        for c in Self.fixture.rings {
            let radius = double(fromBits: c.radius)
            let offset = ringOffset(c.n, radius: radius)
            XCTAssertSameBits(offset.x, double(fromBits: c.x), "ringOffset(\(c.n)).x")
            XCTAssertSameBits(offset.y, double(fromBits: c.y), "ringOffset(\(c.n)).y")
        }
    }

    /// The ring table is transcribed rather than computed, so a truncated or
    /// mis-pasted copy is a real failure mode with no other symptom.
    func testRingTablesAreWellFormed() {
        XCTAssertEqual(ringCos.count, 96)
        XCTAssertEqual(ringSin.count, ringCos.count)
        for (c, s) in zip(ringCos, ringSin) {
            // cos² + sin² = 1 to within accumulated error, which catches a
            // dropped or duplicated entry without re-deriving the values.
            XCTAssertEqual(c * c + s * s, 1, accuracy: 1e-12)
        }
    }
}
