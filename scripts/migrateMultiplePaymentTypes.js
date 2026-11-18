/**
 * Allow multiple bank/e-wallet accounts sharing a method category code.
 * Dry-run by default. Take a MongoDB backup, pause payment configuration
 * writes, then run npm run migrate:payment-types -- --apply.
 * Historical payments, receipts, and receiving-account snapshots are untouched.
 */
import 'dotenv/config';
import mongoose from 'mongoose';
import PaymentType from '../src/models/PaymentType.js';

const apply = process.argv.includes('--apply');
const uri = process.env.MONGO_URI || process.env.MONGODB_URI;
if (!uri) throw new Error('MONGO_URI or MONGODB_URI is required.');
mongoose.set('autoIndex', false);
const keyIsCode = index => JSON.stringify(index.key) === JSON.stringify({code:1});
const isLegacy = index => index.unique === true && keyIsCode(index) && !index.partialFilterExpression;
const isCashIndex = index => index.name === 'unique_cash_payment_type' && index.unique === true && keyIsCode(index)
  && index.partialFilterExpression?.code === 'CASH';
const isCategoryIndex = index => index.name === 'idx_payment_type_category_status'
  && JSON.stringify(index.key) === JSON.stringify({code:1,status:1,name:1});

try {
  await mongoose.connect(uri,{autoIndex:false,serverSelectionTimeoutMS:10000});
  const coll = PaymentType.collection;
  let indexes = await coll.listIndexes().toArray().catch(error=>{
    if (error.code===26 || error.codeName==='NamespaceNotFound')return [];
    throw error;
  });
  const unknown = indexes.filter(index=>index.unique && 'code' in (index.key || {}) && !isLegacy(index) && !isCashIndex(index));
  if (unknown.length) throw new Error(`Unrecognized unique payment category indexes: ${unknown.map(index=>index.name).join(', ')}. Review manually; nothing has been modified.`);
  const legacy = indexes.filter(isLegacy);
  const duplicates = await PaymentType.countDocuments({code:'CASH'});
  if (duplicates>1) throw new Error('More than one Cash configuration exists. Reconcile the duplicates first; no changes made.');
  console.log('[PAYMENT_TYPES] Legacy unique code indexes:',legacy.map(index=>index.name));
  console.log('[PAYMENT_TYPES] Cash configurations:',duplicates);
  console.log('[PAYMENT_TYPES] Account categories BANK, E_WALLET, GCASH and MAYA will support multiple records identified by _id.');
  if (!apply) {
    console.log('[PAYMENT_TYPES] DRY RUN ONLY. Backup MongoDB, stop payment type writes, then run: npm run migrate:payment-types -- --apply');
  } else {
    // Establish the Cash uniqueness protection *before* relaxing the old
    // global uniqueness constraint. This avoids unprotected cash duplicates.
    if (!indexes.some(isCashIndex)) await coll.createIndex({code:1},{name:'unique_cash_payment_type',unique:true,partialFilterExpression:{code:'CASH'}});
    if (!indexes.some(isCategoryIndex)) await coll.createIndex({code:1,status:1,name:1},{name:'idx_payment_type_category_status'});
    const dropped=[];
    try {
      for (const index of legacy) {
        await coll.dropIndex(index.name);
        dropped.push(index);
      }
      indexes=await coll.listIndexes().toArray();
      if(indexes.some(isLegacy)||!indexes.some(isCashIndex)||!indexes.some(isCategoryIndex))throw new Error('Post-migration index verification failed.');
      console.log('[PAYMENT_TYPES] Verified: multiple bank/e-wallet accounts allowed; Cash remains unique and configurable. Existing records untouched.');
    } catch(error) {
      // Keep configuration writes paused on failure. Attempt to restore the
      // original constraint if the change was only partially applied.
      for (const index of dropped) {
        try {await coll.createIndex(index.key,{name:index.name,unique:true});}
        catch(restore){console.error('[PAYMENT_TYPES] CRITICAL: Failed to restore legacy index:',restore.message);}
      }
      throw error;
    }
  }
} finally {await mongoose.disconnect();}
