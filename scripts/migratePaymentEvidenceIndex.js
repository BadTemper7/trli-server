import 'dotenv/config';
import mongoose from 'mongoose';
import {connectDB} from '../src/config/db.js';
// Requires backup + maintenance window. New submissions allow blank references only with an uploaded file.
mongoose.set('autoIndex',false);
await connectDB();
try {
  const collection=mongoose.connection.collection('paymentsubmissions');
  const indexes=await collection.indexes().catch(error=>error.code===26?[]:Promise.reject(error));
  const match=indexes.find(i=>i.key?.method===1&&i.key?.reference===1);
  const proposed={status:{$in:['VERIFIED','PENDING_VERIFICATION']},reference:{$type:'string',$gt:''}};
  const same=match && JSON.stringify(match.partialFilterExpression)===JSON.stringify(proposed);
  if(same){console.log('Payment evidence index is already current.');process.exitCode=0;}
  else if(!process.argv.includes('--apply')){console.log('DRY RUN: payment reference index would be updated to exclude empty references. Existing index:',JSON.stringify(match||null));console.log('Back up database and apply during scheduled maintenance using --apply.');}
  else{
    // Keep the original name. Drop/recreate cannot be transactionally atomic; halt payments during maintenance.
    if(match)await collection.dropIndex(match.name);
    await collection.createIndex({method:1,reference:1},{unique:true,name:'method_1_reference_1',partialFilterExpression:proposed});
    console.log('Payment reference index updated; blank-reference evidence now allowed without duplicate-key collisions.');
  }
} finally {await mongoose.disconnect();}
