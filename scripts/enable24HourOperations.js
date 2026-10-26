/**
 * Update only site operating hours to 24 hours, seven days/week.
 * Dry run: npm run migrate:24h
 * Apply:   npm run migrate:24h -- --apply
 * Does not overwrite confirmed bookings, reservations, rates, or payment data.
 */
import 'dotenv/config';
import mongoose from 'mongoose';
import SiteSettings from '../src/models/SiteSettings.js';

if (!process.env.MONGODB_URI) throw new Error('MONGODB_URI is required.');
const apply=process.argv.includes('--apply');
await mongoose.connect(process.env.MONGODB_URI);
try {
  const existing=await SiteSettings.findOne({key:'COMPANY_CONTACT'}).lean();
  const capacity=existing?.schedule?.maxBookingsPerHour ?? 4;
  const active=existing?.schedule?.active ?? true;
  console.log(JSON.stringify({mode:apply?'APPLY':'DRY_RUN',previousSchedule:existing?.schedule||null,plannedSchedule:{openingTime:'00:00',closingTime:'24:00',operatingDays:[0,1,2,3,4,5,6],maxBookingsPerHour:capacity,active},message:'Existing confirmed bookings are not modified.'},null,2));
  if(apply) {
    await SiteSettings.updateOne({key:'COMPANY_CONTACT'},{$set:{operatingHours:'24 hours daily',schedule:{openingTime:'00:00',closingTime:'24:00',operatingDays:[0,1,2,3,4,5,6],maxBookingsPerHour:capacity,active}},$setOnInsert:{key:'COMPANY_CONTACT'}},{upsert:true});
    console.log('24-hour operations enabled.');
  }
}finally{await mongoose.disconnect();}
