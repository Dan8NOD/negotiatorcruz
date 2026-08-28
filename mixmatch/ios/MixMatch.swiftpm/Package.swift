// swift-tools-version: 5.9

// ─────────────────────────────────────────────────────────────────────────────
// Mix & Match — an App Playground.
//
// THIS FILE ONLY BUILDS INSIDE SWIFT PLAYGROUNDS. `AppleProductTypes` and
// `.iOSApplication` ship with the Playgrounds app and do not exist in plain
// SwiftPM or in Xcode, so `swift build` on this directory will fail and is
// meant to. The package that CI compiles is ../../swift (MixMatchKit).
//
// Why this format: Swift Playgrounds 4.4+ on iPadOS can build, sign and run a
// real app on the iPad itself, and can upload to App Store Connect — no Mac,
// no Xcode. With Developer Mode on and a paid developer account that is the
// shortest path from this repository to an icon on the home screen.
//
// See ../README.md for how to get it onto the device and what to do when the
// app outgrows this format.
// ─────────────────────────────────────────────────────────────────────────────

import AppleProductTypes
import PackageDescription

let package = Package(
    name: "MixMatch",
    platforms: [
        .iOS("16.0")
    ],
    products: [
        .iOSApplication(
            name: "MixMatch",
            targets: ["AppModule"],
            bundleIdentifier: "com.negotiatorsondemand.mixmatch",
            teamIdentifier: "",
            displayVersion: "0.1",
            bundleVersion: "1",
            appIcon: .placeholder(icon: .timer),
            accentColor: .presetColor(.orange),
            supportedDeviceFamilies: [.pad, .phone],
            supportedInterfaceOrientations: [
                .portrait,
                .landscapeRight,
                .landscapeLeft,
                .portraitUpsideDown(.when(deviceFamilies: [.pad])),
            ]
        )
    ],
    targets: [
        .executableTarget(
            name: "AppModule",
            path: ".",
            resources: [
                .process("Resources")
            ]
        )
    ]
)
