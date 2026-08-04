// Invoice building for private cohorts.
//
// pricing.test.js already checks the arithmetic on valid seat counts. This
// covers the boundary the two cohort functions have to share: what they do
// when the seat count is not a seat count.
//
// They used to disagree. cohortAmountCents refused anything that was not a
// positive integer; cohortLineItems accepted all of it and emitted a single
// flat-rate line, so 0, -5, 2.5, null and undefined each produced a $3,500
// invoice with no overage. The broker builds invoices from a stored order row
// (`cohortLineItems(order.seat_count)` in index.ts) while quoting through
// cohortAmountCents, so a malformed row could be quoted as an error and
// invoiced as a sale.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  SKUS,
  DURATION_HOURS,
  cohortAmountCents,
  cohortLineItems,
  formatCents,
} from '../config/pricing.js';

const BASE = SKUS.cohort_private;

/** Every value that is not a positive integer number of seats. */
const NOT_A_SEAT_COUNT = [0, -1, -5, 2.5, 0.5, NaN, Infinity, -Infinity, '12', '', null, undefined, {}, [], true];

describe('both cohort functions agree on what a seat count is', () => {
  for (const bad of NOT_A_SEAT_COUNT) {
    test(`${JSON.stringify(bad) ?? String(bad)} is refused by both`, () => {
      assert.throws(() => cohortAmountCents(bad), TypeError);
      assert.throws(
        () => cohortLineItems(bad),
        TypeError,
        `cohortLineItems accepted ${String(bad)} and would have invoiced for it`
      );
    });
  }

  test('neither function can be tightened without the other', () => {
    // The property that matters is agreement, not the specific rule. If the
    // definition of a valid seat count ever changes, this still holds.
    for (const value of [...NOT_A_SEAT_COUNT, 1, 11, 12, 13, 500]) {
      const amountThrew = (() => {
        try {
          cohortAmountCents(value);
          return false;
        } catch {
          return true;
        }
      })();
      const linesThrew = (() => {
        try {
          cohortLineItems(value);
          return false;
        } catch {
          return true;
        }
      })();

      assert.equal(
        amountThrew,
        linesThrew,
        `disagreement at ${String(value)}: quote ${amountThrew ? 'threw' : 'succeeded'} ` +
          `but invoice ${linesThrew ? 'threw' : 'succeeded'}`
      );
    }
  });
});

describe('the invoice always matches the quote', () => {
  test('line items sum to the quoted total across the whole valid range', () => {
    // pricing.test.js spot-checks six seat counts; this walks the boundary and
    // a wide tail, since the overage only starts at seat 13.
    for (let n = 1; n <= 60; n++) {
      const sum = cohortLineItems(n).reduce((total, line) => total + line.amountCents, 0);
      assert.equal(sum, cohortAmountCents(n), `line items disagree with the total at ${n} seats`);
    }
  });

  test('the flat rate covers every seat up to the included cap', () => {
    for (let n = 1; n <= BASE.seatCount; n++) {
      assert.equal(cohortAmountCents(n), BASE.amountCents);
      assert.equal(cohortLineItems(n).length, 1, `${n} seats should not produce an overage line`);
    }
  });

  test('the overage line appears exactly one seat past the cap', () => {
    assert.equal(cohortLineItems(BASE.seatCount).length, 1);
    assert.equal(cohortLineItems(BASE.seatCount + 1).length, 2);
  });
});

describe('what an AP department reads', () => {
  test('the base line names the product, the duration and the included seats', () => {
    const [base] = cohortLineItems(12);

    assert.match(base.description, /Negotiation Practice Lab/);
    assert.match(base.description, new RegExp(`${DURATION_HOURS} hours`));
    assert.match(base.description, new RegExp(`${BASE.seatCount} seats`));
    assert.equal(base.amountCents, BASE.amountCents);
  });

  test('the base line carries the Stripe price it bills against', () => {
    assert.equal(cohortLineItems(20)[0].priceId, BASE.priceId);
  });

  test('the overage line shows the count and the unit rate, not just a total', () => {
    // So the buyer can check the arithmetic without opening a calculator.
    const [, overage] = cohortLineItems(17);

    assert.match(overage.description, /5 x/, 'should state how many extra seats');
    assert.match(
      overage.description,
      new RegExp(formatCents(BASE.extraSeatCents).replace('$', '\\$')),
      'should state the per-seat rate'
    );
    assert.equal(overage.amountCents, 5 * BASE.extraSeatCents);
  });

  test('the overage line has no price ID, because Stripe has no SKU for it', () => {
    assert.equal(cohortLineItems(13)[1].priceId, null);
  });

  test('no line is ever zero or negative', () => {
    for (const n of [1, 12, 13, 50]) {
      for (const line of cohortLineItems(n)) {
        assert.ok(line.amountCents > 0, `${n} seats produced a ${line.amountCents} line`);
        assert.ok(line.description.trim().length > 0, 'a line has no description');
      }
    }
  });
});
