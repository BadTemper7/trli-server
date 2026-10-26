import BookingSlot from '../models/BookingSlot.js';
import { createHash } from 'node:crypto';
import mongoose from 'mongoose';
import SiteSettings from '../models/SiteSettings.js';
import { AppError } from './http.js';
import {validateHourlySchedule} from './scheduleValidation.js';
import {DEFAULT_OPERATING_SCHEDULE,validateOperationalHour} from './operatingSchedule.js';

export async function getSchedule(){
 const settings=await SiteSettings.findOne({key:'COMPANY_CONTACT'}).lean();
 return {...DEFAULT_OPERATING_SCHEDULE,...(settings?.schedule||{})};
}
function validateDayHour(day,hour,s){
 const error=validateHourlySchedule(day,hour);if(error)throw new AppError(error,400);
 const scheduleError=validateOperationalHour(day,hour,s);if(scheduleError)throw new AppError(scheduleError,s.active?400:409);
 return s;
}
export async function validateSlot(day,hour){return validateDayHour(day,hour,await getSchedule());}
// Distinct capacity reservations for arrival and departure of the same container.
// Legacy gate-in reservations continue using the booking ObjectId unchanged.
export function reservationId(id, type = 'GATE_IN') {
  if (type === 'GATE_IN') return id;
  if (type !== 'GATE_OUT') throw new AppError('Unsupported reservation type.', 400);
  return new mongoose.Types.ObjectId(createHash('sha256').update(`GATE_OUT:${id}`).digest().subarray(0, 12));
}
export async function reserveSlot(id,day,hour,session=null,type='GATE_IN'){
 const key = reservationId(id,type);
 const s=await validateSlot(day,hour);
 const options=session?{session}:{};
 // Two simultaneous inserts of the same slot may cause a duplicate-key conflict.
 // Retry outside a transaction; MongoDB's transaction callback handles transient write conflicts.
 try{await BookingSlot.updateOne({day,hour},{$setOnInsert:{day,hour}},{upsert:true,...options});}
 catch(error){if(error.code!==11000||session)throw error;}
 const row=await BookingSlot.findOneAndUpdate({day,hour,bookings:{$ne:key},$expr:{$lt:[{$size:'$bookings'},s.maxBookingsPerHour]}},{$addToSet:{bookings:key}},{new:true,...options});
 if(!row)throw new AppError('Slot is full or already reserved by this booking.',409);
 return row;
}
export async function releaseSlot(id,day,hour,session=null,type='GATE_IN'){if(day&&hour)await BookingSlot.updateOne({day,hour},{$pull:{bookings:reservationId(id,type)}},session?{session}:{});}
export async function slotAvailability(day){
 const settings=await getSchedule();
 if(!/^\d{4}-\d{2}-\d{2}$/.test(String(day||'')))throw new AppError('Invalid day.',400);
 const rows=await BookingSlot.find({day}).lean();
 const byHour=Object.fromEntries(rows.map(r=>[r.hour,r.bookings.length]));
 const slots=[];
 for(let n=0;n<24;n++){
  const hour=`${String(n).padStart(2,'0')}:00`;
  try{validateDayHour(day,hour,settings);slots.push({hour,remaining:Math.max(0,settings.maxBookingsPerHour-(byHour[hour]||0))});}catch{ /* don't render invalid hours */ }
 }
 return slots;
}
