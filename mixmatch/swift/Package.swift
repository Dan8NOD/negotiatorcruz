// swift-tools-version: 5.9

import PackageDescription

/*
 * MixMatchKit — the parts of Mix & Match that are logic rather than interface.
 *
 * Today that is the token meter, ported from mixmatch/config/tokens.js and
 * held to it by a conformance suite. The iOS app target lives outside this
 * package and depends on it.
 *
 * Deliberately free of UIKit, SwiftUI and Foundation-beyond-the-basics, for
 * the same reason RocketmanKit is: the conformance suite then runs on Linux in
 * CI with no Mac in sight, so the numbers that decide what a customer is
 * charged are verified on every push rather than only when someone opens
 * Xcode.
 */
let package = Package(
    name: "MixMatchKit",
    platforms: [
        .iOS(.v16),
        .macOS(.v13),
    ],
    products: [
        .library(name: "MixMatchKit", targets: ["MixMatchKit"]),
    ],
    targets: [
        .target(name: "MixMatchKit"),
        .testTarget(
            name: "MixMatchKitTests",
            dependencies: ["MixMatchKit"],
            resources: [.copy("Fixtures")]
        ),
    ]
)
