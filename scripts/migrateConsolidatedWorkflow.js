/**
 * Non-destructive preparation for consolidated terminal workflow.
 * Usage: npm run migrate:workflow            (dry run)
 *        npm run migrate:workflow -- --apply  (apply safe defaults only)
 * Always back up MongoDB and resolve reported conflicts before deploying.
 */
import 'dotenv/config';
import mongoose from 'mongoose';
import PreAdvice from '../src/models/PreAdvice.js';
import Rate from '../src/models/Rate.js';
import PaymentType from '../src/models/PaymentType.js';
import SiteSettings from '../src/models/SiteSettings.js';
import BookingSlot from '../src/models/BookingSlot.js';

const apply = process.argv.includes('--apply');
const warnings = [];
const output = (name, result) => console.log(JSON.stringify({check:name,...result}));
function addConflict(name, key, docs) { if (docs.length > 1) warnings.push({name,key,ids:docs.map(v=>String(v._id))}); }

if (!process.env.MONGODB_URI) throw new Error('MONGODB_URI is required');
await mongoose.connect(process.env.MONGODB_URI);
try {
  console.log(`Mode: ${apply ? 'APPLY' : 'DRY RUN'} - existing bookings, invoices and paid amounts will not be rewritten.`);
  const oldSettings = await SiteSettings.findOne({key:'COMPANY_CONTACT'}).lean();
  if(!oldSettings) output('settings',{action:'create default company settings record when applied'});
  if (apply) await SiteSettings.updateOne({key:'COMPANY_CONTACT'}, {
    $setOnInsert:{key:'COMPANY_CONTACT',schedule:{openingTime:'00:00',closingTime:'24:00',operatingDays:[0,1,2,3,4,5,6],maxBookingsPerHour:4,active:true},shiftingFee:0,tax:{vatRate:12,vatInclusive:false},overtime:{start:'18:00',end:'08:00',fee:0,active:true},storageBilling:{rounding:'CALENDAR_DAYS'}},
  },{upsert:true});

  const unclassified = await Rate.countDocuments({containerCategory:{$exists:false}});
  const untaxed = await Rate.countDocuments({taxTreatment:{$exists:false}});
  output('rate defaults',{unclassified,untaxed});
  if(apply){
    await Rate.updateMany({containerCategory:{$exists:false}},{$set:{containerCategory:'STANDARD'}});
    await Rate.updateMany({taxTreatment:{$exists:false}},{$set:{taxTreatment:'TAXABLE'}});
  }
  const reeferLoaded = await Rate.find({containerCategory:'REEFER',loadStatus:'LOADED'}).select('_id name').lean();
  if(reeferLoaded.length)warnings.push({name:'unsupported loaded reefer rates',ids:reeferLoaded.map(r=>String(r._id))});

  const rateConflicts = await Rate.aggregate([
    {$match:{status:'ACTIVE'}},
    {$group:{_id:{name:'$name',classification:'$classification',loadStatus:'$loadStatus',containerCategory:{$ifNull:['$containerCategory','STANDARD']},containerSize:'$containerSize',collectionPoint:'$collectionPoint'},ids:{$push:'$_id'},count:{$sum:1}}},
    {$match:{count:{$gt:1}}},
  ]);
  rateConflicts.forEach(v=>warnings.push({name:'duplicate active rate',key:v._id,ids:v.ids.map(String)}));

  const duplicateRefs = await PreAdvice.aggregate([
    {$match:{bookingReference:{$type:'string'}}},{$group:{_id:'$bookingReference',count:{$sum:1},ids:{$push:'$_id'}}},{$match:{count:{$gt:1}}},{$limit:100},
  ]);
  duplicateRefs.forEach(v=>warnings.push({name:'duplicate historical booking reference',key:v._id,ids:v.ids.map(String)}));

  const cash = await PaymentType.findOne({code:'CASH',status:'ACTIVE'}).select('_id').lean();
  if(cash)output('cash payment type',{action:'disable legacy CASH option',id:String(cash._id)});
  if(apply&&cash)await PaymentType.updateOne({_id:cash._id},{$set:{status:'INACTIVE'}});

  const activeBookingRows=await PreAdvice.find({workflowStage:{$in:['BOOKING_SUBMITTED','READY_FOR_GATE_IN','GATE_IN_PAYMENT_SUBMITTED']}})
    .select('_id scheduledGateDateIn scheduledGateTimeIn').lean();
  const slotGroup=new Map();
  for(const booking of activeBookingRows){
    const key=`${booking.scheduledGateDateIn}|${booking.scheduledGateTimeIn}`;
    const values=slotGroup.get(key)||[];values.push(booking._id);slotGroup.set(key,values);
  }
  const capacity=Number((await SiteSettings.findOne({key:'COMPANY_CONTACT'}).lean())?.schedule?.maxBookingsPerHour||4);
  for(const [key, ids] of slotGroup){
    if(ids.length>capacity)warnings.push({name:'existing over-capacity reservations',key,count:ids.length,limit:capacity});
    const [day,hour]=key.split('|');
    if(apply)for(const id of ids){
      await BookingSlot.updateOne({day,hour},{$addToSet:{bookings:id},$setOnInsert:{day,hour}},{upsert:true});
    }
  }
  output('booking reservations',{existingActive:activeBookingRows.length,slots:slotGroup.size,capacity});
  output('preflight findings',{warnings});
  if(apply&&warnings.length)console.warn('Manual reconciliation is required before creating new unique indexes. Existing records were not deleted or overwritten.');
  if(apply&&!warnings.length){
    for(const Model of [BookingSlot,Rate,PreAdvice,PaymentType,SiteSettings]){
      await Model.createIndexes();
      output('index confirmation',{model:Model.modelName,result:'created/verified'});
    }
  }
}finally{await mongoose.disconnect();}
