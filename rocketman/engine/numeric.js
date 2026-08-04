/**
 * Portable arithmetic — the numeric contract the simulation is built on.
 *
 * The engine is deterministic, and "deterministic" has to mean *across
 * implementations*, not just across two runs of the same one. That rules out
 * most of the Math object. ECMA-262 marks Math.hypot, sin, cos, atan2, pow and
 * friends as **implementation-approximated**: a conforming engine may return
 * any value within an implementation-defined tolerance. V8 and Safari's
 * JavaScriptCore genuinely differ, and so do V8 and the C library a Swift
 * build links against.
 *
 * This is not a theoretical hazard. Comparing Math.hypot(dx, dy) against
 * sqrt(dx*dx + dy*dy) over two million samples drawn from the coordinate range
 * this game actually uses, the two disagree **37.9% of the time**. The gap is
 * one unit in the last place, which sounds harmless right up until it lands on
 * a boundary: distances gate arrival, target acquisition and damage falloff, so
 * a single flipped `<=` sends two machines down different branches and the
 * worlds never reconverge.
 *
 * So the rule is: **the simulation computes distance here and nowhere else.**
 *
 * What is safe to use directly, because IEEE-754 requires correct rounding and
 * both languages honour it: + - * /, sqrt, floor, ceil, abs, min, max, and
 * 32-bit integer ops. Math.round is *nearly* safe — it is exact, but it breaks
 * ties toward +Infinity where Swift's .rounded() breaks them away from zero,
 * so the two disagree on negative halves (-2.5 → -2 here, -3 there). The Swift
 * port carries a jsRound that reproduces the tie-break rather than papering
 * over it.
 *
 * Presentation state is exempt. `facing` and `leapHeight` are written by the
 * engine but read only by the renderer, never by the simulation and never by
 * the world fingerprint, so the trig behind them cannot cause a desync.
 */

/** Vector length. The one true distance primitive. */
export function len(dx, dy) {
  return Math.sqrt(dx * dx + dy * dy);
}

/** Distance between two points given as loose coordinates. */
export function distXY(ax, ay, bx, by) {
  const dx = ax - bx;
  const dy = ay - by;
  return Math.sqrt(dx * dx + dy * dy);
}

/**
 * Precomputed cos/sin for the opening-forces spawn ring.
 *
 * Baked as decimal literals rather than computed, for the reason above — but
 * note the direction of the fix. Decimal-to-double conversion *is* correctly
 * rounded in both languages, so a literal round-trips exactly where a cos()
 * call would not. The values are the ones V8 produced, which keeps every
 * existing spawn position byte-identical to before.
 *
 * One subtlety cost a CI run: the original code *accumulated* `angle += 1.1`,
 * and an accumulated float sum is not `1.1 * i` — the two diverge from the
 * sixth step onward. These are the cos/sin of the accumulated sequence, not of
 * the multiples, because the accumulated sequence is what the game shipped
 * with and what its missions were tuned against.
 */
export const RING_COS = [
  0.4535961214255773, -0.5885011172553458, -0.9874797699088649, -0.30733286997841935,
  0.70866977429126, 0.9502325919585296, 0.15337386203786524, -0.8110930140616549,
  -0.8891911526253617, 0.004425697988049009, 0.8932061115093217, 0.8058839576404518,
  -0.16211443649971474, -0.9529529168871792, -0.7023970575027161, 0.31574375491923995,
  0.9888373426941459, 0.5813218118144357, -0.46146670441591253, -0.9999608263946371,
  -0.44569000044433, 0.5956343152752144, 0.986044830837962, 0.29889790636446145,
  -0.7148869687796725, -0.9474378189567543, -0.14462127116170923, 0.8162385236075785,
  0.8851065280947816, -0.013276747223073688, -0.8971510901858513, -0.8006117624589851,
  0.17084230974767067, 0.9555985806128457, 0.6960693098638744, -0.3241299022175838,
  -0.990117442831769, -0.5740969614310162, 0.4693011327771339, 0.9998433086476907,
  0.43774896089468146, -0.6027208470078833, -0.9845326379049093, -0.2904395249332327,
  0.7210481538681067, 0.9445688168445232, 0.1358573496123355, -0.8213200831418954,
  -0.8809525579365265, 0.022126756261998358, 0.9010257795768696, 0.7952768415790499,
  -0.17955679797719082, -0.9581693758551488, -0.6896870271361303, 0.33249065484217927,
  0.9913199700294553, 0.5668271321519792, -0.47709879270360844, -0.9996474559663489,
  -0.4297736249349646, 0.6097601572433229, 0.9829433095858138, 0.2819583883753784,
  -0.7271528468448544, -0.9416258104001715, -0.1270827840186229, 0.8263372945385468,
  0.8767295676026108, -0.030975031731202255, -0.9048298761112262, -0.7898796129768827,
  0.18825721843231785, 0.9606651011994188, 0.6832507093536242, -0.34082535775125505,
  -0.9924448300725359, -0.559512893548292, 0.4848590732703158, 0.9993732836951271,
  0.4217646174106001, -0.6167516944711414, -0.9812769704001313, -0.27345516116434987,
  0.733200569424218, 0.9386090302000574, 0.1182982618433289, -0.8312897647130135,
  -0.8724378879525447, 0.0398208803930111, 0.9085630817485885, 0.7844204995102572,
  -0.19694288945944716, -0.963085561112562, -0.6767608607838307, 0.34913335794419376,
];

export const RING_SIN = [
  0.8912073600614354, 0.8084964038195901, -0.15774569414324865, -0.9516020738895161,
  -0.7055403255703919, 0.31154136351337786, 0.9881682338770003, 0.5849171928917631,
  -0.4575358937753198, -0.9999902065507035, -0.4496474645346031, 0.5920735147072216,
  0.9867719642746139, 0.30311835674570564, -0.7117853423691206, -0.9488444979181251,
  -0.1489990258141988, 0.8136737375071054, 0.8871575286923494, -0.008851309290407429,
  -0.8951873678196834, -0.8032557266939505, 0.16648000353716624, 0.9542850944927002,
  0.6992400316550902, -0.3199399618842082, -0.9894870832545372, -0.5777150444457202,
  0.4653884763549712, 0.999911860107267, 0.44172380666921107, -0.5991834492142766,
  -0.9852983838412002, -0.29467160150023725, 0.717974592771659, 0.9460125826269012,
  0.14024068382705052, -0.8187873221268599, -0.8830381910054055, 0.017701925105441996,
  0.8990972401445945, 0.7979521167226137, -0.17520126968718214, -0.9568933495204981,
  -0.69288495423367, 0.32831349385143693, 0.9907284090790531, 0.5704676336373431,
  -0.4732045970456024, -0.9997551733586189, -0.4337655409756456, 0.6062464393693796,
  0.9837476080276781, 0.28620175955670596, -0.7241075918674839, -0.9431065498885154,
  -0.1314713543734905, 0.8238367570437499, 0.8788496697392332, -0.026551154024009413,
  -0.902936670708561, -0.7925859894286538, 0.1839088093063709, 0.9594266346233876,
  0.6864755912087652, -0.33666130337212846, -0.9918921140961229, -0.5631755282811168,
  0.48098364347588685, 0.9995201585807317, 0.4257732909619191, -0.6132619318068666,
  -0.9821197583330287, -0.2777094945037176, 0.7301838591531378, 0.9401266273825718,
  0.12269172450615892, -0.8288216466485522, -0.8745922930528547, 0.035398302733589675,
  0.9067053587028645, 0.7871577652332319, -0.19260194018321808, -0.9618847513255314,
  -0.6800124447361258, 0.3449827364186616, 0.9929781071327037, 0.5558392996931601,
  -0.4887250061792449, -0.9992068341863588, -0.41774768279848995, 0.6202293768825197,
  0.9804149622947235, 0.26919547168647073, -0.7362029185700968, -0.9370730485776504,
];

/**
 * Offset for the nth point on the spawn ring, 1-based to match the original
 * `angle += 1.1` before the first use. Wraps rather than running off the end:
 * an opening force of more than 96 machines would overlap, which separation
 * steering already resolves, and overlapping beats undefined.
 */
export function ringOffset(n, radius) {
  const i = (((n - 1) % RING_COS.length) + RING_COS.length) % RING_COS.length;
  return { x: RING_COS[i] * radius, y: RING_SIN[i] * radius };
}

/* -------------------------------------------------------- presentation -- */

/*
 * Below this line the implementation-approximated functions are allowed,
 * because nothing below this line feeds simulation state.
 *
 * The distinction is load-bearing enough to be worth a wall rather than a
 * convention: a test scans engine/ and fails on a raw Math.atan2 or Math.sin
 * anywhere outside this file. Routing the two legitimate uses through named
 * helpers means adding a third is a deliberate act with a name attached,
 * instead of a one-character edit nobody reviews.
 */

/**
 * The angle a machine should be drawn pointing, in radians.
 *
 * Written to `facing`, which the renderer reads and the simulation never does.
 * It is also absent from the world fingerprint, so two engines that disagree
 * here still agree on the match.
 */
export function facingTo(dx, dy) {
  return Math.atan2(dy, dx);
}

/** Height of a leap at normalised progress `t`, for the renderer's shadow. */
export function arcHeight(t) {
  return Math.sin(t * Math.PI);
}
