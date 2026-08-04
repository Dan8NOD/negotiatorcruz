#if canImport(Darwin)
import Darwin
#else
import Glibc
#endif

/*
 * Portable arithmetic — the Swift half of the numeric contract.
 *
 * Mirrors engine/numeric.js line for line, and for the same reason: the
 * simulation is only deterministic if every implementation agrees on the
 * arithmetic, and most of the obvious library calls do not qualify.
 *
 * What is safe, because IEEE-754 mandates correct rounding and both JavaScript
 * and Swift honour it: + - * /, sqrt, floor, ceil, abs, min, max, decimal
 * literal parsing, and 32-bit integer wrapping ops. What is not: hypot, sin,
 * cos, atan2, pow, exp, log. Foundation and libm implement those to a
 * tolerance, not to the bit, and V8 picks different answers than glibc does.
 *
 * Measured on this game's coordinate range, JavaScript's Math.hypot and
 * sqrt(dx*dx + dy*dy) disagree 37.9% of the time by one unit in the last
 * place. Distances gate arrival, target acquisition and splash falloff, so a
 * single flipped comparison is a permanent desync.
 */

/// Vector length. The one true distance primitive.
@inlinable
public func len(_ dx: Double, _ dy: Double) -> Double {
    (dx * dx + dy * dy).squareRoot()
}

/// Distance between two points.
@inlinable
public func distXY(_ ax: Double, _ ay: Double, _ bx: Double, _ by: Double) -> Double {
    len(ax - bx, ay - by)
}

/**
 * JavaScript's Math.round.
 *
 * Not the same function as Swift's `rounded()`, which breaks ties away from
 * zero. JavaScript breaks them toward +Infinity, so the two disagree on every
 * negative half: Math.round(-2.5) is -2, while (-2.5).rounded() is -3. The
 * engine rounds scrap payouts, refunds, hit points and cooldowns, all of which
 * can be negative intermediates, so this has to reproduce the tie-break rather
 * than approximate it.
 *
 * Implemented by comparing the fraction directly instead of the usual
 * floor(x + 0.5). That shortcut is wrong for the largest double below a
 * half-integer, where adding 0.5 rounds up across the boundary and reports a
 * whole extra integer — 0.49999999999999994 being the famous one.
 */
@inlinable
public func jsRound(_ x: Double) -> Double {
    if x.isNaN || x.isInfinite || x == 0 { return x }
    let whole = x.rounded(.down)
    // `x - whole` is exact everywhere except x in (-0.5, 0), by Sterbenz: for
    // any other x the two operands are within a factor of two and the
    // subtraction cannot round. In that one interval the true fraction lies in
    // (0.5, 1), so whichever way it rounds it stays >= 0.5 and the answer is
    // `whole + 1` — which is the -0 JavaScript returns for that whole range.
    let fraction = x - whole
    let result = fraction < 0.5 ? whole : whole + 1
    // Preserve JavaScript's signed zero for inputs in [-0.5, 0).
    return (result == 0 && x < 0) ? -0.0 : result
}

/// Integer form of `jsRound`, for the many places the engine wants an `Int`.
@inlinable
public func jsRoundInt(_ x: Double) -> Int {
    Int(jsRound(x))
}

/**
 * Precomputed cos/sin for the opening-forces spawn ring, whose angle is always
 * a multiple of 1.1 radians.
 *
 * Baked as decimal literals rather than computed, because decimal-to-double
 * conversion *is* correctly rounded in both languages while cos() is not.
 * These are byte-identical to the values in engine/numeric.js, which are the
 * ones V8 produced — so a ported match spawns in exactly the same places.
 */
public let ringCos: [Double] = [
    0.4535961214255773, -0.5885011172553458, -0.9874797699088649, -0.30733286997841935,
    0.70866977429126, 0.9502325919585293, 0.15337386203786346, -0.811093014061656,
    -0.8891911526253609, 0.004425697988050785, 0.8932061115093233, 0.8058839576404497,
    -0.16211443649971827, -0.9529529168871809, -0.7023970575027135, 0.31574375491924334,
    0.9888373426941465, 0.5813218118144357, -0.46146670441591253, -0.9999608263946371,
    -0.44569000044433316, 0.5956343152752115, 0.9860448308379632, 0.2988979063644682,
    -0.7148869687796675, -0.9474378189567576, -0.14462127116171977, 0.8162385236075724,
    0.8851065280947882, -0.013276747223059479, -0.897151090185845, -0.8006117624589936,
    0.17084230974765666, 0.9555985806128415, 0.6960693098638897, -0.3241299022175636,
    -0.990117442831766, -0.5740969614310336, 0.4693011327771151, 0.9998433086476912,
    0.43774896089470705, -0.6027208470078607, -0.9845326379049143, -0.2904395249332599,
    0.7210481538680871, 0.9445688168445349, 0.1358573496123707, -0.8213200831418752,
    -0.8809525579365433, 0.022126756261962838, 0.901025779576851, 0.7952768415790757,
    -0.17955679797714888, -0.9581693758551366, -0.6896870271361613, 0.3324906548421391,
    0.9913199700294487, 0.5668271321520202, -0.47709879270357103, -0.99964745596635,
    -0.42977362493499033, 0.6097601572433005, 0.9829433095858163, 0.281958388375392,
    -0.7271528468448446, -0.9416258104001715, -0.1270827840186229, 0.8263372945385548,
    0.876729567602604, -0.03097503173121646, -0.9048298761112383, -0.7898796129768653,
    0.18825721843235974, 0.9606651011994307, 0.6832507093535931, -0.3408253577513085,
    -0.9924448300725429, -0.5595128935482332, 0.48485907327037797, 0.9993732836951247,
    0.4217646174105228, -0.6167516944712085, -0.9812769704001121, -0.27345516116425417,
    0.7332005694242952, 0.9386090302000182, 0.118298261843216, -0.8312897647130846,
    -0.8724378879524822, 0.039820880393153096, 0.9085630817486479, 0.784420499510169,
    -0.19694288945960042, -0.9630855611126041, -0.6767608607837051, 0.3491333579443536,
]

public let ringSin: [Double] = [
    0.8912073600614354, 0.8084964038195901, -0.15774569414324865, -0.9516020738895161,
    -0.7055403255703919, 0.3115413635133787, 0.9881682338770005, 0.5849171928917617,
    -0.4575358937753214, -0.9999902065507035, -0.44964746453459986, 0.5920735147072245,
    0.9867719642746133, 0.3031183567457006, -0.711785342369123, -0.948844497918124,
    -0.1489990258141953, 0.8136737375071054, 0.8871575286923494, -0.008851309290403876,
    -0.8951873678196818, -0.8032557266939526, 0.16648000353715925, 0.954285094492698,
    0.6992400316550952, -0.3199399618841981, -0.9894870832545356, -0.5777150444457289,
    0.4653884763549586, 0.9999118601072672, 0.4417238066692238, -0.5991834492142653,
    -0.9852983838412026, -0.2946716015002508, 0.7179745927716441, 0.9460125826269081,
    0.1402406838270716, -0.8187873221268477, -0.8830381910054155, 0.017701925105413577,
    0.899097240144582, 0.7979521167226309, -0.17520126968715413, -0.9568933495204898,
    -0.6928849542336906, 0.3283134938514034, 0.9907284090790482, 0.5704676336373723,
    -0.4732045970455711, -0.9997551733586196, -0.43376554097568404, 0.6062464393693456,
    0.9837476080276858, 0.28620175955674676, -0.7241075918674544, -0.9431065498885296,
    -0.13147135437353982, 0.8238367570437217, 0.8788496697392535, -0.026551154023966794,
    -0.9029366707085488, -0.7925859894286711, 0.18390880930635695, 0.9594266346233836,
    0.6864755912087755, -0.33666130337212846, -0.9918921140961229, -0.5631755282811051,
    0.48098364347589934, 0.9995201585807313, 0.4257732909618934, -0.6132619318068891,
    -0.9821197583330206, -0.2777094945036767, 0.7301838591531669, 0.9401266273825524,
    0.12269172450610251, -0.828821646648592, -0.8745922930528203, 0.03539830273366068,
    0.9067053587029005, 0.7871577652331794, -0.19260194018331567, -0.9618847513255586,
    -0.6800124447360425, 0.3449827364187683, 0.9929781071327172, 0.5558392996930538,
    -0.4887250061793565, -0.9992068341863531, -0.41774768279836083, 0.6202293768826311,
    0.9804149622946926, 0.2691954716863202, -0.7362029185702121, -0.9370730485775908,
]

/**
 * Offset for the nth point on the spawn ring, 1-based. Wraps rather than
 * running off the end: an opening force of more than 96 machines would
 * overlap, which separation steering already resolves, and overlapping beats
 * a trap.
 */
@inlinable
public func ringOffset(_ n: Int, radius: Double) -> (x: Double, y: Double) {
    let count = ringCos.count
    let i = ((n - 1) % count + count) % count
    return (ringCos[i] * radius, ringSin[i] * radius)
}

// MARK: - Presentation

/*
 * Below this line the approximated functions are allowed, because nothing
 * below this line feeds simulation state. `facing` and `leapHeight` are read
 * only by the renderer and are absent from the world fingerprint, so two
 * engines that disagree here still agree on the match.
 */

/// The angle a machine should be drawn pointing, in radians.
@inlinable
public func facingTo(_ dx: Double, _ dy: Double) -> Double {
    atan2(dy, dx)
}

/// Height of a leap at normalised progress `t`, for the renderer's shadow.
@inlinable
public func arcHeight(_ t: Double) -> Double {
    sin(t * Double.pi)
}
