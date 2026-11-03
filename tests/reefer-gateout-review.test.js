import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {availableBookingLoadStatuses} from '../src/utils/bookingRateOptions.js';

const read = file => readFileSync(new URL(file,import.meta.url),'utf8');
const booking={containerType:'REEFER',transactionClassification:'INTERNATIONAL',containerSize:'40FT'};
const rate=(loadStatus,other={})=>({status:'ACTIVE',name:'Gate-in Handling',collectionPoint:'GATE_IN',
  containerCategory:'REEFER',classification:'INTERNATIONAL',containerSize:'40FT',loadStatus,...other});

test('Reefer booking selects only active, effective loaded statuses for its exact category/size/classification',()=>{
 const rates=[rate('LOADED'),rate('EMPTY',{status:'INACTIVE'}),rate('EMPTY',{classification:'LOCAL'}),
  rate('EMPTY',{containerSize:'20FT'}),rate('EMPTY',{containerCategory:'STANDARD'}),
  rate('EMPTY',{effectiveFrom:'2099-01-01'})];
 assert.deepEqual(availableBookingLoadStatuses(rates,booking,new Date('2026-11-04')),['LOADED']);
});
test('both Reefer statuses display when both real price configurations exist',()=>{
 assert.deepEqual(availableBookingLoadStatuses([rate('EMPTY'),rate('LOADED')],booking),['EMPTY','LOADED']);
});
test('overtime and Standard-only rates do not make a Reefer load status bookable',()=>{
 assert.deepEqual(availableBookingLoadStatuses([
  rate('ALL',{name:'Overtime',containerCategory:'ALL',classification:'ALL',containerSize:'ALL'}),
  rate('LOADED',{containerCategory:'STANDARD'}),
  rate('EMPTY',{name:'Total Handling Reference'}),
 ],booking),[]);
});
test('Gate-out payment approval imports unique receipt allocation and keeps financial/audit changes in one transaction',()=>{
 const source=read('../src/controllers/clientGateOutController.js');
 assert.match(source,/import \{uniqueReceiptNumber\} from '\.\.\/utils\/uniqueReceipt\.js'/);
 assert.match(source,/payment\.receiptNumber=await uniqueReceiptNumber\(session\)/);
 assert.match(source,/await auditAdminAction\(\{[\s\S]*?session\}\)/);
 assert.match(source,/if\(alreadyReviewed\)return res\.json/);
 assert.match(source,/\[GATE_OUT_RECEIPT_SEQUENCE_RETRY\]/);
 assert.match(source,/\[GATE_OUT_NOTIFICATION_RETRY_NEEDED\]/);
});
test('live Reefer options and booking submissions both apply available rates',()=>{
 assert.match(read('../src/routes/publicRateRoutes.js'),/router\.get\('\/load-statuses'/);
 assert.match(read('../src/controllers/preAdviceController.js'),/await requireAvailableReeferLoadStatus\(data\)/);
 assert.match(read('../src/controllers/preAdviceController.js'),/await requireAvailableReeferLoadStatus\(updates, item\)/);
 assert.match(read('../../client/src/pages/portal/PreAdviceForm.jsx'),/api\.get\('\/rates\/load-statuses'/);
});
test('Reefer Loaded configuration is accepted by Rate Setup and invoice matching when a rate exists',()=>{
 for(const source of [read('../src/models/Rate.js'),read('../src/controllers/rateController.js'),
  read('../src/utils/billingMath.js'),read('../../admin/src/components/rates/RateFormModal.jsx')]){
  assert.doesNotMatch(source,/Loaded reefer (?:pricing|rate|rates) (?:is|are) (?:not supported|unsupported)/i);
 }
});
