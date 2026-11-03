import 'dotenv/config';
import mongoose from 'mongoose';
import {connectDB} from '../src/config/db.js';
import HistoricalContainer from '../src/models/HistoricalContainer.js';
import PreAdvice from '../src/models/PreAdvice.js';
mongoose.set('autoIndex',false);
await connectDB();
try{
  const [live,history,indexes]=await Promise.all([
    PreAdvice.countDocuments({}),HistoricalContainer.countDocuments({}),
    mongoose.connection.collection('historicalcontainers').indexes().catch(err=>err.code===26?[]:Promise.reject(err)),
  ]);
  const existing=await HistoricalContainer.aggregate([{$match:{deletedAt:null,status:{$in:['GATED_IN','STORED','GATE_OUT_APPROVED']}}},{$group:{_id:'$containerNumber',count:{$sum:1}}},{$match:{count:{$gt:1}}}]);
  console.log(JSON.stringify({mode:process.argv.includes('--apply')?'APPLY':'DRY_RUN',liveRecords:live,historyRecords:history,activeDuplicates:existing,indexes:indexes.map(i=>i.name)},null,2));
  if(existing.length){console.error('Conflicting historical active containers must be reconciled before creating the unique index.');process.exitCode=1;}
  else if(process.argv.includes('--apply')){
    await HistoricalContainer.createIndexes();
    console.log('Historical tracking indexes created/validated. No historical or live record was rewritten.');
  }else console.log('After backup, run npm run migrate:container-tracking -- --apply to create/verify historical indexes.');
}finally{await mongoose.disconnect();}
