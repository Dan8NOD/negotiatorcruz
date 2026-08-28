// Mix & Match — the token meter. One source of truth for what a token is worth
// and what every metered feature costs.
//
// WHY THIS EXISTS
//
// The ledger already in production (ai_credit_accounts.balance_micros, and the
// reserve/refund/grant RPCs) stores micros — millionths of a dollar of REAL
// SPEND. That was right when the only metered thing was the NOD Coach, where a
// unit of balance and a unit of model cost are the same unit.
//
// An arcade breaks that assumption three ways:
//
//   - A game play costs essentially nothing to serve. Charging it in "model
//     credit" means a round of Rocketman burns AI budget for no reason.
//   - Transcription costs a per-minute fee to a third party, which is not
//     model spend and does not scale with tokens generated.
//   - The user should see one currency, not three cost bases.
//
// So the balance stays in micros and nothing about the ledger changes. What
// changes is that a TOKEN becomes the user-facing unit, worth a fixed number of
// micros, and every feature declares its price here in tokens. One place to
// read, one place to change — the same discipline that keeps practice-lab's
// Stripe prices from drifting.
//
// Plain ESM, no dependencies: imported by Deno edge functions, Node tests, and
// the browser.

/**
 * What one token is worth, in micros of internal budget.
 *
 * Derived, not invented: the live $15 chat-token purchase grants 3,000,000
 * micros (TOKEN_PURCHASE_MICROS in the broker). At 20,000 micros per token
 * that pack is exactly 150 tokens, and the $5/mo subscription's existing
 * 2,000,000-micro monthly grant is exactly 100. Both round numbers fell out of
 * constants already shipping; neither was chosen to make them.
 *
 * Changing this re-denominates every balance already sold. Don't, without
 * migrating balances.
 */
export const TOKEN_MICROS = 20_000;

/** Display helper: 150 -> "150 tokens", 1 -> "1 token". */
export function formatTokens(tokens) {
  return `${tokens.toLocaleString('en-US')} token${tokens === 1 ? '' : 's'}`;
}

export function tokensToMicros(tokens) {
  if (!Number.isInteger(tokens) || tokens < 0) {
    throw new TypeError(`tokens must be a non-negative integer, got ${tokens}`);
  }
  return tokens * TOKEN_MICROS;
}

/** Micros -> whole tokens, rounded DOWN. A partial token is not spendable, and
 *  rounding up would let a balance display more than it can actually buy. */
export function microsToTokens(micros) {
  return Math.floor(micros / TOKEN_MICROS);
}

// ── how tokens are acquired ─────────────────────────────────────────────────

/**
 * Both rails already exist in the broker. This records what they grant in
 * tokens so the UI can say "100 tokens a month" without recomputing micros,
 * and so a change to either grant fails the test that ties them together.
 */
export const GRANTS = {
  /** $15 one-time top-up. Stripe price price_1U0AbnS5XoRchjGL59y8DHE0. */
  pack_15: {
    id: 'pack_15',
    priceCents: 1500,
    micros: 3_000_000,
    label: 'Token top-up',
    rail: 'payment_link',
  },
  /** Included with the $5/mo Mix & Match subscription, granted on invoice.paid. */
  subscription_monthly: {
    id: 'subscription_monthly',
    priceCents: 500,
    micros: 2_000_000,
    label: 'Monthly allowance',
    rail: 'subscription',
  },
};

/** Tokens a grant is worth. */
export function grantTokens(grantId) {
  const grant = GRANTS[grantId];
  if (!grant) throw new TypeError(`Unknown grant: ${grantId}`);
  return microsToTokens(grant.micros);
}

// ── what each rail actually nets ────────────────────────────────────────────

/**
 * The buyer pays the same and gets the same tokens on every rail. The business
 * does not receive the same amount, and once an iPad build exists the same SKU
 * is sold two ways — so the difference has to be a number somewhere rather than
 * a thing everyone assumes they remember.
 *
 * Apple's cut is 15%, not 30%: the Small Business Program applies under $1M of
 * proceeds a year. That enrollment is a yearly thing that can lapse, and it is
 * not automatic — if it ever does lapse, `apple_iap.feeBps` becomes 3000 and
 * every number below moves. This is the only place to change it.
 *
 * Stripe is 2.9% + 30c on US cards.
 */
export const RAILS = {
  stripe: { id: 'stripe', feeBps: 290, fixedCents: 30, label: 'Card (Stripe)' },
  apple_iap: { id: 'apple_iap', feeBps: 1500, fixedCents: 0, label: 'In-app purchase (Apple)' },
};

/**
 * What lands in the bank from one sale of `grantId` on `rail`, in cents,
 * rounded DOWN — an optimistic rounding on a fee estimate is how a margin
 * quietly goes negative.
 */
export function netCents(grantId, railId) {
  const grant = GRANTS[grantId];
  if (!grant) throw new TypeError(`Unknown grant: ${grantId}`);
  const rail = RAILS[railId];
  if (!rail) throw new TypeError(`Unknown rail: ${railId}`);
  const fee = (grant.priceCents * rail.feeBps) / 10_000 + rail.fixedCents;
  return Math.floor(grant.priceCents - fee);
}

/**
 * What one token of `grantId` nets on `railId`, in micros of real money.
 *
 * Worth comparing against a meter's `worstCaseCostMicros`: if a token nets less
 * than the cheapest thing it can buy costs to serve, the pack loses money on
 * that rail no matter how many people buy it. A test checks exactly that.
 */
export function netMicrosPerToken(grantId, railId) {
  const tokens = grantTokens(grantId);
  if (tokens === 0) return 0;
  return Math.floor((netCents(grantId, railId) * 10_000) / tokens);
}

// ── what tokens are spent on ────────────────────────────────────────────────

/**
 * The meter registry. Every feature that draws down a balance declares itself
 * here, and nowhere else.
 *
 * `worstCaseCostMicros` is what serving one unit costs US at the ceiling — not
 * an estimate of the typical case. It exists so the test suite can prove every
 * meter is priced above its own cost; a meter that loses money on every call
 * fails CI instead of being discovered in a Stripe report. The NOD Coach
 * already derives its worst case this way (worstCaseCostMicros() in
 * nod-negotiation-coach), and this is the same idea generalised.
 *
 * `status` gates rollout:
 *   'live'      — shipping, price is real
 *   'planned'   — designed, not yet built; must not be chargeable
 *   'blocked'   — cannot ship until `blockedBy` is resolved
 *
 * `costsVerified: false` means the worst-case figure is an assumption, not a
 * measured or vendor-confirmed number. The test suite refuses to let such a
 * meter go 'live' — pricing a feature off a guessed vendor rate is exactly how
 * you end up underwater on every call without noticing.
 */
export const METERS = {
  /**
   * One NOD Coach question. Worst case is the reservation the coach already
   * computes for itself: 34,500 micros on Claude Sonnet 5. Two tokens covers
   * it with room to spare, and the coach refunds down to actual usage on every
   * path, so a typical question costs a fraction of this.
   */
  coach_request: {
    id: 'coach_request',
    tokens: 2,
    worstCaseCostMicros: 34_500,
    costsVerified: true,
    status: 'live',
    label: 'NOD Coach question',
  },

  /**
   * One play of a Mix & Match arcade game (Rocketman today). Served as static
   * files, so the marginal cost is effectively zero — this is priced as an
   * arcade coin, not as cost recovery. It is the cheapest possible way to give
   * a balance a reason to be spent, which is the point: a user who spends
   * tokens on something fun is a user who tops up for something useful.
   */
  arcade_play: {
    id: 'arcade_play',
    tokens: 1,
    worstCaseCostMicros: 0,
    costsVerified: true,
    status: 'planned',
    label: 'Arcade play',
  },

  /**
   * One minute of audio transcribed.
   *
   * BLOCKED, and deliberately unpriced-for-real: Claude cannot transcribe
   * audio — the Messages API takes text, images and PDFs, and no audio at all.
   * This needs a separate speech-to-text vendor, so the cost basis below is a
   * placeholder standing in for "roughly the going rate", NOT a quote from
   * anyone. Confirm the real per-minute rate against the chosen vendor before
   * this ships; the test suite will not let it go 'live' until costsVerified
   * is true.
   */
  transcribe_minute: {
    id: 'transcribe_minute',
    tokens: 1,
    worstCaseCostMicros: 6_000,
    costsVerified: false,
    status: 'blocked',
    blockedBy: 'No STT vendor chosen. Claude has no audio input.',
    label: 'Transcription (per minute)',
  },

  /**
   * One coaching pass over a debrief or transcript. Costs more than a coach
   * question because the input is a whole conversation rather than a
   * paragraph: budgeting ~30k input + 2k output tokens on Sonnet 5
   * (3 and 15 micros per token) gives 120,000 micros worst case.
   */
  debrief_analysis: {
    id: 'debrief_analysis',
    tokens: 8,
    worstCaseCostMicros: 120_000,
    costsVerified: true,
    status: 'planned',
    label: 'Conversation debrief',
  },
};

/** Meters a user can actually be charged for right now. */
export function liveMeters() {
  return Object.values(METERS).filter((m) => m.status === 'live');
}

/**
 * What one unit of `meterId` costs, in micros — the number to hand
 * reserve_ai_credit. Throws for a meter that is not live, so a half-built
 * feature cannot quietly start taking people's tokens.
 */
export function meterCostMicros(meterId) {
  const meter = METERS[meterId];
  if (!meter) throw new TypeError(`Unknown meter: ${meterId}`);
  if (meter.status !== 'live') {
    throw new Error(`Meter ${meterId} is ${meter.status} and cannot be charged`);
  }
  return tokensToMicros(meter.tokens);
}

/** Gross margin on one unit of a meter, as a fraction of what we charge.
 *  1.0 = pure margin (costs us nothing), 0 = break-even, negative = losing. */
export function meterMargin(meterId) {
  const meter = METERS[meterId];
  if (!meter) throw new TypeError(`Unknown meter: ${meterId}`);
  const charged = tokensToMicros(meter.tokens);
  if (charged === 0) return 0;
  return (charged - meter.worstCaseCostMicros) / charged;
}

export const PRODUCT_NAME = 'Mix & Match';
export const SITE = 'negotiatorsondemand.com';
