import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  PAYMENT_REFERENCE_INDEX_NAME,
  PAYMENT_REFERENCE_INDEX_KEYS,
  PAYMENT_REFERENCE_PARTIAL_FILTER,
  isSafePaymentReferenceIndex,
  classifyPaymentReferenceIndexes,
} from '../src/utils/paymentReferenceIndex.js';
import { paymentReviewFailure } from '../src/utils/financialReviewErrors.js';

const valid = {
  name: PAYMENT_REFERENCE_INDEX_NAME,
  key: { method: 1, reference: 1 },
  unique: true,
  partialFilterExpression: PAYMENT_REFERENCE_PARTIAL_FILTER,
};
const obsolete = {
  name: PAYMENT_REFERENCE_INDEX_NAME,
  key: { method: 1, reference: 1 },
  unique: true,
  partialFilterExpression: { status: 'VERIFIED' },
};

test('payment index only checks nonempty active references', () => {
  assert.deepEqual(PAYMENT_REFERENCE_INDEX_KEYS, { method: 1, reference: 1 });
  assert.equal(PAYMENT_REFERENCE_PARTIAL_FILTER.reference.$gt, '');
  assert.equal(PAYMENT_REFERENCE_PARTIAL_FILTER.reference.$type, 'string');
  assert.deepEqual(new Set(PAYMENT_REFERENCE_PARTIAL_FILTER.status.$in), new Set(['VERIFIED', 'PENDING_VERIFICATION']));
});

test('index definitions compare without relying on key ordering', () => {
  assert.equal(isSafePaymentReferenceIndex(valid), true);
  assert.equal(isSafePaymentReferenceIndex({
    ...valid, partialFilterExpression: {
      reference: { $gt: '', $type: 'string' }, status: { $in: ['PENDING_VERIFICATION', 'VERIFIED'] },
    },
  }), true);
  assert.equal(isSafePaymentReferenceIndex(obsolete), false);
});

test('migration classifies legacy and unknown unique reference indexes without touching unrelated ones', () => {
  const indexes = [
    { name: '_id_', unique: true, key: { _id: 1 } },
    obsolete,
    { name: 'reference_1', unique: true, key: { reference: 1 } },
    { name: 'receiptNumber_1', unique: true, key: { receiptNumber: 1 } },
  ];
  const plan = classifyPaymentReferenceIndexes(indexes);
  assert.equal(plan.legacy.length, 1);
  assert.equal(classifyPaymentReferenceIndexes([{ ...obsolete, unique: false }]).legacy.length, 1);
  assert.equal(plan.unknown.length, 1);
  assert.equal(plan.safe.length, 0);
  assert.equal(classifyPaymentReferenceIndexes([valid]).safe.length, 1);
});

test('proof-only payment reference index conflict explains the migration instead of falsely claiming a reused reference', () => {
  const err = { code: 11000, keyPattern: { method: 1, reference: 1 } };
  const translated = paymentReviewFailure(err, { reference: '' });
  assert.equal(translated.status, 409);
  assert.match(translated.message, /legacy payment-reference database index/i);
  assert.match(translated.message, /payment-evidence index migration/i);
  assert.doesNotMatch(translated.message, /already assigned/);
  assert.match(paymentReviewFailure(err, { reference: 'ACTUAL-REFERENCE' }).message, /already assigned/);
});

test('receipt conflicts remain separate from payment evidence conflicts', () => {
  const result = paymentReviewFailure({ code: 11000, keyPattern: { receiptNumber: 1 } }, { reference: '' });
  assert.equal(result.status, 409);
  assert.match(result.message, /receipt number/i);
});

test('approval and both proof-only submission paths translate legacy reference index collisions', () => {
  const root = new URL('../src/controllers/', import.meta.url);
  const gateIn = readFileSync(new URL('invoiceController.js', root), 'utf8');
  const gateOut = readFileSync(new URL('clientGateOutController.js', root), 'utf8');
  assert.match(gateIn, /paymentReviewFailure\(error,\{reference:payment\?\.reference\}\)/);
  assert.match(gateIn, /paymentReviewFailure\(e,\{reference:req\.body\?\.reference\}\)/);
  assert.match(gateOut, /paymentReviewFailure\(e,\{reference:req\.body\?\.reference\}\)/);
});

test('migration stays opt-in and avoids rewriting historical financial documents', () => {
  const script = readFileSync(new URL('../scripts/migratePaymentEvidenceIndex.js', import.meta.url), 'utf8');
  assert.match(script, /process\.argv\.includes\('--apply'\)/);
  assert.match(script, /classifyPaymentReferenceIndexes/);
  assert.match(script, /collection\.indexes\(\)/);
  assert.match(script, /collection\.createIndex/);
  assert.doesNotMatch(script, /updateMany\(|deleteMany\(|dropDatabase\(/);
});
