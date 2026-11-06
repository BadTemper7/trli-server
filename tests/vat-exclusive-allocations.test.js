import test from 'node:test';
import assert from 'node:assert/strict';
import {
  allowedRatesForCollection, pickApplicableRates, priceLines,
  resolveRateAmount, totalsForLines,
} from '../src/utils/billingMath.js';

const basic={status:'ACTIVE',classification:'LOCAL',loadStatus:'EMPTY',containerSize:'40FT',containerCategory:'STANDARD',taxTreatment:'TAXABLE',billingMode:'AUTOMATIC'};
const rate=(id,name,amount,collectionPoint,other={})=>({...basic,_id:id,name,amount,collectionPoint,...other});
const booking={transactionClassification:'LOCAL',containerType:'DRY CONTAINER',loadStatus:'EMPTY',containerSize:'40FT',scheduledGateTimeIn:'10:00',gateIn:{actualGateInAt:'2026-11-01T00:00:00Z'},gateOut:{scheduledDate:'2026-11-02',scheduledTime:'10:00'}};
const settings={overtime:{active:false},tax:{vatRate:12,vatInclusive:true}}; // Legacy setting must NOT force VAT inclusion.

test('PHP 3,800 configured rate + 12% VAT PHP 456 = PHP 4,256 payable',()=>{
 const q=priceLines([rate('a','Gate-in Handling',3800,'GATE_IN')],booking,'GATE_IN',settings);
 assert.equal(q.subtotal,3800);
 assert.equal(q.taxableSubtotal,3800);
 assert.equal(q.vatableSales,3800);
 assert.equal(q.nonVatableSales,0);
 assert.equal(q.vat,456);
 assert.equal(q.total,4256);
 assert.equal(q.vatInclusive,false);
});

test('mixed PHP 3,800 VATable + PHP 350 exempt adds VAT only to taxable amount',()=>{
 const q=priceLines([
   rate('a','Gate-in Handling',3800,'GATE_IN'),
   rate('b','Shifting Fee',350,'GATE_IN',{taxTreatment:'EXEMPT'}),
 ],booking,'GATE_IN',settings);
 assert.equal(q.subtotal,4150);
 assert.equal(q.vatableSales,3800);
 assert.equal(q.nonVatableSales,350);
 assert.equal(q.vat,456);
 assert.equal(q.total,4606);
});

test('VAT percentage is read from site settings instead of hardcoded',()=>{
 const q=priceLines([rate('a','Gate-in Handling',1050,'GATE_IN')],booking,'GATE_IN',
   {...settings,tax:{vatRate:5,vatInclusive:true}});
 assert.equal(q.vatableSales,1050);
 assert.equal(q.vat,52.5);
 assert.equal(q.total,1102.5);
});

test('collect at BOTH applies VAT to the allocated base at each stage exactly once',()=>{
 const rates=[rate('a','Gate-in Handling',3800,'BOTH',{gateInAllocation:50,gateOutAllocation:50,allocationMode:'PERCENTAGE'})];
 const gateIn=priceLines(rates,booking,'GATE_IN',settings);
 const gateOut=priceLines(rates,booking,'GATE_OUT',settings,new Date(),[],{previousInvoice:{lines:gateIn.lines}});
 assert.equal(gateIn.subtotal,1900);assert.equal(gateIn.vat,228);assert.equal(gateIn.total,2128);
 assert.equal(gateOut.subtotal,1900);assert.equal(gateOut.vat,228);assert.equal(gateOut.total,2128);
 assert.equal(gateIn.total+gateOut.total,4256);
 assert.equal(gateIn.vat+gateOut.vat,456);
});

test('fixed BOTH allocations of PHP 1,000 and PHP 2,800 add VAT without doubling the rate',()=>{
 const rates=[rate('a','Lift On',3800,'BOTH',{allocationMode:'FIXED',gateInAllocation:1000,gateOutAllocation:2800})];
 const gateIn=priceLines(rates,booking,'GATE_IN',settings);
 const gateOut=priceLines(rates,booking,'GATE_OUT',settings,new Date(),[],{previousInvoice:{lines:gateIn.lines}});
 assert.equal(gateIn.total,1120);assert.equal(gateIn.vat,120);
 assert.equal(gateOut.total,3136);assert.equal(gateOut.vat,336);
 assert.equal(gateIn.total+gateOut.total,4256);
});

test('odd-cent stage rounding collects the remainder without double charging base or VAT',()=>{
 const rates=[rate('a','Gate-in Handling',100.01,'BOTH',{gateInAllocation:50,gateOutAllocation:50})];
 const first=priceLines(rates,booking,'GATE_IN',settings);
 const second=priceLines(rates,booking,'GATE_OUT',settings,new Date(),[],{previousInvoice:{lines:first.lines}});
 assert.equal(first.subtotal,50.01);assert.equal(second.subtotal,50);
 assert.equal(first.vat,6);assert.equal(second.vat,6);
 assert.equal(Number((first.total+second.total).toFixed(2)),112.01);
});

test('manual rate amount is a VAT-exclusive base rate and must come from authorized storage',()=>{
 const row=rate('cccccccccccccccccccccccc','Documentation Fee',0,'GATE_IN',{pricingMode:'MANUAL',billingMode:'OPTIONAL'});
 assert.throws(()=>resolveRateAmount(row,{}),/Manual price is required/);
 assert.equal(resolveRateAmount(row,{'cccccccccccccccccccccccc':3800}),3800);
 assert.throws(()=>resolveRateAmount(row,{'cccccccccccccccccccccccc':-2}),/Invalid manual price/);
 assert.throws(()=>resolveRateAmount(row,{'cccccccccccccccccccccccc':11.111}),/Invalid manual price/);
 const quote=priceLines([row],booking,'GATE_IN',settings,new Date(),['cccccccccccccccccccccccc'],{manualAmounts:{'cccccccccccccccccccccccc':3800}});
 assert.equal(quote.total,4256);
});

test('gate-in and gate-out collection select rates without billing an unrelated stage',()=>{
 const rows=[rate('a','Gate-in Handling',100,'GATE_IN'),rate('b','Gate-out Handling',150,'GATE_OUT'),rate('c','Storage',200,'BOTH')];
 assert.deepEqual(pickApplicableRates(allowedRatesForCollection(rows,'GATE_IN'),booking,'GATE_IN').map(r=>r._id),['a','c']);
 assert.deepEqual(pickApplicableRates(allowedRatesForCollection(rows,'GATE_OUT'),booking,'GATE_OUT').map(r=>r._id),['b','c']);
});

test('zero-rated and VAT-exempt rates never add tax',()=>{
 const quote=totalsForLines([{amount:200,taxTreatment:'ZERO_RATED'},{amount:500,taxTreatment:'EXEMPT'}],12);
 assert.equal(quote.subtotal,700);assert.equal(quote.vat,0);assert.equal(quote.total,700);
});

test('previously issued VAT-inclusive invoices can retain their original breakdown when explicitly requested',()=>{
 const existing=totalsForLines([{amount:1120,taxTreatment:'TAXABLE'}],12,true);
 assert.equal(existing.vatInclusive,true);
 assert.equal(existing.total,1120);
 assert.equal(existing.vatableSales,1000);
 assert.equal(existing.vat,120);
 const legacyCorrection=priceLines([rate('a','Gate-in Handling',1120,'GATE_IN')],booking,'GATE_IN',settings,
   new Date(),[],{existingInvoiceVatInclusive:true});
 assert.equal(legacyCorrection.total,1120);
 assert.equal(legacyCorrection.vatInclusive,true);
});
