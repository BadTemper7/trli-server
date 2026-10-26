import 'dotenv/config';
import mongoose from 'mongoose';
import {connectDB} from '../src/config/db.js';
import ForwardingContainer from '../src/models/ForwardingContainer.js';

// Run in a maintenance window after backing up MongoDB. The model uses its own
// collection; no regular inventory or invoice collection is modified.
mongoose.set('autoIndex',false);
await connectDB();
try {
  const duplicateActive=await ForwardingContainer.aggregate([
    {$match:{status:'IN_TERMINAL'}},
    {$group:{_id:'$containerNumber',count:{$sum:1}}},
    {$match:{count:{$gt:1}}},
    {$limit:10},
  ]);
  if(duplicateActive.length)throw new Error(`Resolve active forwarding duplicates before creating index: ${JSON.stringify(duplicateActive)}`);
  const name='unique_active_forwarding_container';
  const indexes=await ForwardingContainer.collection.indexes().catch(error=>error.code===26?[]:Promise.reject(error));
  if(indexes.some(index=>index.name===name)) {
    console.log('Forwarding active-container unique index already exists.');
  } else if(!process.argv.includes('--apply')) {
    console.log(`DRY RUN: create ${name} unique index on the separate forwardingcontainers collection.`);
    console.log('Run npm run migrate:forwarding-indexes -- --apply to create the index.');
  } else {
    await ForwardingContainer.collection.createIndex({containerNumber:1},{unique:true,partialFilterExpression:{status:'IN_TERMINAL'},name});
    console.log('Created forwarding uniqueness index. Regular container billing records were untouched.');
  }
} finally { await mongoose.disconnect(); }
