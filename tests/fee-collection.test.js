import test from 'node:test';
import assert from 'node:assert/strict';
import {priceLines, overtimeApplies, parseOptionalRateIds, getOptionalRateChoices, totalsForLines} from '../src/utils/billingMath.js';

const id=(char)=>char.repeat(24);
const base={status:'ACTIVE',classification:'LOCAL',loadStatus:'EMPTY',containerSize:'40FT',containerCategory:'STANDARD',taxTreatment:'TAXABLE'};
const rate=(char,name,amount,collectionPoint,mode='AUTOMATIC',extra={})=>({...base,...extra,_id:id(char),name,amount,collectionPoint,billingMode:mode});
const booking={transactionClassification:'LOCAL',containerType:'DRY CONTAINER',loadStatus:'EMPTY',containerSize:'40FT',scheduledGateTimeIn:'18:00',gateIn:{actualGateInAt:'2026-10-26T06:00:00.000Z'},gateOut:{scheduledDate:'2026-10-28',scheduledTime:'07:00'}};
const settings={shiftingFee:120,overtime:{start:'18:00',end:'08:00',active:true,fee:300},tax:{vatRate:12,vatInclusive:false}};
const rates=[
 rate('a','Gate-in Handling',800,'GATE_IN'),
 rate('b','Shifting Fee',250,'GATE_IN'),
 rate('c','Documentation Fee',150,'GATE_IN','OPTIONAL'),
 rate('d','Lift On',50,'GATE_IN'),
 rate('e','Overtime',400,'GATE_IN'),
 rate('f','Gate-out Handling',500,'GATE_OUT'),
 rate('1','Storage',100,'GATE_OUT'),
 rate('2','Lift Off',70,'GATE_OUT'),
 rate('3','Overtime',350,'GATE_OUT'),
 rate('4','Other',85,'GATE_OUT','OPTIONAL',{description:'Container sweeping'}),
];
test('Documentation Fee is optional and not silently added to Gate-in',()=>{
 const q=priceLines(rates.filter(r=>r.collectionPoint==='GATE_IN'),booking,'GATE_IN',settings);
 assert.equal(q.lines.filter(r=>r.description==='Documentation Fee').length,0);
 assert.equal(q.lines.filter(r=>r.description==='Shifting Fee').length,1);
 assert.equal(q.lines.find(r=>r.description==='Shifting Fee').amount,250); // rate overrides legacy Settings 120
 assert.equal(q.lines.find(r=>r.description==='Overtime').amount,400); // Rate overrides Settings 300
 assert.equal(q.subtotal,1500); // handling 800 + lift on 50 + shifting 250 + OT 400
 assert.equal(q.vat,180);
 assert.equal(q.total,1680);
});
test('Manual optional Documentation Fee changes total and VAT exactly once',()=>{
 const q=priceLines(rates.filter(r=>r.collectionPoint==='GATE_IN'),booking,'GATE_IN',settings,new Date(),[id('c')]);
 assert.equal(q.lines.filter(r=>r.description==='Documentation Fee').length,1);
 assert.equal(q.lines.find(r=>r.description==='Documentation Fee').amount,150);
 assert.equal(q.subtotal,1650);assert.equal(q.vat,198);assert.equal(q.total,1848);
 assert.equal(q.lines.find(r=>r.description==='Documentation Fee').isOptional,true);
});
test('Gate-out includes fixed Storage and Lift Off; not Gate-in shifting or documentation',()=>{
 const q=priceLines(rates.filter(r=>r.collectionPoint==='GATE_OUT'),booking,'GATE_OUT',settings);
 assert.equal(q.lines.some(r=>r.description==='Shifting Fee'),false);
 assert.equal(q.lines.some(r=>r.description==='Documentation Fee'),false);
 assert.equal(q.lines.find(r=>r.description==='Storage').quantity,2);
 assert.equal(q.lines.find(r=>r.description==='Overtime').amount,350);
 assert.equal(q.subtotal,1120); // 500+200+70+350
});
test('A legacy documentation rate accidentally configured at Gate-out is never billable there',()=>{
 const mistaken=rate('7','Documentation Fee',199,'GATE_OUT','OPTIONAL');
 const available=[...rates.filter(r=>r.collectionPoint==='GATE_OUT'),mistaken];
 assert.equal(getOptionalRateChoices(available,booking,'GATE_OUT').some(c=>c.name==='Documentation Fee'),false);
 assert.throws(()=>priceLines(available,booking,'GATE_OUT',settings,new Date(),[id('7')]),/not active or does not apply/);
});
test('Other service may be selected manually at Gate-out with its server rate',()=>{
 const gateRates=rates.filter(r=>r.collectionPoint==='GATE_OUT');
 assert.equal(getOptionalRateChoices(gateRates,booking).length,1);
 const q=priceLines(gateRates,booking,'GATE_OUT',settings,new Date(),[id('4')]);
 assert.equal(q.lines.find(r=>r.description==='Container sweeping').amount,85);
 assert.equal(q.total,1349.60); // (1120+85)*1.12
});
test('Optional fee selection rejects inapplicable, cross-point, or repeated IDs',()=>{
 assert.throws(()=>priceLines(rates.filter(r=>r.collectionPoint==='GATE_OUT'),booking,'GATE_OUT',settings,new Date(),[id('c')]),/not active or does not apply/);
 assert.throws(()=>parseOptionalRateIds([id('4'),id('4')]),/repeated/);
 assert.throws(()=>parseOptionalRateIds(['manipulated-price']),/Invalid/);
});
test('Overtime window is Manila 18:00 inclusive to next 08:00 exclusive',()=>{
 for(const hour of ['18:00','19:00','23:00','00:00','06:00','07:59']) assert.equal(overtimeApplies(hour,settings.overtime),true,hour);
 for(const hour of ['08:00','09:00','17:59']) assert.equal(overtimeApplies(hour,settings.overtime),false,hour);
});
test('Overtime on/off and fallback fee work for both collections',()=>{
 const onlyHandling=rates.filter(r=>r.name!=='Overtime'&&r.collectionPoint==='GATE_IN');
 const q=priceLines(onlyHandling,booking,'GATE_IN',settings);
 assert.equal(q.lines.find(r=>r.description==='Overtime').amount,300);
 const disabled=priceLines(onlyHandling,booking,'GATE_IN',{...settings,overtime:{...settings.overtime,active:false}});
 assert.equal(disabled.lines.some(r=>r.description==='Overtime'),false);
 const day=priceLines(onlyHandling,{...booking,scheduledGateTimeIn:'08:00'},'GATE_IN',settings);
 assert.equal(day.lines.some(r=>r.description==='Overtime'),false);
});
test('Invoice VAT can preserve inclusive/exempt treatment with optional services',()=>{
 const lines=[{amount:112,taxTreatment:'TAXABLE'},{amount:50,taxTreatment:'EXEMPT'},{amount:0,taxTreatment:'ZERO_RATED'}];
 const q=totalsForLines(lines,12,true);
 assert.equal(q.subtotal,162);assert.equal(q.vat,12);assert.equal(q.total,162);
});
