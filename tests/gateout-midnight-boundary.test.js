import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {requireGateOutAfterGateIn,storageDaysBetween} from '../src/utils/storageDuration.js';
import {billableStorageDays,priceLines} from '../src/utils/billingMath.js';

// Oct 27 2026 20:57 Manila == Oct 27 2026 12:57 UTC.
const arrival='2026-10-27T12:57:00.000Z';
const rate={_id:'000000000000000000000001',name:'Storage',amount:800,status:'ACTIVE',classification:'LOCAL',containerCategory:'STANDARD',containerSize:'20FT',loadStatus:'EMPTY',collectionPoint:'GATE_OUT',taxTreatment:'TAXABLE'};
const booking={containerType:'DRY CONTAINER',containerSize:'20FT',loadStatus:'EMPTY',transactionClassification:'LOCAL',gateIn:{actualGateInAt:arrival},gateOut:{scheduledDate:'2026-10-28',scheduledTime:'00:00'}};

test('20:57 Oct 27 to 00:00 Oct 28 (three hours three minutes) is two inclusive Manila dates',()=>{
 const departure=requireGateOutAfterGateIn(arrival,'2026-10-28','00:00');
 assert.equal(departure.toISOString(),'2026-10-27T16:00:00.000Z');
 assert.equal(storageDaysBetween(arrival,departure),2);
 assert.equal(billableStorageDays(arrival,'2026-10-28','00:00'),2);
});
test('Oct 27 00:00 is before an Oct 27 20:57 entry and rejected with next date guidance',()=>{
 assert.throws(()=>requireGateOutAfterGateIn(arrival,'2026-10-27','00:00'), /2026-10-28 00:00/);
 assert.throws(()=>billableStorageDays(arrival,'2026-10-27','00:00'), /later than actual Gate-in/);
});
test('new Gate-out quotes use inclusive calendar dates even when stored legacy settings still say 24-hour rounding',()=>{
 const q=priceLines([rate],booking,'GATE_OUT',{storageBilling:{rounding:'CEIL_24_HOURS'},tax:{vatRate:12,vatInclusive:false},overtime:{active:false}});
 assert.equal(q.lines.find(line=>line.description==='Storage').quantity,2);
 assert.equal(q.subtotal,1600);
 assert.equal(q.vat,192);
 assert.equal(q.total,1792);
});
test('same date after entry is one day',()=>{
 assert.equal(billableStorageDays(arrival,'2026-10-27','22:00'),1);
});
test('gate-out quote and request both validate physical entry before creating invoice or payment',()=>{
 const controller=readFileSync(new URL('../src/controllers/clientGateOutController.js',import.meta.url),'utf8');
 assert.match(controller,/validateGateOutAfterArrival\(b,day,hour\);/);
 assert.match(controller,/validateGateOutAfterArrival\(booking,day,hour\);/);
});
test('physical release freezes inclusive calendar-day duration',()=>{
 const ctl=readFileSync(new URL('../src/controllers/operationsController.js',import.meta.url),'utf8');
 assert.match(ctl,/finalDaysInTerminal=storageDaysBetween\(item\.gateIn\.actualGateInAt,now,'CALENDAR_DAYS'\)/);
});
test('client gate-out selector explains midnight date rollover and disables pre-arrival time slots',()=>{
 const modal=readFileSync(new URL('../../client/src/components/booking/GateOutRequest.jsx',import.meta.url),'utf8');
 assert.match(modal,/Midnight is the/);
 assert.match(modal,/!isAfterArrival\(date,slot\.hour\)/);
 assert.match(modal,/scheduledStorageDays/);
});
