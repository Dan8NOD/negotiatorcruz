// The pricing module is deployed in more than one place. This checks the
// copies have not drifted.
//
// config/pricing.js is the source. A byte-identical copy sits next to the
// broker edge function because Deno imports it from disk at deploy time and
// cannot reach across the repo for it.
//
// That copy is a hole in the existing guards. `pricing.test.js` scans the
// build for pasted price literals and deliberately skips broker/pricing.js,
// on the stated grounds that "it is the same file, not a second copy of the
// numbers". True today, and nothing was checking it: edit one file and not
// the other and the skip means the drifted copy is not even scanned. The
// module's own header says the fix is "to never have a second copy of the
// number" — this is what makes that claim enforceable rather than aspirational.
//
// Copies are discovered rather than listed, so a third one added tomorrow is
// covered without touching this file.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = join(ROOT, 'config', 'pricing.js');

/** Every pricing.js under practice-lab/, source included. */
async function findCopies(dir = ROOT, out = []) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) await findCopies(full, out);
    else if (entry.name === 'pricing.js') out.push(full);
  }
  return out;
}

test('the source of truth is where everything expects it', async () => {
  const copies = await findCopies();
  assert.ok(
    copies.includes(SOURCE),
    'config/pricing.js is the path the tests and the web pages import'
  );
});

test('every deployed copy of pricing.js is byte-identical to the source', async () => {
  const copies = await findCopies();
  const source = await readFile(SOURCE, 'utf8');

  const drifted = [];
  for (const copy of copies) {
    if (copy === SOURCE) continue;
    const text = await readFile(copy, 'utf8');
    if (text !== source) drifted.push(relative(ROOT, copy));
  }

  assert.deepEqual(
    drifted,
    [],
    'these copies have drifted from config/pricing.js and will price differently ' +
      `than the site advertises:\n  ${drifted.join('\n  ')}\n` +
      'Re-copy config/pricing.js over them.'
  );
});

test('the broker copy is present, since the edge function imports it', async () => {
  // index.ts does `from "./pricing.js"`. If the copy goes missing the function
  // fails to deploy rather than mispricing anything, but the failure surfaces
  // in Supabase logs rather than here, which is a slower way to find out.
  const broker = join(ROOT, 'supabase', 'functions', 'broker', 'pricing.js');
  const copies = await findCopies();

  assert.ok(copies.includes(broker), 'broker/pricing.js is missing; the edge function imports it');
});

test('every copy exports the same prices, not just the same bytes', async () => {
  // Byte equality already implies this. Asserted separately because it is the
  // property that actually matters, and because a future copy that is
  // legitimately reformatted (different header, same numbers) should still be
  // held to the prices even if the bytes test is relaxed.
  const copies = await findCopies();
  const source = await import(SOURCE);

  for (const copy of copies) {
    if (copy === SOURCE) continue;
    const mod = await import(copy);

    assert.deepEqual(
      mod.SKUS,
      source.SKUS,
      `${relative(ROOT, copy)} exports different SKUs than config/pricing.js`
    );
    assert.equal(mod.PRODUCT_ID, source.PRODUCT_ID);
    assert.equal(mod.DURATION_HOURS, source.DURATION_HOURS);
    assert.equal(mod.INVOICE_DAYS_UNTIL_DUE, source.INVOICE_DAYS_UNTIL_DUE);
  }
});
