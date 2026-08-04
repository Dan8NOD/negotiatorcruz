import XCTest

@testable import RocketmanKit

/// mulberry32 has to produce the identical stream, not a statistically similar
/// one. Every AI decision, map field and weapon jitter is drawn from it in a
/// fixed order, so a single divergent value reorders the entire match.
final class RNGTests: XCTestCase {

    private struct Fixture: Decodable {
        struct Stream: Decodable {
            let seed: UInt32
            let values: [String]
            let states: [UInt32]
            let ints: [Int]
            let chances: [Bool]
        }
        let streams: [Stream]
    }

    private static var fixture: Fixture!

    override class func setUp() {
        super.setUp()
        fixture = try! loadFixture("rng", as: Fixture.self)
    }

    func testStreamMatchesJavaScript() {
        XCTAssertFalse(Self.fixture.streams.isEmpty)

        for stream in Self.fixture.streams {
            var rng = RNG(seed: stream.seed)
            for (i, expected) in stream.values.enumerated() {
                XCTAssertSameBits(
                    rng.next(), double(fromBits: expected),
                    "seed \(stream.seed), draw \(i)")
                XCTAssertEqual(
                    rng.state, stream.states[i],
                    "seed \(stream.seed): state diverged after draw \(i)")
            }
        }
    }

    /// `int` and `pick` both floor a product of a Double and a count, which is
    /// exactly where an off-by-one would hide without changing the underlying
    /// stream at all.
    func testDerivedHelpersMatchJavaScript() {
        for stream in Self.fixture.streams {
            var rng = RNG(seed: stream.seed)
            for _ in stream.values { _ = rng.next() }

            for (i, expected) in stream.ints.enumerated() {
                XCTAssertEqual(
                    rng.int(7 + (i % 23)), expected,
                    "seed \(stream.seed): int diverged at \(i)")
            }
            for (i, expected) in stream.chances.enumerated() {
                XCTAssertEqual(
                    rng.chance(0.35), expected,
                    "seed \(stream.seed): chance diverged at \(i)")
            }
        }
    }

    func testRestoreReproducesTheStream() {
        var rng = RNG(seed: 1234)
        for _ in 0..<40 { _ = rng.next() }

        let checkpoint = rng.state
        let first = (0..<3).map { _ in rng.next() }
        rng.restore(checkpoint)
        let second = (0..<3).map { _ in rng.next() }

        XCTAssertEqual(first, second)
    }

    /// The struct is a value type so that copying a world copies its generator.
    /// If this ever became a class, two "independent" branches of a replay
    /// would silently share one stream.
    func testGeneratorHasValueSemantics() {
        var a = RNG(seed: 99)
        _ = a.next()
        var b = a
        XCTAssertEqual(a.next(), b.next())
        _ = a.next()
        XCTAssertNotEqual(a.state, b.state)
    }
}
