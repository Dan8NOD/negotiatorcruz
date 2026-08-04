import Foundation
import XCTest

/*
 * Shared scaffolding for the conformance suite.
 *
 * These tests do not check that the Swift engine is reasonable. They check
 * that it is *the same engine* as the JavaScript one, which has been played,
 * balanced and covered by 335 tests of its own. Fixtures come from
 * rocketman/tools/export-fixtures.mjs; regenerate them whenever the JS engine
 * changes behaviour on purpose, and never to make a red test go green.
 */

/// Rebuild a Double from the hex bit pattern the exporter wrote.
func double(fromBits hex: String) -> Double {
    guard let raw = UInt64(hex, radix: 16) else {
        fatalError("malformed fixture bit pattern: \(hex)")
    }
    return Double(bitPattern: raw)
}

func hex(_ value: Double) -> String {
    String(format: "%016llx", value.bitPattern)
}

/**
 * Bit-for-bit equality, which is the only comparison this suite is allowed to
 * make.
 *
 * XCTAssertEqual on Doubles with an accuracy would defeat the entire point:
 * the failure mode being guarded against *is* a one-ulp difference, so a test
 * that tolerates one ulp tolerates the bug. Signed zero is distinguished too,
 * since bit patterns differ there and JavaScript's Math.round genuinely
 * returns -0 for part of its domain.
 */
func XCTAssertSameBits(
    _ actual: Double,
    _ expected: Double,
    _ context: @autoclosure () -> String = "",
    file: StaticString = #filePath,
    line: UInt = #line
) {
    if actual.bitPattern == expected.bitPattern { return }
    let note = context()
    XCTFail(
        "expected \(expected) [\(hex(expected))], got \(actual) [\(hex(actual))]"
            + (note.isEmpty ? "" : "  — \(note)"),
        file: file,
        line: line
    )
}

/// Load and decode a fixture emitted by the exporter.
func loadFixture<T: Decodable>(_ name: String, as type: T.Type) throws -> T {
    guard
        let url = Bundle.module.url(
            forResource: name, withExtension: "json", subdirectory: "Fixtures")
    else {
        XCTFail(
            """
            Fixture \(name).json is missing. Generate it with:
                node rocketman/tools/export-fixtures.mjs
            """)
        throw CocoaError(.fileNoSuchFile)
    }
    return try JSONDecoder().decode(T.self, from: Data(contentsOf: url))
}
