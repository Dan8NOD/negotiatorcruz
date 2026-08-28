import Foundation
import XCTest

@testable import MixMatchKit

/*
 * Conformance suite for the token meter.
 *
 * These tests do not check that the Swift numbers are reasonable. They check
 * that they are *the same numbers* as mixmatch/config/tokens.js, which is what
 * the web app, the broker and the ledger all read. The iOS client having its
 * own opinion about what a token is worth is a money bug, and it is the exact
 * shape of the $3/$5/$10/$15 drift this project has already paid for once.
 *
 * Fixtures come from mixmatch/tools/export-token-fixtures.mjs. Regenerate them
 * when the JavaScript changes on purpose, and never to make a red test green.
 */

// MARK: - fixture shape

struct TokenFixture: Decodable {
    let tokenMicros: Int
    let grants: [FixtureGrant]
    let meters: [FixtureMeter]
    let conversions: [FixtureConversion]
    let flooring: [FixtureFlooring]
    let rails: [FixtureRail]
    let netByRail: [FixtureNet]
}

struct FixtureRail: Decodable {
    let id: String
    let feeBps: Int
    let fixedCents: Int
}

struct FixtureNet: Decodable {
    let grantId: String
    let railId: String
    let netCents: Int
    let netMicrosPerToken: Int
}

struct FixtureGrant: Decodable {
    let id: String
    let priceCents: Int
    let micros: Int
    let tokens: Int
    let rail: String
}

struct FixtureMeter: Decodable {
    let id: String
    let tokens: Int
    let micros: Int
    let worstCaseCostMicros: Int
    let costsVerified: Bool
    let status: String
}

struct FixtureConversion: Decodable {
    let tokens: Int
    let micros: Int
}

struct FixtureFlooring: Decodable {
    let micros: Int
    let tokens: Int
}

func loadTokenFixture() throws -> TokenFixture {
    guard
        let url = Bundle.module.url(
            forResource: "tokens", withExtension: "json", subdirectory: "Fixtures")
    else {
        XCTFail(
            """
            Fixture tokens.json is missing. Generate it with:
                node mixmatch/tools/export-token-fixtures.mjs
            """)
        throw CocoaError(.fileNoSuchFile)
    }
    return try JSONDecoder().decode(TokenFixture.self, from: Data(contentsOf: url))
}

// MARK: - the unit

final class TokenUnitTests: XCTestCase {

    func testTokenUnitMatchesJavaScript() throws {
        let fixture = try loadTokenFixture()
        XCTAssertEqual(
            tokenMicros, fixture.tokenMicros,
            "Swift and JavaScript disagree about what a token is worth")
    }

    func testConversionsMatchJavaScript() throws {
        for c in try loadTokenFixture().conversions {
            XCTAssertEqual(
                Tokens.micros(fromTokens: c.tokens), c.micros,
                "\(c.tokens) tokens should be \(c.micros) micros")
        }
    }

    func testFlooringMatchesJavaScript() throws {
        // The edge that matters: a partial token is not spendable, so the
        // conversion must round down in both languages. Swift's Int division
        // truncates toward zero and JavaScript's Math.floor does not, for
        // negatives — balances are never negative, but the fixture pins the
        // agreed behaviour for the values that do occur.
        for f in try loadTokenFixture().flooring {
            XCTAssertEqual(
                Tokens.tokens(fromMicros: f.micros), f.tokens,
                "\(f.micros) micros should floor to \(f.tokens) tokens")
        }
    }

    func testRoundTrip() {
        for n in [0, 1, 2, 100, 150, 4321] {
            XCTAssertEqual(Tokens.tokens(fromMicros: Tokens.micros(fromTokens: n)), n)
        }
    }

    func testNegativeTokensAreRefused() {
        XCTAssertThrowsError(try Tokens.micros(validating: -1)) { error in
            XCTAssertEqual(error as? TokenError, .negativeTokens(-1))
        }
    }
}

// MARK: - the catalog

final class TokenCatalogTests: XCTestCase {

    func testGrantsMatchJavaScript() throws {
        let fixture = try loadTokenFixture()
        XCTAssertEqual(
            Tokens.grants.count, fixture.grants.count,
            "Swift has \(Tokens.grants.count) grants, JavaScript has \(fixture.grants.count)")

        for expected in fixture.grants {
            guard let actual = Tokens.grants[expected.id] else {
                XCTFail("Swift is missing grant \(expected.id)")
                continue
            }
            XCTAssertEqual(actual.micros, expected.micros, "\(expected.id) micros")
            XCTAssertEqual(actual.priceCents, expected.priceCents, "\(expected.id) price")
            XCTAssertEqual(actual.tokens, expected.tokens, "\(expected.id) tokens")
            XCTAssertEqual(actual.rail.rawValue, expected.rail, "\(expected.id) rail")
        }
    }

    func testMetersMatchJavaScript() throws {
        let fixture = try loadTokenFixture()
        XCTAssertEqual(
            Tokens.meters.count, fixture.meters.count,
            "Swift has \(Tokens.meters.count) meters, JavaScript has \(fixture.meters.count)")

        for expected in fixture.meters {
            guard let actual = Tokens.meters[expected.id] else {
                XCTFail("Swift is missing meter \(expected.id)")
                continue
            }
            XCTAssertEqual(actual.tokens, expected.tokens, "\(expected.id) token price")
            XCTAssertEqual(actual.micros, expected.micros, "\(expected.id) micros")
            XCTAssertEqual(
                actual.worstCaseCostMicros, expected.worstCaseCostMicros,
                "\(expected.id) worst-case cost")
            XCTAssertEqual(
                actual.costsVerified, expected.costsVerified, "\(expected.id) costsVerified")
            XCTAssertEqual(actual.status.rawValue, expected.status, "\(expected.id) status")
        }
    }

    /// The guard that matters most, mirrored from the JavaScript suite. A meter
    /// priced under its own serving cost loses money on every single call, and
    /// the only other way to find out is reconciling a Stripe report against an
    /// Anthropic invoice by hand.
    func testNoMeterIsPricedBelowCost() {
        for meter in Tokens.meters.values {
            XCTAssertGreaterThanOrEqual(
                meter.micros, meter.worstCaseCostMicros,
                "\(meter.id) charges \(meter.micros) micros but costs up to "
                    + "\(meter.worstCaseCostMicros)")
        }
    }

    func testLiveMetersHaveVerifiedCosts() {
        // Pricing a feature off a guessed vendor rate is how you end up
        // underwater on every call without noticing. Guess while planning;
        // do not charge for it.
        for meter in Tokens.liveMeters {
            XCTAssertTrue(
                meter.costsVerified, "\(meter.id) is live on an unverified cost basis")
        }
    }

    func testOnlyLiveMetersCanBeCharged() throws {
        XCTAssertEqual(try Tokens.cost(ofMeter: "coach_request"), 2 * tokenMicros)

        for meter in Tokens.meters.values where meter.status != .live {
            XCTAssertThrowsError(try Tokens.cost(ofMeter: meter.id)) { error in
                XCTAssertEqual(
                    error as? TokenError,
                    .meterNotChargeable(id: meter.id, status: meter.status))
            }
        }

        XCTAssertThrowsError(try Tokens.cost(ofMeter: "nope")) { error in
            XCTAssertEqual(error as? TokenError, .unknownMeter("nope"))
        }
    }

    func testCoachMeterCoversTheCoachReservation() {
        // 34,500 micros is worstCaseCostMicros(MODEL) in
        // nod-negotiation-coach on Claude Sonnet 5. If the coach's model or
        // output ceiling moves, its own CI check moves that number and this
        // one has to follow.
        XCTAssertGreaterThanOrEqual(Tokens.meters["coach_request"]!.micros, 34_500)
    }

    func testRailsMatchJavaScript() throws {
        let fixture = try loadTokenFixture()
        XCTAssertEqual(Tokens.rails.count, fixture.rails.count)
        for expected in fixture.rails {
            guard let actual = Tokens.rails[expected.id] else {
                XCTFail("Swift is missing rail \(expected.id)")
                continue
            }
            XCTAssertEqual(actual.feeBps, expected.feeBps, "\(expected.id) percentage cut")
            XCTAssertEqual(actual.fixedCents, expected.fixedCents, "\(expected.id) flat fee")
        }
    }

    /// The arithmetic, not just the inputs. Swift floors integer division and
    /// JavaScript floors a float; those agree here, but only because the Swift
    /// side ceils the percentage fee first. This is the test that would catch
    /// it if someone "simplified" that.
    func testNetPerRailMatchesJavaScriptToTheCent() throws {
        for expected in try loadTokenFixture().netByRail {
            XCTAssertEqual(
                try Tokens.netCents(ofGrant: expected.grantId, on: expected.railId),
                expected.netCents,
                "\(expected.grantId) on \(expected.railId)")
            XCTAssertEqual(
                try Tokens.netMicrosPerToken(ofGrant: expected.grantId, on: expected.railId),
                expected.netMicrosPerToken,
                "\(expected.grantId) per token on \(expected.railId)")
        }
    }

    func testAppleTakesFifteenPercentNotThirty() {
        // Small Business Program, under $1M of proceeds a year. Enrollment is
        // yearly and can lapse; if it does this becomes 3000 and every net
        // figure moves.
        XCTAssertEqual(Tokens.rails["apple_iap"]?.feeBps, 1500)
        XCTAssertEqual(Tokens.rails["apple_iap"]?.fixedCents, 0)
    }

    /// The check that actually matters once an iPad build exists: if a token
    /// nets less than serving one token's worth of the priciest live meter
    /// costs, the pack loses money on that rail however many people buy it.
    /// Apple's cut is where that would bite first.
    func testATokenEarnsMoreThanTheCheapestThingItBuysCosts() throws {
        let worstPerToken = Tokens.liveMeters
            .map { Double($0.worstCaseCostMicros) / Double($0.tokens) }
            .max() ?? 0
        for grantID in Tokens.grants.keys {
            for railID in Tokens.rails.keys {
                let net = try Tokens.netMicrosPerToken(ofGrant: grantID, on: railID)
                XCTAssertGreaterThan(
                    Double(net), worstPerToken,
                    "\(grantID) on \(railID) nets \(net) micros/token against \(worstPerToken) of cost")
            }
        }
    }

    func testUnknownGrantsAndRailsThrow() {
        XCTAssertThrowsError(try Tokens.netCents(ofGrant: "pack_99", on: "stripe")) { error in
            XCTAssertEqual(error as? TokenError, .unknownGrant("pack_99"))
        }
        XCTAssertThrowsError(try Tokens.netCents(ofGrant: "pack_15", on: "google_play")) { error in
            XCTAssertEqual(error as? TokenError, .unknownRail("google_play"))
        }
    }

    func testSubscribingBeatsToppingUpPerToken() throws {
        // Deliberate: the subscription is the commitment and should reward it.
        // If this inverts, the funnel is upside down.
        let sub = Tokens.grants["subscription_monthly"]!
        let pack = Tokens.grants["pack_15"]!
        let perTokenSub = Double(sub.priceCents) / Double(sub.tokens)
        let perTokenPack = Double(pack.priceCents) / Double(pack.tokens)
        XCTAssertLessThan(perTokenSub, perTokenPack)
    }
}

// MARK: - display

final class TokenFormattingTests: XCTestCase {

    func testSingularises() {
        XCTAssertEqual(Tokens.format(tokens: 1), "1 token")
        XCTAssertEqual(Tokens.format(tokens: 0), "0 tokens")
        XCTAssertEqual(Tokens.format(tokens: 150), "150 tokens")
    }

    func testGroupsThousands() {
        XCTAssertEqual(Tokens.grouped(0), "0")
        XCTAssertEqual(Tokens.grouped(999), "999")
        XCTAssertEqual(Tokens.grouped(1000), "1,000")
        XCTAssertEqual(Tokens.grouped(1_234_567), "1,234,567")
    }
}
