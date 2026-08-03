// Pricing guards for the Negotiation Practice Lab.
//
// Three things are checked here, in increasing order of how badly they hurt
// when they break:
//
//   1. The module's own arithmetic (cohort overage, formatting).
//   2. That no price literal has been pasted anywhere outside the config.
//   3. That the amounts in the config still match what Stripe will actually
//      charge, live.
//
// (3) is the one that matters. The chat-token product on this same account
// drifted across $3, $5, $10 and $15 — the Payment Link was pinned to an
// archived price while the app advertised a different number and the ledger
// granted a third — and nobody found out from the code. This test makes that
// class of bug fail CI instead of quietly mispricing a sale.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  SKUS, SEAT_SKUS, DURATION_HOURS, DEFAULT_SEAT_CAP,
  cohortAmountCents, cohortLineItems, formatCents, skuForPriceId,
  INVOICE_DAYS_UNTIL_DUE, PRODUCT_ID,
} from '../config/pricing.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// ── the ladder is what it says it is ────────────────────────────────────────

test('the ladder has exactly three SKUs', () => {
  assert.deepEqual(Object.keys(SKUS).sort(),
    ['cohort_private', 'seat_community', 'seat_open'].sort());
});

test('every SKU carries the fields the rest of the build reads', () => {
  for (const [key, sku] of Object.entries(SKUS)) {
    assert.equal(sku.sku, key, `${key}.sku should match its key`);
    assert.match(sku.priceId, /^price_[A-Za-z0-9]+$/, `${key} needs a real Stripe price ID`);
    assert.ok(Number.isInteger(sku.amountCents) && sku.amountCents > 0);
    assert.ok(Number.isInteger(sku.seatCount) && sku.seatCount > 0);
    assert.ok(['checkout', 'invoice'].includes(sku.rail));
    assert.ok(sku.label && sku.display);
  }
});

test('the community rate undercuts the open rate', () => {
  // If this ever inverts, the discount has stopped being a discount.
  assert.ok(SKUS.seat_community.amountCents < SKUS.seat_open.amountCents);
});

test('corporate cohorts are invoiced, never carded', () => {
  // The brief is explicit: no Payment Link for cohort_private. An AP
  // department cannot expense a card button.
  assert.equal(SKUS.cohort_private.rail, 'invoice');
  assert.deepEqual(SEAT_SKUS.map((s) => s.rail), ['checkout', 'checkout']);
});

test('price IDs are unique', () => {
  const ids = Object.values(SKUS).map((s) => s.priceId);
  assert.equal(new Set(ids).size, ids.length);
});

test('skuForPriceId round-trips, and rejects strangers', () => {
  for (const sku of Object.values(SKUS)) {
    assert.equal(skuForPriceId(sku.priceId)?.sku, sku.sku);
  }
  assert.equal(skuForPriceId('price_not_ours'), null);
});

// ── cohort arithmetic ───────────────────────────────────────────────────────

test('a cohort at or under the included seats is the flat rate', () => {
  const flat = SKUS.cohort_private.amountCents;
  assert.equal(cohortAmountCents(1), flat);
  assert.equal(cohortAmountCents(SKUS.cohort_private.seatCount), flat);
});

test('seats beyond the included count bill at the extra-seat rate', () => {
  const { amountCents, seatCount, extraSeatCents } = SKUS.cohort_private;
  assert.equal(cohortAmountCents(seatCount + 1), amountCents + extraSeatCents);
  assert.equal(cohortAmountCents(seatCount + 3), amountCents + 3 * extraSeatCents);
});

test('cohort line items always sum to the quoted total', () => {
  for (const n of [1, 5, 12, 13, 20, 47]) {
    const sum = cohortLineItems(n).reduce((t, l) => t + l.amountCents, 0);
    assert.equal(sum, cohortAmountCents(n), `line items disagree with total at ${n} seats`);
  }
});

test('the overage is its own invoice line so AP can read it', () => {
  assert.equal(cohortLineItems(12).length, 1);
  assert.equal(cohortLineItems(13).length, 2);
});

test('a nonsense seat count is refused, not silently coerced', () => {
  for (const bad of [0, -1, 2.5, NaN, '12', null, undefined]) {
    assert.throws(() => cohortAmountCents(bad), TypeError);
  }
});

// ── display ─────────────────────────────────────────────────────────────────

test('money formats the way the page prints it', () => {
  assert.equal(formatCents(35000), '$350');
  assert.equal(formatCents(15000), '$150');
  assert.equal(formatCents(350000), '$3,500');
  assert.equal(formatCents(999), '$9.99');
});

test('each display string matches its own amount', () => {
  // Catches the specific failure where someone edits amountCents for a real
  // price change and leaves the human-readable string behind.
  for (const sku of Object.values(SKUS)) {
    assert.equal(sku.display, formatCents(sku.amountCents),
      `${sku.sku}.display is stale`);
  }
});

test('session shape constants are sane', () => {
  assert.equal(DURATION_HOURS, 4);
  assert.ok(DEFAULT_SEAT_CAP >= 1);
  assert.ok(INVOICE_DAYS_UNTIL_DUE > 0);
  assert.match(PRODUCT_ID, /^prod_[A-Za-z0-9]+$/);
});

// ── nobody has pasted a price somewhere else ────────────────────────────────

/** Walk the build, skipping the two places a price literal legitimately lives. */
async function sourceFiles(dir = ROOT, out = []) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      // config/ defines the numbers; test/ asserts on them. Everywhere else
      // must go through the module.
      if (entry.name === 'config' || entry.name === 'test') continue;
      await sourceFiles(full, out);
    } else if (/\.(js|ts|html|md)$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

test('no price literal appears outside config and tests', async () => {
  // Acceptance criterion 5, mechanised. Matches the money forms a human would
  // actually type — $350, 35000, $3,500 — rather than every occurrence of the
  // digits, which would trip over things like a 350ms timeout.
  const forbidden = [
    /\$\s?350\b/, /\$\s?150\b/, /\$\s?3,?500\b/,
    /\b35000\b/, /\b15000\b/, /\b350000\b/,
  ];
  const offenders = [];

  for (const file of await sourceFiles()) {
    // pricing.js is copied next to the edge function so Deno can import it;
    // it is the same file, not a second copy of the numbers.
    if (file.endsWith(join('broker', 'pricing.js'))) continue;
    const text = await readFile(file, 'utf8');
    text.split('\n').forEach((line, i) => {
      for (const re of forbidden) {
        if (re.test(line)) {
          offenders.push(`${file.replace(ROOT, '.')}:${i + 1}  ${line.trim()}`);
          break;
        }
      }
    });
  }

  assert.deepEqual(offenders, [],
    `price literals must come from config/pricing.js:\n${offenders.join('\n')}`);
});

// ── the number Stripe will actually charge ──────────────────────────────────

test('config amounts match live Stripe prices', async (t) => {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) {
    // Skipped rather than failed so the suite still runs for a contributor
    // without billing credentials. In CI, set STRIPE_SECRET_KEY and this
    // becomes the guard that catches a dashboard edit nobody committed.
    t.skip('STRIPE_SECRET_KEY not set — cannot verify against live Stripe');
    return;
  }

  for (const sku of Object.values(SKUS)) {
    const res = await fetch(`https://api.stripe.com/v1/prices/${sku.priceId}`, {
      headers: { Authorization: `Bearer ${key}` },
    });
    assert.ok(res.ok, `Stripe rejected a lookup of ${sku.priceId} (${res.status})`);
    const price = await res.json();

    assert.equal(price.unit_amount, sku.amountCents,
      `${sku.sku}: Stripe charges ${price.unit_amount} but config says ${sku.amountCents}`);
    assert.equal(price.currency, 'usd', `${sku.sku} must be priced in USD`);
    assert.equal(price.type, 'one_time', `${sku.sku} must be a one-time price`);
    assert.equal(price.active, true, `${sku.sku} points at an archived price`);
    assert.equal(price.product, PRODUCT_ID, `${sku.sku} hangs off the wrong product`);
    assert.equal(price.metadata?.sku, sku.sku, `${sku.sku} metadata.sku disagrees`);
    assert.equal(Number(price.metadata?.duration_hours), DURATION_HOURS);
    assert.equal(Number(price.metadata?.seat_count), sku.seatCount);
  }
});
