/**
 * Non-destructive fee metadata and OT-hours migration.
 * DRY RUN: npm run migrate:billing-fees
 * APPLY:   npm run migrate:billing-fees -- --apply
 * Back up MongoDB first. This never recalculates existing invoices or payments.
 */
import 'dotenv/config';
import mongoose from 'mongoose';
import Rate from '../src/models/Rate.js';
import SiteSettings from '../src/models/SiteSettings.js';
import {AUTOMATIC_RATE_NAMES} from '../src/utils/billingMath.js';

if(!process.env.MONGODB_URI)throw new Error('MONGODB_URI required');
const apply=process.argv.includes('--apply');
await mongoose.connect(process.env.MONGODB_URI);
try{
 const existing=await SiteSettings.findOne({key:'COMPANY_CONTACT'}).lean();
 console.log(JSON.stringify({mode:apply?'APPLY':'DRY_RUN',feePolicy:{automatic:AUTOMATIC_RATE_NAMES,optional:['Documentation Fee','Congestion Surcharge','Other']},overtime:{start:'18:00',end:'08:00',active:true,fee:'retain configured rate/fee'},settingsCurrently:existing?.overtime??null}));
 if(apply){
  await SiteSettings.updateOne({key:'COMPANY_CONTACT'},{$set:{'overtime.start':'18:00','overtime.end':'08:00','overtime.active':true},$setOnInsert:{key:'COMPANY_CONTACT'}},{upsert:true});
 }
 for(const name of ['Documentation Fee','Congestion Surcharge','Other']){
  const filter={name,billingMode:{$exists:false}};
  const count=await Rate.countDocuments(filter);
  console.log(JSON.stringify({rate:name,legacyWithoutBillingMode:count,action:'mark as OPTIONAL; historical invoices remain unchanged'}));
  if(apply&&count)await Rate.updateMany(filter,{$set:{billingMode:'OPTIONAL'}});
 }
 for(const name of AUTOMATIC_RATE_NAMES){
  const filter={name,billingMode:{$ne:'AUTOMATIC'}};
  const count=await Rate.countDocuments(filter);
  console.log(JSON.stringify({rate:name,needsAutomaticMode:count}));
  if(apply&&count)await Rate.updateMany(filter,{$set:{billingMode:'AUTOMATIC'}});
 }
 if(apply)console.log('Billing metadata updated. Configure any missing Gate-in Documentation/Shifting and Gate-in/Gate-out Overtime rates in Admin Rate Setup. No paid invoice was modified.');
}finally{await mongoose.disconnect();}
