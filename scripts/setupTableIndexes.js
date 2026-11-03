// Additive table-index migration. Does not modify documents or drop indexes.
// createIndexes() may resolve to undefined in some Mongoose/driver versions;
// always verify the indexes in MongoDB instead of relying on its return value.
import 'dotenv/config';
import mongoose from 'mongoose';
import PreAdvice from '../src/models/PreAdvice.js';
import Invoice from '../src/models/Invoice.js';
import HistoricalContainer from '../src/models/HistoricalContainer.js';
import AdminAuditLog from '../src/models/AdminAuditLog.js';
import Notification from '../src/models/Notification.js';

const uri = process.env.MONGO_URI || process.env.MONGODB_URI;
if (!uri) throw new Error('MONGO_URI or MONGODB_URI is required');

// Only validate the named indexes owned by the table-pagination upgrade.
// The call to createIndexes still preserves all other schema-declared indexes.
const tableIndexes = (model) => model.schema.indexes()
  .filter(([, options]) => /^idx_/.test(options.name || ''))
  .map(([key, options]) => ({ name: options.name, key }));
const matchesKeys = (actual, expected) => JSON.stringify(Object.entries(actual || {})) ===
  JSON.stringify(Object.entries(expected || {}));
async function listExistingIndexes(model) {
  try { return await model.collection.listIndexes().toArray(); }
  catch (error) {
    // Empty/never-used collections need createIndexes to create the namespace.
    if (error.code === 26 || error.codeName === 'NamespaceNotFound') return [];
    throw error;
  }
}

try {
  await mongoose.connect(uri, { autoIndex: false, serverSelectionTimeoutMS: 10_000 });
  for (const model of [PreAdvice, Invoice, HistoricalContainer, AdminAuditLog, Notification]) {
    const expected = tableIndexes(model);
    const before = new Set((await listExistingIndexes(model)).map(index => index.name));
    await model.createIndexes();
    const actual = await listExistingIndexes(model);
    const byName = new Map(actual.map(index => [index.name, index]));
    const missing = expected.filter(index => !byName.has(index.name) || !matchesKeys(byName.get(index.name).key, index.key));
    if (missing.length) throw new Error(`${model.modelName} indexes are missing or mismatched: ${missing.map(index => index.name).join(', ')}`);
    const added = expected.filter(index => !before.has(index.name)).map(index => index.name);
    console.log(`[INDEXES] ${model.modelName}: verified ${expected.length}, new ${added.length}, existing ${expected.length - added.length}`);
    if (added.length) console.log(`  Created: ${added.join(', ')}`);
  }
  console.log('Table indexes verified in MongoDB. No documents or existing indexes were dropped.');
} finally {
  await mongoose.disconnect();
}
