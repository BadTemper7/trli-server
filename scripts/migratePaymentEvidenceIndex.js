import 'dotenv/config';
import mongoose from 'mongoose';
import { connectDB } from '../src/config/db.js';
import {
  PAYMENT_REFERENCE_INDEX_NAME,
  PAYMENT_REFERENCE_INDEX_KEYS,
  PAYMENT_REFERENCE_PARTIAL_FILTER,
  classifyPaymentReferenceIndexes,
} from '../src/utils/paymentReferenceIndex.js';

/**
 * Repair indexes installed by older deployments, which could treat an empty
 * payment reference as unique and reject proof-only payments on approval.
 *
 * Default is read-only. Run with --apply only after backup and while payment
 * submission/verification writes are stopped (index replacement is not atomic).
 * Never change existing payments, receipts or financial records.
 */
const applying = process.argv.includes('--apply');
mongoose.set('autoIndex', false);
await connectDB();
try {
  const collection = mongoose.connection.collection('paymentsubmissions');
  const indexes = await collection.indexes();
  const { safe, legacy, unknown } = classifyPaymentReferenceIndexes(indexes);

  console.log('[PAYMENT_REFERENCE_INDEX] Existing:', JSON.stringify(indexes
    .filter(index => Object.hasOwn(index.key || {}, 'reference'))
    .map(index => ({ name: index.name, key: index.key, unique: index.unique, partialFilterExpression: index.partialFilterExpression }))));

  if (unknown.length) {
    throw new Error(`Unrecognized unique payment-reference index(es): ${unknown.map(index => index.name).join(', ')}. Do not drop custom indexes automatically; review them with the DBA.`);
  }
  if (safe.length === 1 && legacy.length === 0) {
    console.log('[PAYMENT_REFERENCE_INDEX] Already correct: proof-only submissions are excluded from payment-reference uniqueness.');
  } else {
    // Check all currently active references, including pending submissions. A
    // previously weaker index may have allowed duplicates of a real reference.
    const duplicates = await collection.aggregate([
      { $match: PAYMENT_REFERENCE_PARTIAL_FILTER },
      { $group: { _id: { method: '$method', reference: '$reference' }, count: { $sum: 1 } } },
      { $match: { count: { $gt: 1 } } },
      { $limit: 1 },
    ]).toArray();
    if (duplicates.length) {
      throw new Error('Duplicate nonblank active payment references exist. Reconcile the actual payments before changing this index. No data or index has been modified.');
    }
    console.log('[PAYMENT_REFERENCE_INDEX] Required: unique {method,reference}, only when reference is nonblank and payment is pending/verified.');
    console.log('[PAYMENT_REFERENCE_INDEX] Legacy indexes to replace:', legacy.map(index => index.name).join(', ') || '(none)');
    if (!applying) {
      console.log('[PAYMENT_REFERENCE_INDEX] DRY RUN: back up MongoDB, pause payment writes, then run: npm run migrate:payment-evidence -- --apply');
    } else {
      // Never drop an unrelated index. Replacing the known index under the same
      // name requires a brief maintenance window; this is NOT an online migration.
      const dropped = [];
      try {
        for (const index of legacy) {
          await collection.dropIndex(index.name);
          dropped.push(index);
        }
        if (!safe.length) {
          await collection.createIndex(PAYMENT_REFERENCE_INDEX_KEYS, {
            name: PAYMENT_REFERENCE_INDEX_NAME,
            unique: true,
            partialFilterExpression: PAYMENT_REFERENCE_PARTIAL_FILTER,
          });
        }
      } catch (error) {
        // A failed build must not silently leave the database without the
        // previously enforced reference indexes. Keep payments paused.
        console.error('[PAYMENT_REFERENCE_INDEX] New index could not be installed; attempting to restore the prior indexes.');
        for (const original of dropped) {
          try {
            const options = { name: original.name, unique: Boolean(original.unique) };
            for (const option of ['partialFilterExpression', 'sparse', 'collation', 'hidden']) {
              if (original[option] !== undefined) options[option] = original[option];
            }
            await collection.createIndex(original.key, options);
          } catch (rollbackError) {
            console.error('[PAYMENT_REFERENCE_INDEX] CRITICAL: restoring original index failed:', original.name, rollbackError.message);
          }
        }
        throw error;
      }
      const after = classifyPaymentReferenceIndexes(await collection.indexes());
      if (after.safe.length !== 1 || after.legacy.length || after.unknown.length) {
        throw new Error('Payment-reference index verification failed. Keep payment writes disabled and investigate the database index definitions.');
      }
      console.log('[PAYMENT_REFERENCE_INDEX] Verified: one correct unique nonblank active reference index. Existing payments were not modified.');
    }
  }
} finally {
  await mongoose.disconnect();
}
