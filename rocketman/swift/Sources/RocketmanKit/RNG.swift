/*
 * Deterministic pseudo-random numbers — the Swift half of engine/rng.js.
 *
 * mulberry32, chosen originally because it is four lines of 32-bit integer
 * arithmetic with no floating point anywhere in the state transition. That is
 * what makes it portable: every operation below is exact in both languages, so
 * the two implementations do not merely produce similar streams, they produce
 * the same one.
 *
 * The correspondence is worth spelling out, because it looks like it should
 * not work. JavaScript has no integers — `t` is a Double throughout — and the
 * port relies on three facts. `Math.imul` is defined as the low 32 bits of a
 * signed 32-bit product, which is bit-identical to `&*` on UInt32. `>>>` is an
 * unsigned shift on the ToUint32 of its operand, matching `>>` on UInt32. And
 * `t ^= t + imul(...)` performs a *Number* addition whose operands are both
 * int32-ranged, so the sum is under 2^32 and exactly representable, after
 * which `^=` truncates it mod 2^32 — exactly what `&+` does.
 */

/// A seeded generator. Value semantics on purpose: copying a world copies its
/// RNG, and two copies advance independently, which is what replay checkpoints
/// and what-if branching both want.
public struct RNG {
    /// The full generator state. Serialisable, for savegames and replays.
    public private(set) var state: UInt32

    public init(seed: UInt32) {
        state = seed
    }

    /// Matches JavaScript's `createRng(seed)` for a signed seed, where the
    /// engine writes things like `seed ^ 0x9e3779b9` and lets `>>> 0` sort out
    /// the sign. Separately labelled rather than overloaded on type, or an
    /// integer literal at the call site is ambiguous between the two.
    public init(signedSeed: Int32) {
        state = UInt32(bitPattern: signedSeed)
    }

    /// Uniform float in [0, 1).
    public mutating func next() -> Double {
        state = state &+ 0x6d2b_79f5
        var t = state
        t = (t ^ (t >> 15)) &* (t | 1)
        t ^= t &+ ((t ^ (t >> 7)) &* (t | 61))
        return Double(t ^ (t >> 14)) / 4_294_967_296.0
    }

    /// Integer in [0, n).
    public mutating func int(_ n: Int) -> Int {
        Int((next() * Double(n)).rounded(.down))
    }

    /// Float in [lo, hi).
    public mutating func range(_ lo: Double, _ hi: Double) -> Double {
        lo + next() * (hi - lo)
    }

    /// True with probability p.
    public mutating func chance(_ p: Double) -> Bool {
        next() < p
    }

    /// Uniform element, or nil for an empty collection.
    public mutating func pick<T>(_ items: [T]) -> T? {
        if items.isEmpty { return nil }
        return items[Int((next() * Double(items.count)).rounded(.down))]
    }

    public mutating func restore(_ value: UInt32) {
        state = value
    }
}
