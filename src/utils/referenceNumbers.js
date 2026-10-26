import DailySequence from '../models/DailySequence.js';
export async function nextReference(type, date = new Date(), session = null) {
  const part = new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Manila',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(date);
  const o=Object.fromEntries(part.map(x=>[x.type,x.value]));
  const day=`${o.year}${o.month}${o.day}`;
  const row=await DailySequence.findOneAndUpdate({type,day},{$inc:{value:1}},{upsert:true,new:true,setDefaultsOnInsert:true,...(session?{session}:{})});
  return `TRANS-${day}-${String(row.value).padStart(4,'0')}`;
}
