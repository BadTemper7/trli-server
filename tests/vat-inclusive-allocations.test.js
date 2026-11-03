import test from 'node:test';
import assert from 'node:assert/strict';
import {
  allowedRatesForCollection, pickApplicableRates, priceLines,
  resolveRateAmount, stageCharge, totalsForLines,
} from '../src/utils/billingMath.js';

const basic={status:'ACTIVE',classification:'LOCAL',loadStatus:'EMPTY',containerSize:'40FT',containerCategory:'STANDARD',taxTreatment:'TAXABLE',billingMode:'AUTOMATIC'};
const rate=(id,name,amount,collectionPoint,other={})=>({...basic,_id:id,name,amount,collectionPoint,...other});
const booking={transactionClassification:'LOCAL',containerType:'DRY CONTAINER',loadStatus:'EMPTY',containerSize:'40FT',scheduledGateTimeIn:'10:00',gateIn:{actualGateInAt:'2026-11-01T00:00:00Z'},gateOut:{scheduledDate:'2026-11-02',scheduledTime:'10:00'}};
const settings={overtime:{active:false},tax:{vatRate:12,vatInclusive:false}};

test('1120 VAT-inclusive taxable charge remains 1120, broken down into 1000 sales + 120 VAT',()=>{
 const q=priceLines([rate('a','Gate-in Handling',1120,'GATE_IN')],booking,'GATE_IN',settings);
 assert.equal(q.subtotal,1120); assert.equal(q.vatableSales,1000);assert.equal(q.vat,120);assert.equal(q.total,1120);
 assert.equal(q.vatInclusive,true);
});

test('mixed 1120 taxable + 350 non-VATable remains 1470 without double charging VAT',()=>{
 const q=priceLines([rate('a','Gate-in Handling',1120,'GATE_IN'),rate('b','Shifting Fee',350,'GATE_IN',{taxTreatment:'EXEMPT'})],booking,'GATE_IN',settings);
 assert.equal(q.vatableSales,1000);assert.equal(q.nonVatableSales,350);assert.equal(q.vat,120);assert.equal(q.total,1470);
});

test('VAT percentage comes from settings and does not change agreed inclusive price',()=>{
 const q=priceLines([rate('a','Gate-in Handling',1050,'GATE_IN')],booking,'GATE_IN',{...settings,tax:{vatRate:5,vatInclusive:false}});
 assert.equal(q.vatableSales,1000);assert.equal(q.vat,50);assert.equal(q.total,1050);
});

test('collect at BOTH splits full 2000 charge evenly, including 214.28 VAT total',()=>{
 const rates=[rate('a','Gate-in Handling',2000,'BOTH',{gateInAllocation:50,gateOutAllocation:50,allocationMode:'PERCENTAGE'})];
 const gateIn=priceLines(rates,booking,'GATE_IN',settings);
 const previousInvoice={lines:gateIn.lines};
 const gateOut=priceLines(rates,booking,'GATE_OUT',settings,new Date(),[],{previousInvoice});
 assert.equal(gateIn.total,1000);assert.equal(gateIn.vat,107.14);
 assert.equal(gateOut.total,1000);assert.equal(gateOut.vat,107.14);
 assert.equal(gateIn.total+gateOut.total,2000);
 assert.equal(gateIn.vat+gateOut.vat,214.28);
});

test('fixed allocations split 2000 to 600 Gate-in and 1400 Gate-out, no duplication',()=>{
 const rates=[rate('a','Lift On',2000,'BOTH',{allocationMode:'FIXED',gateInAllocation:600,gateOutAllocation:1400})];
 const first=priceLines(rates,booking,'GATE_IN',settings);
 const second=priceLines(rates,booking,'GATE_OUT',settings,new Date(),[],{previousInvoice:{lines:first.lines}});
 assert.equal(first.total,600);assert.equal(second.total,1400);
 assert.equal(first.total+second.total,2000);
});

test('odd-cent stage rounding collects the exact remaining centavo at Gate-out',()=>{
 const rates=[rate('a','Gate-in Handling',100.01,'BOTH',{gateInAllocation:50,gateOutAllocation:50})];
 const gateIn=priceLines(rates,booking,'GATE_IN',settings);
 const gateOut=priceLines(rates,booking,'GATE_OUT',settings,new Date(),[],{previousInvoice:{lines:gateIn.lines}});
 assert.equal(gateIn.total,50.01);assert.equal(gateOut.total,50);assert.equal(Math.round((gateIn.total+gateOut.total)*100),10001);
});

test('manual amount is required from authorized server-side booking storage, not client quotation',()=>{
 const row=rate('manual','Documentation Fee',0,'GATE_IN',{pricingMode:'MANUAL',billingMode:'OPTIONAL'});
 assert.throws(()=>resolveRateAmount(row,{}),/Manual price is required/);
 assert.equal(resolveRateAmount(row,{manual:1120}),1120);
 assert.throws(()=>resolveRateAmount(row,{manual:-2}),/Invalid manual price/);
 assert.throws(()=>resolveRateAmount(row,{manual:11.111}),/Invalid manual price/);
});

test('gate-in and gate-out collection select their respective rates without duplicating BOTH',()=>{
 const rows=[rate('a','Gate-in Handling',100,'GATE_IN'),rate('b','Gate-out Handling',150,'GATE_OUT'),rate('c','Storage',200,'BOTH')];
 assert.deepEqual(pickApplicableRates(allowedRatesForCollection(rows,'GATE_IN'),booking,'GATE_IN').map(r=>r._id),['a','c']);
 assert.deepEqual(pickApplicableRates(allowedRatesForCollection(rows,'GATE_OUT'),booking,'GATE_OUT').map(r=>r._id),['b','c']);
});

test('historical VAT-exclusive records can still be interpreted without rewriting stored totals',()=>{
 const historical=totalsForLines([{amount:1000,taxTreatment:'TAXABLE'}],12,false);
 assert.equal(historical.total,1120);assert.equal(historical.vat,120);
});
