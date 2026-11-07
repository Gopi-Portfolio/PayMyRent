// Run: npx tsx scripts/format.test.ts   (also exercises the no-Intl.Segmenter fallback used on Hermes)
import assert from 'node:assert/strict';

import { formatINR, graphemeCount, normalizeMobile, parseRupeesToPaise } from '../src/lib/format';

for (const fallback of [false, true]) {
  const saved = (Intl as any).Segmenter;
  if (fallback) delete (Intl as any).Segmenter;
  for (const [s, n] of [['a', 1], ['க', 1], ['கி', 1], ['क्ष', 1], ['ಕೃ', 1], ['👍🏽', 1], ['🇮🇳', 1], ['👨‍👩‍👧', 1]] as const) {
    assert.equal(graphemeCount(s), n, `${fallback ? 'fallback' : 'segmenter'}: ${s}`);
    assert.equal(graphemeCount(s.repeat(250)), 250);
  }
  if (fallback) (Intl as any).Segmenter = saved;
}
assert.equal(normalizeMobile('+91 98765-43210'), '+919876543210');
assert.equal(normalizeMobile('09876543210'), '+919876543210');
assert.equal(normalizeMobile('5876543210'), null);
assert.equal(normalizeMobile('987654321'), null);
assert.equal(parseRupeesToPaise('7,000.5'), 700050);
assert.equal(parseRupeesToPaise('1e3'), null);
assert.equal(parseRupeesToPaise('-5'), null);
assert.equal(parseRupeesToPaise('0.01'), 1);
assert.equal(formatINR(123456750), '₹12,34,567.50');
assert.equal(formatINR(1000000), '₹10,000');
assert.equal(formatINR(-300000), '-₹3,000');
console.log('format helpers: all assertions passed');
