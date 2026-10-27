import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { allowedRatesForCollection, pickApplicableRates, priceLines, gateOutTransactionPreview, overtimeApplies } from '../src/utils/billingMath.js';

const id = char => String(char).repeat(24);
const common = { status:'ACTIVE', name:'Overtime', amount:275, classification:'ALL', loadStatus:'ALL', containerCategory:'ALL', containerSize:'ALL', collectionPoint:'BOTH', taxTreatment:'TAXABLE' };
const row = (char, props = {}) => ({ ...common, _id:id(char), ...props });
const baseBooking = {transactionClassification:'LOCAL',containerType:'DRY CONTAINER',loadStatus:'EMPTY',containerSize:'20FT',scheduledGateTimeIn:'18:00',gateIn:{actualGateInAt:'2026-10-27T12:00:00Z'},gateOut:{scheduledDate:'2026-10-28',scheduledTime:'07:59'}};
const settings = {overtime:{start:'18:00',end:'08:00',fee:160,active:true},tax:{vatRate:12,vatInclusive:false}};
const amount = (quote, name='Overtime') => quote.lines.filter(line=>line.description===name);

// Universal Overtime is collected on both transaction types for every supported tariff combination.
test('universal BOTH overtime applies once for local and international, standard empty/loaded, reefer empty, 20FT and 40FT',()=>{
 const configurations=[];
 for(const classification of ['LOCAL','INTERNATIONAL']) for(const size of ['20FT','40FT']) for(const loadStatus of ['EMPTY','LOADED']) configurations.push({transactionClassification:classification,containerSize:size,containerType:'DRY CONTAINER',loadStatus});
 for(const classification of ['LOCAL','INTERNATIONAL']) for(const size of ['20FT','40FT']) configurations.push({transactionClassification:classification,containerSize:size,containerType:'REEFER',loadStatus:'EMPTY'});
 for(const config of configurations){
  const booking={...baseBooking,...config};
  for(const gate of ['GATE_IN','GATE_OUT']) {
    const result=priceLines([row('a')],booking,gate,settings);
    assert.equal(amount(result).length,1,`${gate} ${JSON.stringify(config)}`);
    assert.equal(amount(result)[0].amount,275);
    assert.equal(result.vat,33);
  }
 }
 assert.equal(configurations.length,12);
});

test('one more specific override for International Reefer Empty overrides universal BOTH for both points',()=>{
 const rates=[row('a'),row('b',{classification:'INTERNATIONAL',containerCategory:'REEFER',loadStatus:'EMPTY',amount:480})];
 const reefer={...baseBooking,transactionClassification:'INTERNATIONAL',containerType:'REEFER',loadStatus:'EMPTY'};
 for(const type of ['GATE_IN','GATE_OUT']){
  const quote=priceLines(rates,reefer,type,settings);
  assert.equal(amount(quote).length,1);
  assert.equal(amount(quote)[0].amount,480);
 }
 assert.equal(amount(priceLines(rates,{...reefer,containerType:'DRY CONTAINER'},'GATE_IN',settings))[0].amount,275);
});

test('equal-dimension gate-specific override beats BOTH; more specific BOTH still beats broad gate override',()=>{
 const rates=[row('a'),row('b',{collectionPoint:'GATE_OUT',amount:320})];
 assert.equal(amount(priceLines(rates,baseBooking,'GATE_IN',settings))[0].amount,275);
 assert.equal(amount(priceLines(rates,baseBooking,'GATE_OUT',settings))[0].amount,320);
 const moreSpecific=[...rates,row('c',{collectionPoint:'BOTH',containerSize:'20FT',amount:390})];
 assert.equal(amount(priceLines(moreSpecific,baseBooking,'GATE_IN',settings))[0].amount,390);
 assert.equal(amount(priceLines(moreSpecific,baseBooking,'GATE_OUT',settings))[0].amount,390);
});

test('legacy specific Gate-in only OT rate remains applicable only to Gate-in; Settings fills Gate-out',()=>{
 const legacy=row('e',{classification:'LOCAL',containerCategory:'STANDARD',loadStatus:'EMPTY',containerSize:'20FT',collectionPoint:'GATE_IN',amount:315});
 assert.equal(amount(priceLines([legacy],baseBooking,'GATE_IN',settings))[0].amount,315);
 assert.equal(amount(priceLines([legacy],baseBooking,'GATE_OUT',settings))[0].amount,160);
});

test('OT applies from 18:00 through 07:59, stops at 08:00, and is disabled globally if turned off',()=>{
 for(const time of ['18:00','23:59','00:00','07:59'])assert.equal(overtimeApplies(time,settings.overtime),true);
 for(const time of ['08:00','17:59'])assert.equal(overtimeApplies(time,settings.overtime),false);
 const inDay=priceLines([row('a')],{...baseBooking,scheduledGateTimeIn:'08:00'},'GATE_IN',settings);
 const outDay=priceLines([row('a')],{...baseBooking,gateOut:{...baseBooking.gateOut,scheduledTime:'08:00'}},'GATE_OUT',settings);
 assert.equal(amount(inDay).length,0);assert.equal(amount(outDay).length,0);
 const disabled={...settings,overtime:{...settings.overtime,active:false}};
 assert.equal(amount(priceLines([row('a')],baseBooking,'GATE_IN',disabled)).length,0);
 assert.equal(amount(priceLines([row('a')],baseBooking,'GATE_OUT',disabled)).length,0);
 assert.equal(gateOutTransactionPreview([row('a')],baseBooking,disabled).automatic.length,0);
});

test('Gate-out transaction preview shows one selected OT and fallback with no explicit tariff',()=>{
 const specific=row('b',{classification:'LOCAL',amount:390});
 const preview=gateOutTransactionPreview([row('a'),specific],baseBooking,settings);
 assert.equal(preview.automatic.length,1);
 assert.equal(preview.automatic[0].amount,390);
 assert.equal(preview.automatic[0].basis,'CONDITIONAL_OVERTIME');
 const fallback=gateOutTransactionPreview([],baseBooking,settings);
 assert.equal(fallback.automatic.length,1);
 assert.equal(fallback.automatic[0].amount,160);
 assert.equal(fallback.hasBaseCharge,false);
});

test('gate-specific universal rate does not leak into opposite gate; non-OT BOTH is excluded',()=>{
 const ghost={...row('a'),name:'Lift Off'};
 assert.equal(allowedRatesForCollection([ghost], 'GATE_IN').length,0);
 const onlyIn=row('b',{collectionPoint:'GATE_IN'});
 assert.equal(pickApplicableRates(allowedRatesForCollection([onlyIn], 'GATE_OUT'), baseBooking, 'GATE_OUT').length,0);
});

test('Rate model, rate-validation and admin UI support wildcard OT but keep other fees specific',()=>{
 const controller=readFileSync(new URL('../src/controllers/rateController.js',import.meta.url),'utf8');
 const model=readFileSync(new URL('../src/models/Rate.js',import.meta.url),'utf8');
 const form=readFileSync(new URL('../../admin/src/components/rates/RateFormModal.jsx',import.meta.url),'utf8');
 const service=readFileSync(new URL('../src/services/invoicingService.js',import.meta.url),'utf8');
 const publicApi=readFileSync(new URL('../src/routes/publicRateRoutes.js',import.meta.url),'utf8');
 for(const value of ["'ALL'","'BOTH'"])assert.ok(model.includes(value));
 assert.match(controller,/name !== 'Overtime'/);
 assert.match(model,/reserved for Overtime/);
 assert.match(form,/Gate-in &amp; Gate-out \(both\)/);
 assert.match(form,/All classifications/);
 assert.match(form,/All load statuses/);
 assert.match(service,/collectionPoint:\{\$in:\[type,'BOTH'\]\}/);
 assert.match(publicApi,/settings-overtime/);
});

test('client Rates resolves universal overtime in both sections and displays the same category override as backend',async()=>{
 const {resolveDisplayedRates}=await import('../../client/src/lib/overtimeRateSelection.js');
 const universal={...row('a'),id:'a'};
 const override={...row('b',{classification:'INTERNATIONAL',containerCategory:'REEFER',loadStatus:'EMPTY',amount:640}),id:'b'};
 const records=[universal,override];
 const q={classification:'LOCAL',category:'STANDARD',load:'LOADED',size:'40FT'};
 const generic=resolveDisplayedRates(records,q);
 assert.deepEqual(generic.map(r=>r.collectionPoint),['GATE_IN','GATE_OUT']);
 assert.ok(generic.every(r=>r.amount===275));
 const reefer=resolveDisplayedRates(records,{classification:'INTERNATIONAL',category:'REEFER',load:'EMPTY',size:'20FT'});
 assert.equal(reefer.length,2);
 assert.ok(reefer.every(r=>r.amount===640));
});
