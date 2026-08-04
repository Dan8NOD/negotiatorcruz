// Negotiation Practice Lab — the single source of truth for what this costs.
//
// Every price ID, amount, seat count and display string lives here. The landing
// page, the checkout call, the invoice builder, the HR one-pager and the
// confirmation emails all read from this module and none of them hardcode a
// number.
//
// This file exists because the same mistake already happened once on this
// account. The chat-token product drifted across $3, $5, $10 and $15 — the
// Payment Link was pinned to an archived $3 price while the app advertised $15
// and the ledger granted a third number — and it was only caught by reading the
// Stripe dashboard by hand. See the TOKEN_PAYMENT_LINK_URL comment in the
// broker function for the full account. The fix there was a runtime drift
// alarm; the fix here is to never have a second copy of the number.
//
// Plain ESM with no dependencies on purpose: this is imported by a Deno edge
// function, by Node tests, and by the browser, and it has to work unchanged in
// all three.
//
// Prices live in Stripe account acct_1TmRIfS5XoRchjGL, live mode, under product
// prod_V0GJwFbecNUWk7 ("Negotiation Practice Lab").

/** Stripe product all three prices hang off. */
export const PRODUCT_ID = 'prod_V0GJwFbecNUWk7';

/** Every seat is four hours. Stated once, read everywhere. */
export const DURATION_HOURS = 4;

/** The room is capped at 12. This is a teaching constraint, not a server limit. */
export const DEFAULT_SEAT_CAP = 12;

/**
 * The ladder. Three SKUs, deliberately not four — the catalog on this account
 * is already too wide.
 *
 * Held at $350 on evidence, not instinct. Comparable open-enrollment virtual
 * negotiation training runs ~$47/seat/hour (MWI, 2 x 4hr, cap 26, $375) to
 * ~$31/seat/hour (NYC CMPD-7911, 8hr classroom, $250). At $350 for 4 hours this
 * is ~$88/seat/hour — at or slightly above that band already. The constraint on
 * revenue is not the price, it is that nine people attended the session this
 * product was modelled on and one of them paid. Raise only after a session
 * sells out at $350 with everyone paying.
 */
export const SKUS = {
  seat_open: {
    sku: 'seat_open',
    priceId: 'price_1U0FmaS5XoRchjGLXlA7Vmxh',
    amountCents: 35000,
    seatCount: 1,
    rail: 'checkout',
    label: 'Individual seat',
    blurb: 'One seat in the next public session.',
    display: '$350',
  },

  /**
   * The community rate ends free attendance without ending the community. Low
   * enough that a regular keeps showing up, high enough that the room stops
   * being free. Nobody attends unpaid once this ships.
   */
  seat_community: {
    sku: 'seat_community',
    priceId: 'price_1U0FmbS5XoRchjGLXa0dGYgv',
    amountCents: 15000,
    seatCount: 1,
    rail: 'checkout',
    label: 'Practice-community rate',
    blurb: 'Same session, same four hours, for regulars of the practice community.',
    display: '$150',
  },

  /**
   * Corporate buyers pay by invoice, so this SKU deliberately has no Payment
   * Link. An AP department cannot expense a card button.
   */
  cohort_private: {
    sku: 'cohort_private',
    priceId: 'price_1U0FmdS5XoRchjGLBQlp5oS4',
    amountCents: 350000,
    seatCount: 12,
    extraSeatCents: 25000,
    rail: 'invoice',
    label: 'Private company session',
    blurb: 'Your team only, four hours, up to 12 seats.',
    display: '$3,500',
  },
};

/** Seats sold individually, in the order the landing page shows them. */
export const SEAT_SKUS = [SKUS.seat_open, SKUS.seat_community];

/** Formats cents as plain dollars: 35000 -> "$350", 350000 -> "$3,500". */
export function formatCents(cents) {
  const dollars = cents / 100;
  const whole = Number.isInteger(dollars);
  return '$' + dollars.toLocaleString('en-US', {
    minimumFractionDigits: whole ? 0 : 2,
    maximumFractionDigits: whole ? 0 : 2,
  });
}

/**
 * Both cohort functions take the same argument and must agree on what counts
 * as a seat, or the invoice and the quote can describe different sales. Shared
 * so neither can be tightened without the other.
 */
function assertSeatCount(seatCount) {
  if (!Number.isInteger(seatCount) || seatCount < 1) {
    throw new TypeError(`seatCount must be a positive integer, got ${seatCount}`);
  }
}

/**
 * What a private cohort of `seatCount` costs: the flat rate up to the included
 * 12, plus the per-seat rate beyond it.
 */
export function cohortAmountCents(seatCount) {
  const base = SKUS.cohort_private;
  assertSeatCount(seatCount);
  const extra = Math.max(0, seatCount - base.seatCount);
  return base.amountCents + extra * base.extraSeatCents;
}

/** Invoice line items for a private cohort. The overage is its own line so an
 *  AP department can see what it is paying for without doing the arithmetic.
 *
 *  Validates on the same terms as cohortAmountCents. It used to not: a null,
 *  undefined or fractional seat count produced a single flat-rate line instead
 *  of throwing, so a malformed order row reaching the invoice builder billed
 *  the base rate with the overage silently dropped. The broker calls this with
 *  a seat count off a stored order (index.ts), which is exactly where a bad
 *  value would come from. */
export function cohortLineItems(seatCount) {
  const base = SKUS.cohort_private;
  assertSeatCount(seatCount);
  const extra = Math.max(0, seatCount - base.seatCount);
  const lines = [{
    description:
      `Negotiation Practice Lab — private cohort, ${DURATION_HOURS} hours, ` +
      `up to ${base.seatCount} seats`,
    amountCents: base.amountCents,
    priceId: base.priceId,
  }];
  if (extra > 0) {
    lines.push({
      description: `Additional seats beyond ${base.seatCount} (${extra} x ` +
        `${formatCents(base.extraSeatCents)})`,
      amountCents: extra * base.extraSeatCents,
      priceId: null,
    });
  }
  return lines;
}

/** Look up a SKU by its Stripe price ID. Used by the webhook to work out what
 *  was actually bought from what Stripe says was paid for. */
export function skuForPriceId(priceId) {
  return Object.values(SKUS).find((s) => s.priceId === priceId) ?? null;
}

/** Net terms on corporate invoices. */
export const INVOICE_DAYS_UNTIL_DUE = 30;

/** Where the money is remitted, as it should appear on an invoice. */
export const REMIT_TO = {
  businessName: 'Negotiators on Demand',
  email: 'negotiatorsondemand@gmail.com',
  w9Note: 'A W-9 is available on request.',
};

export const PRODUCT_NAME = 'Negotiation Practice Lab';
export const YOUTUBE_URL = 'https://www.youtube.com/@Negotiators';
export const SITE = 'negotiatorsondemand.com';
