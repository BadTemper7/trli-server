import test from 'node:test';
import assert from 'node:assert/strict';
import {DEFAULT_OPERATING_SCHEDULE, is24HourSchedule,validateOperatingSchedule,validateOperationalHour} from '../src/utils/operatingSchedule.js';
import { ONLINE_METHODS, isConfiguredReceivingAccount, receivingAccountSnapshot } from '../src/utils/paymentMethodRules.js';

test('Default terminal schedule covers 24 hourly slots and all seven days',()=>{
 assert.equal(is24HourSchedule(DEFAULT_OPERATING_SCHEDULE),true);
 assert.equal(validateOperatingSchedule(DEFAULT_OPERATING_SCHEDULE),null);
 assert.equal(DEFAULT_OPERATING_SCHEDULE.operatingDays.length,7);
 for(const h of Array.from({length:24},(_,i)=>`${String(i).padStart(2,'0')}:00`)){
  assert.equal(validateOperationalHour('2026-10-27',h,DEFAULT_OPERATING_SCHEDULE),null,`Hour ${h}`);
 }
 assert.match(validateOperationalHour('2026-10-27','24:00',DEFAULT_OPERATING_SCHEDULE),/outside operational/);
 assert.equal(validateOperationalHour('2026-10-25','00:00',DEFAULT_OPERATING_SCHEDULE),null); // Sunday
});
test('Closing 24:00 is valid; 24:00 opening and closed schedules are invalid',()=>{
 assert.equal(validateOperatingSchedule({...DEFAULT_OPERATING_SCHEDULE,openingTime:'24:00'})!==null,true);
 assert.equal(validateOperatingSchedule({...DEFAULT_OPERATING_SCHEDULE,closingTime:'00:00'})!==null,true);
 assert.equal(validateOperationalHour('2026-10-26','10:00',{...DEFAULT_OPERATING_SCHEDULE,active:false}), 'Bookings are disabled.');
});
test('A schedule with restricted days/hours still enforces its window',()=>{
 const schedule={...DEFAULT_OPERATING_SCHEDULE,openingTime:'08:00',closingTime:'17:00',operatingDays:[1,2,3,4,5]};
 assert.equal(validateOperationalHour('2026-10-26','09:00',schedule),null);
 assert.match(validateOperationalHour('2026-10-26','18:00',schedule),/outside operational/);
 assert.match(validateOperationalHour('2026-10-25','09:00',schedule),/outside operating/);
 assert.match(validateOperationalHour('2026-02-30','09:00',schedule),/outside operating/);
});
test('Slot capacity remains configurable with default of four',()=>{
 assert.equal(DEFAULT_OPERATING_SCHEDULE.maxBookingsPerHour,4);
 assert.match(validateOperatingSchedule({...DEFAULT_OPERATING_SCHEDULE,maxBookingsPerHour:0}),/Maximum bookings/);
 assert.equal(validateOperatingSchedule({...DEFAULT_OPERATING_SCHEDULE,maxBookingsPerHour:6}),null);
});
test('Only active configured online accounts are selectable',()=>{
 assert.deepEqual(ONLINE_METHODS,['BANK','GCASH','MAYA','E_WALLET']);
 const base={code:'GCASH',status:'ACTIVE',bankName:'GCash',accountName:'Real Company',accountNumber:'09170000000',name:'GCash'};
 assert.equal(isConfiguredReceivingAccount(base),true);
 assert.equal(isConfiguredReceivingAccount({...base,accountName:''}),false);
 assert.equal(isConfiguredReceivingAccount({...base,accountNumber:' '}),false);
 assert.equal(isConfiguredReceivingAccount({...base,status:'INACTIVE'}),false);
 assert.equal(isConfiguredReceivingAccount({...base,code:'CASH'}),false);
 assert.deepEqual(receivingAccountSnapshot(base),{bankName:'GCash',accountName:'Real Company',accountNumber:'09170000000',paymentTypeName:'GCash'});
});
