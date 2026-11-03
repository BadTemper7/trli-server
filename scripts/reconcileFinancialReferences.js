import 'dotenv/config';
import mongoose from 'mongoose';
import PaymentSubmission from '../src/models/PaymentSubmission.js';
import DailySequence from '../src/models/DailySequence.js';
import {connectDB} from '../src/config/db.js';
// Safe by default. Never removes a uniqueness constraint or changes a receipt.
mongoose.set('autoIndex',false);
await connectDB();
try{
  const all=await PaymentSubmission.find({receiptNumber:{$exists:true,$nin:['',null]}}).select('receiptNumber invoice').lean();
  const byNumber=new Map(),maxByDay=new Map();
  for(const row of all){
    const key=row.receiptNumber;byNumber.set(key,[...(byNumber.get(key)||[]),String(row._id)]);
    const match=/^TRANS-RCT-(\d{8})-(\d+)$/.exec(key);
    if(match)maxByDay.set(match[1],Math.max(maxByDay.get(match[1])||0,Number(match[2])));
  }
  const duplicates=[...byNumber].filter(([,ids])=>ids.length>1);
  const refIndexes=await mongoose.connection.collection('paymentsubmissions').indexes();
  const data={totalReceipts:all.length,duplicateReceipts:duplicates,sequenceDays:[...maxByDay].map(([day,value])=>({day,lastIssued:value})),indexes:refIndexes.filter(i=>i.key?.receiptNumber||i.key?.reference)};
  console.log(JSON.stringify(data,null,2));
  if(duplicates.length){console.error('Duplicates require a supervised finance reconciliation. No automatic edits performed.');process.exitCode=1;}
  else if(process.argv.includes('--apply')){
    for(const [day,value]of maxByDay)await DailySequence.updateOne({type:'RECEIPT',day},{$max:{value},$setOnInsert:{type:'RECEIPT',day}},{upsert:true});
    await mongoose.connection.collection('paymentsubmissions').createIndex({receiptNumber:1},{name:'unique_issued_receipt',unique:true,partialFilterExpression:{receiptNumber:{$type:'string',$gt:''}}});
    console.log('Daily receipt sequences reconciled and unique receipt index validated.');
  }else console.log('DRY RUN: add --apply during a payment maintenance window after backing up MongoDB.');
}finally{await mongoose.disconnect();}
