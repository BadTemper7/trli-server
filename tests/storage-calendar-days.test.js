import test from 'node:test';
import assert from 'node:assert/strict';
import {storageDaysBetween,manilaScheduledInstant} from '../src/utils/storageDuration.js';
import {billableStorageDays,priceLines} from '../src/utils/billingMath.js';
import {terminalDuration} from '../src/utils/forwarding.js';

const inAt = '2026-10-27T14:00:00.000Z'; // Oct 27, 22:00 in Manila
const outAt = '2026-10-27T17:00:00.000Z'; // Oct 28, 01:00 in Manila

test('Oct 27 22:00 -> Oct 28 01:00 counts two calendar days despite three elapsed hours', () => {
  assert.equal(storageDaysBetween(inAt,outAt),2);
  assert.equal(billableStorageDays(inAt,'2026-10-28','01:00'),2);
  assert.deepEqual(terminalDuration(inAt,outAt),{elapsedHours:3,elapsedDays:0.13,billableDays:2});
});
test('same calendar date counts one storage day even for a few minutes', () => {
  assert.equal(storageDaysBetween(inAt,'2026-10-27T15:59:00Z'),1);
  assert.equal(billableStorageDays(inAt,'2026-10-27','23:00'),1);
});
test('midnight in Manila adds another day at exactly 00:00', () => {
  assert.equal(storageDaysBetween(inAt,'2026-10-27T15:59:59Z'),1);
  assert.equal(storageDaysBetween(inAt,'2026-10-27T16:00:00Z'),2);
  assert.equal(billableStorageDays(inAt,'2026-10-28','00:00'),2);
});
test('UTC date changes alone do not create extra Manila calendar days', () => {
  // Oct 28 02:00 and Oct 28 11:00 Manila are different UTC dates but same local date.
  assert.equal(storageDaysBetween('2026-10-27T18:00:00Z','2026-10-28T03:00:00Z'),1);
});
test('multiple calendar boundaries, year change, and leap dates are inclusive', () => {
  assert.equal(storageDaysBetween('2026-12-31T14:00:00Z','2027-01-02T02:00:00Z'),3);
  assert.equal(storageDaysBetween('2024-02-28T15:00:00Z','2024-02-29T18:00:00Z'),3);
});
test('a quote uses selected scheduled Gate-out calendar day, not current time', () => {
  assert.equal(billableStorageDays(inAt,'2026-10-28','01:00',new Date('2030-01-01T00:00:00Z')),2);
  assert.equal(billableStorageDays(inAt,null,null,new Date('2026-10-27T17:00:00Z')),2);
});
test('legacy 24-hour utility remains available for historical data compatibility', () => {
  assert.equal(storageDaysBetween(inAt,outAt,'CEIL_24_HOURS'),1);
  assert.equal(billableStorageDays(inAt,'2026-10-28','01:00',new Date(),'CEIL_24_HOURS'),1);
});
test('invalid or reversed dates are rejected instead of showing negative billable days', () => {
  assert.throws(()=>storageDaysBetween(outAt,inAt),/follow physical gate-in/);
  assert.throws(()=>storageDaysBetween('INVALID',outAt),/Invalid/);
  assert.throws(()=>manilaScheduledInstant('2026-02-30','01:00'),/Invalid/);
  assert.throws(()=>manilaScheduledInstant('2026-10-27','25:00'),/valid date and time/);
});
test('Gate-out storage invoice uses two days and correctly calculates 12% VAT',()=>{
  const rates=[{_id:'3',status:'ACTIVE',name:'Storage',collectionPoint:'GATE_OUT',classification:'LOCAL',containerCategory:'STANDARD',loadStatus:'EMPTY',containerSize:'20FT',amount:800,taxTreatment:'TAXABLE'}];
  const booking={containerType:'DRY CONTAINER',containerSize:'20FT',loadStatus:'EMPTY',transactionClassification:'LOCAL',gateIn:{actualGateInAt:inAt},gateOut:{scheduledDate:'2026-10-28',scheduledTime:'01:00'}};
  const invoice=priceLines(rates,booking,'GATE_OUT',{storageBilling:{rounding:'CALENDAR_DAYS'},tax:{vatRate:12,vatInclusive:false},overtime:{active:false}});
  assert.equal(invoice.lines.find(l=>l.description==='Storage').quantity,2);
  assert.equal(invoice.subtotal,1600);
  assert.equal(invoice.vat,192);
  assert.equal(invoice.total,1792);
});
