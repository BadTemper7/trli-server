/**
 * Add indexes used by permission-filtered, persistent administrator alerts.
 * Usage: node scripts/migrateNotificationIndexes.js [--apply]
 * Safe to rerun. No notification, booking, payment or invoice is modified.
 */
import 'dotenv/config';
import mongoose from 'mongoose';
import Notification from '../src/models/Notification.js';

const apply = process.argv.includes('--apply');
if (!process.env.MONGODB_URI) {
  console.error('MONGODB_URI is required.');
  process.exitCode = 1;
} else {
  try {
    mongoose.set('autoIndex', false);
    await mongoose.connect(process.env.MONGODB_URI);
    const definitions = [
      { key: { audience: 1, module: 1, createdAt: -1 }, name: 'admin_notification_by_module' },
      { key: { audience: 1, modules: 1, createdAt: -1 }, name: 'admin_notification_by_modules' },
      { key: { audience: 1, createdAt: -1 }, name: 'notification_history_audience' },
    ];
    const existing = await Notification.collection.indexes().catch(error => {
      if (error.code === 26) return [];
      throw error;
    });
    for (const index of definitions) {
      const exists = existing.some(item => JSON.stringify(item.key) === JSON.stringify(index.key));
      if (exists) {
        console.log(`Present: ${index.name} (existing key matches)`);
      } else if (apply) {
        await Notification.collection.createIndex(index.key, { name: index.name, background: true });
        console.log(`Created: ${index.name}`);
      } else {
        console.log(`DRY RUN: create ${index.name} on the existing notifications collection`);
      }
    }
    if (!apply) console.log('Run npm run migrate:notification-indexes -- --apply after database backup.');
    console.log('No historical notification, payment or booking documents were changed.');
  } catch (error) {
    console.error('[NOTIFICATION_INDEX_MIGRATION_FAILED]', error);
    process.exitCode = 1;
  } finally {
    await mongoose.disconnect();
  }
}
