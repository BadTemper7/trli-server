// All reporting windows use the terminal's fixed Asia/Manila UTC+08:00 zone.
// They are [start, end), avoiding double-counted boundary timestamps.
import {AppError} from './http.js';
export const manilaDay = (value = new Date()) => new Intl.DateTimeFormat('en-CA', {timeZone:'Asia/Manila', year:'numeric',month:'2-digit',day:'2-digit'}).format(value);
const DAY=86400000;
export function localMidnight(day){
  if(!/^\d{4}-\d{2}-\d{2}$/.test(String(day))) throw new AppError('Invalid report date.',400);
  const d=new Date(`${day}T00:00:00+08:00`);
  if(!Number.isFinite(d.getTime())||manilaDay(d)!==day)throw new AppError('Invalid report date.',400);
  return d;
}
export const plusDays=(date,amount)=>new Date(date.getTime()+amount*DAY);
export function reportRange(query={},fallback='daily'){
  const mode=String(query.period||query.range||fallback).toLowerCase();
  const current=manilaDay(new Date());
  const [year,month,day]=current.split('-').map(Number);
  let start,end;
  switch(mode){
    case 'daily':start=localMidnight(current);end=plusDays(start,1);break;
    case 'weekly':{
      const now=localMidnight(current);const weekday=(new Date(`${current}T12:00:00Z`).getUTCDay()+6)%7;
      start=plusDays(now,-weekday);end=plusDays(start,7);break;
    }
    case 'monthly':start=localMidnight(`${year}-${String(month).padStart(2,'0')}-01`);end=localMidnight(`${month===12?year+1:year}-${String(month===12?1:month+1).padStart(2,'0')}-01`);break;
    case 'yearly':start=localMidnight(`${year}-01-01`);end=localMidnight(`${year+1}-01-01`);break;
    case 'custom':{
      start=localMidnight(query.from);end=plusDays(localMidnight(query.to),1);
      if(end<=start)throw new AppError('Report end date must be on or after the start date.',400);
      if((end-start)/DAY>366*6)throw new AppError('Choose a report range shorter than six years.',400);
      break;
    }
    default:throw new AppError('Select Daily, Weekly, Monthly, Yearly, or Custom range.',400);
  }
  const inclusiveEnd=plusDays(end,-1);
  return {mode,from:start,to:end,fromDay:manilaDay(start),toDay:manilaDay(inclusiveEnd),label:`${manilaDay(start)} to ${manilaDay(inclusiveEnd)}`};
}
