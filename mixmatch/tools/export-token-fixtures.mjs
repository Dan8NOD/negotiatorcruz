/**
 * Export the token meter as a fixture the Swift port must reproduce exactly.
 *
 * config/tokens.js is the reference: it is the definition the web app, the
 * broker and the ledger all read. The iOS client gets its own copy of these
 * numbers because a Swift package cannot import an ESM module — and a second
 * copy of a price is precisely the thing that produced the $3/$5/$10/$15
 * chat-token drift this project has already paid for once.
 *
 * So the copy is not trusted. This exports what JavaScript actually computes,
 * and MixMatchKitTests asserts the Swift constants agree. Change a token price
 * in one language and CI fails until the other follows.
 *
 * Unlike the Rocketman fixtures, every value here is an integer — micros,
 * token counts, cents. There is no float precision to preserve, so the values
 * cross as plain JSON numbers. What is being guarded is drift, not rounding.
 *
 *   node mixmatch/tools/export-token-fixtures.mjs
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  TOKEN_MICROS, GRANTS, METERS,
  tokensToMicros, microsToTokens, grantTokens,
} from '../config/tokens.js';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, '..', 'swift', 'Tests', 'MixMatchKitTests', 'Fixtures');

/* Sorted so the file is byte-stable across runs: an exporter whose output
   reorders itself produces a diff on every regeneration, which trains everyone
   to stop reading those diffs. */
const sorted = (obj, pick) =>
  Object.keys(obj).sort().map((key) => pick(obj[key]));

const fixture = {
  tokenMicros: TOKEN_MICROS,

  grants: sorted(GRANTS, (g) => ({
    id: g.id,
    priceCents: g.priceCents,
    micros: g.micros,
    tokens: grantTokens(g.id),
    rail: g.rail,
  })),

  meters: sorted(METERS, (m) => ({
    id: m.id,
    tokens: m.tokens,
    micros: tokensToMicros(m.tokens),
    worstCaseCostMicros: m.worstCaseCostMicros,
    costsVerified: m.costsVerified,
    status: m.status,
  })),

  /* Conversion cases chosen for the edges, not the happy path: zero, one, a
     boundary one micro short of a whole token, and the two grant sizes. A
     round-numbers-only fixture would pass against a Swift implementation that
     rounds the wrong way. */
  conversions: [0, 1, 2, 99, 100, 150]
    .map((tokens) => ({ tokens, micros: tokensToMicros(tokens) })),

  flooring: [0, 1, TOKEN_MICROS - 1, TOKEN_MICROS, TOKEN_MICROS * 3 - 1, 3_000_000]
    .map((micros) => ({ micros, tokens: microsToTokens(micros) })),
};

mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, 'tokens.json'), JSON.stringify(fixture, null, 2) + '\n');
console.log(`wrote ${join(outDir, 'tokens.json')}`);
