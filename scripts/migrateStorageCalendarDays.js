/**
 * Change legacy settings to inclusive Asia/Manila calendar-date storage counting.
 * DRY RUN: npm run migrate:storage-calendar
 * APPLY:   npm run migrate:storage-calendar -- --apply
 * Back up the database before applying. Does NOT edit existing invoices,
 * payment records, gate-in/out timestamps, or completed movement histories.
 */
import 'dotenv/config';
import mongoose from 'mongoose';
import SiteSettings from '../src/models/SiteSettings.js';

if (!process.env.MONGODB_URI) throw new Error('MONGODB_URI is required.');
const apply = process.argv.includes('--apply');
await mongoose.connect(process.env.MONGODB_URI);
try {
  const previous = await SiteSettings.findOne({key:'COMPANY_CONTACT'}).lean();
  console.log(JSON.stringify({
    mode: apply ? 'APPLY' : 'DRY_RUN',
    current: previous?.storageBilling?.rounding || '(not configured)',
    next: 'CALENDAR_DAYS',
    description: 'Count both entry and exit calendar dates in Asia/Manila.',
    sample: 'Oct 27 22:00 to Oct 28 01:00 = 2 days',
    history: 'Existing paid invoices, receipts, completed bookings, and timestamps remain unchanged.',
  }, null, 2));
  if (apply) {
    await SiteSettings.updateOne(
      {key:'COMPANY_CONTACT'},
      {$set:{'storageBilling.rounding':'CALENDAR_DAYS'},$setOnInsert:{key:'COMPANY_CONTACT'}},
      {upsert:true},
    );
    console.log('New calendar-date storage billing rule enabled.');
  }
} finally {
  await mongoose.disconnect();
}
