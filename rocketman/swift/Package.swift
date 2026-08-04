// swift-tools-version: 5.9

import PackageDescription

/*
 * RocketmanKit — the simulation, ported from the JavaScript in
 * rocketman/engine.
 *
 * Deliberately free of UIKit, SpriteKit, Metal and Foundation-beyond-the-basics
 * so it builds and tests on Linux as well as Apple platforms. That is not
 * portability for its own sake: it means the conformance suite runs in CI on a
 * Linux box with no Mac in sight, and it keeps the same wall between simulation
 * and presentation that the JavaScript version has.
 *
 * The iOS app target lives outside this package and depends on it.
 */
let package = Package(
    name: "RocketmanKit",
    platforms: [
        .iOS(.v16),
        .macOS(.v13),
    ],
    products: [
        .library(name: "RocketmanKit", targets: ["RocketmanKit"]),
    ],
    targets: [
        .target(name: "RocketmanKit"),
        .testTarget(
            name: "RocketmanKitTests",
            dependencies: ["RocketmanKit"],
            resources: [.copy("Fixtures")]
        ),
    ]
)
