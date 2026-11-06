/**
 * Set SiteSettings metadata to VAT-exclusive for future billing. Does not
 * touch Rate amounts, bookings, invoices, payment submissions or receipts.
 *
 * Usage:
 *   npm run migrate:vat-exclusive               # dry run
 *   npm run migrate:vat-exclusive -- --apply     # after backup/deploy planning
 */
import 'dotenv/config';
import mongoose from 'mongoose';
import { connectDB } from '../src/config/db.js';

const apply = process.argv.includes('--apply');
if (!process.env.MONGODB_URI) throw new Error('MONGODB_URI is required.');
mongoose.set('autoIndex', false);
await connectDB();
try {
  const collection = mongoose.connection.collection('sitesettings');
  const settings = await collection.find({}, { projection: { _id: 1, key: 1, tax: 1 } }).toArray();
  const pending = settings.filter(item => item.tax?.vatInclusive !== false);
  console.log('[VAT_EXCLUSIVE] Mode:', apply ? 'APPLY' : 'DRY RUN');
  console.log('[VAT_EXCLUSIVE] Settings records:', settings.length);
  console.log('[VAT_EXCLUSIVE] Records requiring metadata update:', pending.length);
  console.log('[VAT_EXCLUSIVE] Configured VAT rates and Rate amounts are preserved.');
  console.log('[VAT_EXCLUSIVE] Existing invoices, receipts, payments and booking snapshots remain unchanged.');
  if (apply && pending.length) {
    const result = await collection.updateMany(
      { _id: { $in: pending.map(item => item._id) } },
      { $set: { 'tax.vatInclusive': false } },
    );
    console.log('[VAT_EXCLUSIVE] Metadata records updated:', result.modifiedCount);
    const after = await collection.countDocuments({ _id: { $in: pending.map(item => item._id) }, 'tax.vatInclusive': { $ne: false } });
    if (after) throw new Error(`VAT-exclusive metadata verification failed for ${after} settings record(s).`);
  } else if (!apply && pending.length) {
    console.log('[VAT_EXCLUSIVE] Back up MongoDB and run: npm run migrate:vat-exclusive -- --apply');
  }
  if (apply || !pending.length) console.log('[VAT_EXCLUSIVE] Verified: settings are VAT-exclusive. Financial history was not repriced.');
} finally {
  await mongoose.disconnect();
}
