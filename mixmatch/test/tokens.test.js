// Guards for the Mix & Match token meter.
//
// Three classes of failure this is here to catch, in increasing order of how
// expensive they are to find in production:
//
//   1. Arithmetic that disagrees with itself (a pack's token count drifting
//      from its micro grant).
//   2. A meter priced below what it costs to serve — every call loses money,
//      and nothing tells you until you read a Stripe report against an
//      Anthropic invoice.
//   3. A feature going chargeable before its cost basis is real, or before the
//      thing blocking it is resolved.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  TOKEN_MICROS, GRANTS, METERS,
  tokensToMicros, microsToTokens, grantTokens, formatTokens,
  meterCostMicros, meterMargin, liveMeters,
} from '../config/tokens.js';

// ── the unit ────────────────────────────────────────────────────────────────

test('a token is a whole number of micros', () => {
  assert.ok(Number.isInteger(TOKEN_MICROS) && TOKEN_MICROS > 0);
});

test('tokens and micros round-trip', () => {
  for (const n of [0, 1, 2, 100, 150, 4321]) {
    assert.equal(microsToTokens(tokensToMicros(n)), n);
  }
});

test('a partial token is not spendable', () => {
  // Rounding up would let a balance advertise a token it cannot actually buy.
  assert.equal(microsToTokens(TOKEN_MICROS - 1), 0);
  assert.equal(microsToTokens(TOKEN_MICROS * 3 - 1), 2);
});

test('nonsense token counts are refused, not coerced', () => {
  for (const bad of [-1, 1.5, NaN, '10', null, undefined]) {
    assert.throws(() => tokensToMicros(bad), TypeError);
  }
});

test('formatTokens singularises', () => {
  assert.equal(formatTokens(1), '1 token');
  assert.equal(formatTokens(150), '150 tokens');
  assert.equal(formatTokens(1500), '1,500 tokens');
});

// ── grants tie back to what the broker actually gives ───────────────────────

test('the $15 pack is a whole number of tokens', () => {
  // If this ever comes out fractional, the pack is advertising tokens a buyer
  // cannot spend to the last one.
  assert.equal(GRANTS.pack_15.micros % TOKEN_MICROS, 0);
  assert.equal(grantTokens('pack_15'), 150);
});

test('the monthly subscription allowance is a whole number of tokens', () => {
  assert.equal(GRANTS.subscription_monthly.micros % TOKEN_MICROS, 0);
  assert.equal(grantTokens('subscription_monthly'), 100);
});

test('grants match the micro figures the broker grants', () => {
  // These are not free parameters — they mirror TOKEN_PURCHASE_MICROS and
  // MONTHLY_TOKEN_GRANT_MICROS in supabase/functions/broker/index.ts. If the
  // broker changes what it grants and this does not, the UI promises tokens
  // the ledger never issued.
  assert.equal(GRANTS.pack_15.micros, 3_000_000);
  assert.equal(GRANTS.subscription_monthly.micros, 2_000_000);
});

test('subscribing is better per-token value than topping up', () => {
  // Deliberate: the subscription is the commitment and should reward it;
  // top-ups are the impulse buy. If this ever inverts, the $5/mo has stopped
  // being the better deal and the funnel is upside down.
  const perTokenSub = GRANTS.subscription_monthly.priceCents / grantTokens('subscription_monthly');
  const perTokenPack = GRANTS.pack_15.priceCents / grantTokens('pack_15');
  assert.ok(
    perTokenSub < perTokenPack,
    `subscription is ${perTokenSub}c/token vs pack ${perTokenPack}c/token`
  );
});

test('unknown grants throw', () => {
  assert.throws(() => grantTokens('pack_99'), TypeError);
});

// ── meters ──────────────────────────────────────────────────────────────────

test('every meter declares the fields the ledger and UI read', () => {
  for (const [key, meter] of Object.entries(METERS)) {
    assert.equal(meter.id, key, `${key}.id should match its key`);
    assert.ok(Number.isInteger(meter.tokens) && meter.tokens > 0, `${key} needs a token price`);
    assert.ok(Number.isInteger(meter.worstCaseCostMicros) && meter.worstCaseCostMicros >= 0);
    assert.ok(['live', 'planned', 'blocked'].includes(meter.status), `${key} has a bad status`);
    assert.equal(typeof meter.costsVerified, 'boolean');
    assert.ok(meter.label, `${key} needs a label`);
  }
});

test('no meter is priced below what it costs to serve', () => {
  // The one that matters. A meter under water loses money on every single
  // call, and the only other way to find out is reconciling a Stripe report
  // against an Anthropic invoice by hand.
  const underwater = Object.values(METERS)
    .filter((m) => tokensToMicros(m.tokens) < m.worstCaseCostMicros)
    .map((m) => `${m.id}: charges ${tokensToMicros(m.tokens)} micros, costs up to ${m.worstCaseCostMicros}`);

  assert.deepEqual(underwater, [], `meters priced below cost:\n  ${underwater.join('\n  ')}`);
});

test('a live meter cannot rest on an unverified cost basis', () => {
  // Pricing a feature off a guessed vendor rate is how you end up underwater
  // on every call without noticing. Guess all you like while planning; do not
  // charge for it.
  const guessed = liveMeters().filter((m) => !m.costsVerified).map((m) => m.id);
  assert.deepEqual(guessed, [], `live meters with unverified costs: ${guessed.join(', ')}`);
});

test('a blocked meter says what blocks it', () => {
  for (const meter of Object.values(METERS)) {
    if (meter.status === 'blocked') {
      assert.ok(meter.blockedBy, `${meter.id} is blocked but does not say why`);
    }
  }
});

test('only live meters can be charged', () => {
  // meterCostMicros is what a caller hands reserve_ai_credit. A half-built
  // feature must not be able to take someone's tokens.
  assert.equal(meterCostMicros('coach_request'), 2 * TOKEN_MICROS);
  for (const meter of Object.values(METERS)) {
    if (meter.status !== 'live') {
      assert.throws(() => meterCostMicros(meter.id), /cannot be charged/);
    }
  }
  assert.throws(() => meterCostMicros('nope'), TypeError);
});

test('the coach meter covers the reservation the coach computes for itself', () => {
  // 34,500 micros is worstCaseCostMicros(MODEL) in nod-negotiation-coach on
  // Claude Sonnet 5. If the coach's model or output ceiling changes, its own
  // CI check moves that number and this one has to follow.
  assert.ok(
    tokensToMicros(METERS.coach_request.tokens) >= 34_500,
    'coach meter no longer covers the coach reservation'
  );
});

test('margins are reported as a fraction, not a surprise', () => {
  assert.equal(meterMargin('arcade_play'), 1); // costs nothing to serve
  assert.ok(meterMargin('coach_request') > 0 && meterMargin('coach_request') < 1);
  assert.throws(() => meterMargin('nope'), TypeError);
});

// ── nobody has pasted a price somewhere else ────────────────────────────────

test('token amounts are not duplicated as literals in the config', async () => {
  // Same guard as practice-lab's, scoped to the one file that defines the
  // numbers: the derived values (150 tokens, 100 tokens) must be computed from
  // TOKEN_MICROS rather than written down a second time, or the two copies
  // drift the moment either grant changes.
  const { readFile } = await import('node:fs/promises');
  const src = await readFile(new URL('../config/tokens.js', import.meta.url), 'utf8');

  const offenders = src
    .split('\n')
    .map((line, i) => [i + 1, line])
    .filter(([, line]) => !line.trimStart().startsWith('*') && !line.trimStart().startsWith('//'))
    .filter(([, line]) => /\btokens:\s*\d{3,}/.test(line))
    .map(([n, line]) => `tokens.js:${n}  ${line.trim()}`);

  assert.deepEqual(offenders, [], `suspiciously large hardcoded token counts:\n${offenders.join('\n')}`);
});
