import test from 'node:test';
import assert from 'node:assert/strict';
import { formatReference } from '../src/utils/referenceFormat.js';

test('booking and invoice numbers use different recognizable prefixes', () => {
  const date = new Date('2026-10-27T09:00:00Z');
  assert.equal(formatReference('BOOKING', date, 1), 'TRANS-BKG-20261027-0001');
  assert.equal(formatReference('INVOICE', date, 1), 'TRANS-INV-20261027-0001');
  assert.notEqual(formatReference('BOOKING', date, 1), formatReference('INVOICE', date, 1));
});

test('receipt numbers have their own prefix and date uses Asia/Manila', () => {
  assert.equal(formatReference('RECEIPT', new Date('2026-10-26T17:01:00Z'), 4), 'TRANS-RCT-20261027-0004');
  assert.equal(formatReference('BOOKING', new Date('2026-10-26T15:59:59Z'), 12), 'TRANS-BKG-20261026-0012');
});

test('sequence grows beyond four digits without truncation', () => {
  assert.equal(formatReference('INVOICE', new Date('2026-10-26T16:00:00Z'), 10012), 'TRANS-INV-20261027-10012');
});

test('rejects unsupported numbering types', () => {
  assert.throws(() => formatReference('PAYMENT', new Date(), 1), /Unsupported reference type/);
});
