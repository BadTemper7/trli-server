/**
 * Idempotent rate/settings metadata migration. Does NOT update invoices, receipts,
 * payment submissions, historical bookings or current financial snapshots.
 * Usage: node scripts/migrateFlexibleRates.js [--apply]
 */
import 'dotenv/config';
import mongoose from 'mongoose';
import Rate from '../src/models/Rate.js';
import SiteSettings from '../src/models/SiteSettings.js';

const applying=process.argv.includes('--apply');
const optional=new Set(['Documentation Fee','Other','Congestion Surcharge']);
if(!process.env.MONGODB_URI){console.error('MONGODB_URI is required.');process.exitCode=1;}
else{
  try{
    await mongoose.connect(process.env.MONGODB_URI);
    const [rates,settings]=await Promise.all([Rate.collection.find({}).toArray(),SiteSettings.collection.find({}).toArray()]);
    const changes=[];
    for(const rate of rates){
      const updates={};
      if(!rate.pricingMode)updates.pricingMode='FIXED';
      if(!rate.billingMode)updates.billingMode=optional.has(rate.name)?'OPTIONAL':'AUTOMATIC';
      if(!rate.allocationMode)updates.allocationMode='PERCENTAGE';
      if(rate.gateInAllocation==null)updates.gateInAllocation=50;
      if(rate.gateOutAllocation==null)updates.gateOutAllocation=50;
      // Legacy Overtime BOTH represented two independent charges. New invoices
      // use a single split rate; paid historical invoices are not recalculated.
      if(Object.keys(updates).length)changes.push({collection:'rates',id:rate._id,updates});
    }
    for(const item of settings){if(item.tax?.vatInclusive!==false)changes.push({collection:'sitesettings',id:item._id,updates:{'tax.vatInclusive':false}});}
    console.log(JSON.stringify({mode:applying?'apply':'dry-run',ratesExamined:rates.length,settingsExamined:settings.length,changesPlanned:changes.length,changes:changes.slice(0,20).map(x=>({collection:x.collection,id:String(x.id),updates:x.updates}))},null,2));
    if(applying){
      for(const change of changes){await mongoose.connection.db.collection(change.collection).updateOne({_id:change.id},{$set:change.updates});}
      console.log(`Applied ${changes.length} metadata migrations. Existing invoices and receipts untouched.`);
    }else console.log('Run again with --apply only after backing up MongoDB.');
  }catch(error){console.error(error);process.exitCode=1;}
  finally{await mongoose.disconnect();}
}
