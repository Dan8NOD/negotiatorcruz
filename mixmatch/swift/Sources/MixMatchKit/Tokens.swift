/*
 * MixMatchKit — the token meter, ported from mixmatch/config/tokens.js.
 *
 * The iOS client needs to know what a token is worth so it can show a balance
 * and price a feature before spending. A Swift package cannot import an ESM
 * module, so these numbers exist twice — and a second copy of a price is
 * exactly what produced the $3/$5/$10/$15 chat-token drift this project has
 * already paid for once.
 *
 * The copy is therefore not trusted. MixMatchKitTests asserts every constant
 * here against a fixture exported from the JavaScript, so the two cannot drift
 * without CI saying so.
 *
 * Deliberately free of UIKit and SwiftUI, and of Foundation beyond what
 * Codable needs, for the same reason RocketmanKit is: the conformance suite
 * runs on Linux in CI with no Mac in sight.
 *
 * WHAT THIS DOES NOT DO
 *
 * It does not hold a balance and it does not spend one. The balance lives in
 * ai_credit_accounts and is only ever moved by reserve_ai_credit /
 * refund_ai_credit / grant_ai_credit on the server. A client-side balance that
 * can diverge from the ledger is a money bug waiting to happen; this type does
 * arithmetic and nothing else.
 */

/// What one token is worth, in micros of internal budget.
///
/// Not a free parameter: the live $15 pack grants 3,000,000 micros and the
/// $5/mo allowance grants 2,000,000, which at this rate come out to exactly
/// 150 and 100 tokens. Changing it re-denominates every balance already sold.
public let tokenMicros: Int = 20_000

/// How a balance was acquired. Recorded because the two rails do not net the
/// same amount: Apple's commission is materially larger than Stripe's fee, so
/// a pack bought on iPad is worth less to the business than the same pack
/// bought on the web even though the buyer pays the same and gets the same
/// tokens.
public enum GrantRail: String, Codable, Sendable {
    case paymentLink = "payment_link"
    case subscription
    case appleIAP = "apple_iap"
}

/// Whether a meter may actually be charged for.
public enum MeterStatus: String, Codable, Sendable {
    /// Shipping; the price is real.
    case live
    /// Designed, not built. Must not be chargeable.
    case planned
    /// Cannot ship until something outside the code is resolved.
    case blocked
}

/// A way tokens enter a balance.
public struct Grant: Sendable {
    public let id: String
    public let priceCents: Int
    public let micros: Int
    public let rail: GrantRail

    public var tokens: Int { Tokens.tokens(fromMicros: micros) }

    public init(id: String, priceCents: Int, micros: Int, rail: GrantRail) {
        self.id = id
        self.priceCents = priceCents
        self.micros = micros
        self.rail = rail
    }
}

/// A feature that draws a balance down.
public struct Meter: Sendable {
    public let id: String
    public let tokens: Int
    /// What serving one unit costs *us* at the ceiling — not the typical case.
    /// Exists so a meter priced under its own cost can be caught by a test
    /// rather than by reconciling a Stripe report against an Anthropic invoice.
    public let worstCaseCostMicros: Int
    /// False when the cost above is an assumption rather than a measured or
    /// vendor-confirmed number. A meter may not go `.live` while this is false.
    public let costsVerified: Bool
    public let status: MeterStatus

    public var micros: Int { Tokens.micros(fromTokens: tokens) }

    public init(
        id: String,
        tokens: Int,
        worstCaseCostMicros: Int,
        costsVerified: Bool,
        status: MeterStatus
    ) {
        self.id = id
        self.tokens = tokens
        self.worstCaseCostMicros = worstCaseCostMicros
        self.costsVerified = costsVerified
        self.status = status
    }
}

public enum TokenError: Error, Equatable, Sendable {
    case negativeTokens(Int)
    case unknownMeter(String)
    case meterNotChargeable(id: String, status: MeterStatus)
}

public enum Tokens {

    // MARK: - conversion

    /// Micros for a whole number of tokens.
    public static func micros(fromTokens tokens: Int) -> Int {
        precondition(tokens >= 0, "tokens must be non-negative, got \(tokens)")
        return tokens * tokenMicros
    }

    /// Throwing form, for values that arrive from outside the app.
    public static func micros(validating tokens: Int) throws -> Int {
        guard tokens >= 0 else { throw TokenError.negativeTokens(tokens) }
        return tokens * tokenMicros
    }

    /// Micros to whole tokens, rounded **down**.
    ///
    /// A partial token is not spendable, and rounding up would let a balance
    /// display a token it cannot actually buy anything with.
    public static func tokens(fromMicros micros: Int) -> Int {
        micros / tokenMicros
    }

    // MARK: - the catalog

    public static let grants: [String: Grant] = [
        "pack_15": Grant(
            id: "pack_15", priceCents: 1500, micros: 3_000_000, rail: .paymentLink),
        "subscription_monthly": Grant(
            id: "subscription_monthly", priceCents: 500, micros: 2_000_000,
            rail: .subscription),
    ]

    public static let meters: [String: Meter] = [
        "arcade_play": Meter(
            id: "arcade_play", tokens: 1, worstCaseCostMicros: 0,
            costsVerified: true, status: .planned),
        "coach_request": Meter(
            id: "coach_request", tokens: 2, worstCaseCostMicros: 34_500,
            costsVerified: true, status: .live),
        "debrief_analysis": Meter(
            id: "debrief_analysis", tokens: 8, worstCaseCostMicros: 120_000,
            costsVerified: true, status: .planned),
        "transcribe_minute": Meter(
            id: "transcribe_minute", tokens: 1, worstCaseCostMicros: 6_000,
            costsVerified: false, status: .blocked),
    ]

    /// What one unit of `meterID` costs, in micros — the figure to hand
    /// `reserve_ai_credit`.
    ///
    /// Throws for a meter that is not live, so a half-built feature cannot
    /// quietly start taking someone's tokens.
    public static func cost(ofMeter meterID: String) throws -> Int {
        guard let meter = meters[meterID] else {
            throw TokenError.unknownMeter(meterID)
        }
        guard meter.status == .live else {
            throw TokenError.meterNotChargeable(id: meterID, status: meter.status)
        }
        return micros(fromTokens: meter.tokens)
    }

    /// Meters a user can actually be charged for right now.
    public static var liveMeters: [Meter] {
        meters.values.filter { $0.status == .live }.sorted { $0.id < $1.id }
    }

    // MARK: - display

    /// "1 token", "150 tokens". Grouping is applied by hand rather than through
    /// a locale formatter: this string is asserted in tests, and a formatter
    /// would make the expected value depend on the CI runner's locale.
    public static func format(tokens count: Int) -> String {
        "\(grouped(count)) token\(count == 1 ? "" : "s")"
    }

    static func grouped(_ value: Int) -> String {
        let digits = Array(String(abs(value)))
        var out: [Character] = []
        for (offset, digit) in digits.enumerated() {
            if offset > 0 && (digits.count - offset) % 3 == 0 { out.append(",") }
            out.append(digit)
        }
        return (value < 0 ? "-" : "") + String(out)
    }
}
