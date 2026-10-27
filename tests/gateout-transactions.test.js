import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {gateOutTransactionPreview,priceLines} from '../src/utils/billingMath.js';
const id=n=>String(n).padStart(24,'0');
const base={status:'ACTIVE',classification:'INTERNATIONAL',loadStatus:'LOADED',containerCategory:'STANDARD',containerSize:'40FT',collectionPoint:'GATE_OUT',taxTreatment:'TAXABLE'};
const row=(n,name,amount,changes={})=>({...base,_id:id(n),name,amount,...changes});
const booking={transactionClassification:'INTERNATIONAL',loadStatus:'LOADED',containerType:'OPEN TOP',containerSize:'40FT',gateIn:{actualGateInAt:'2026-10-27T14:00:00Z'},gateOut:{scheduledDate:'2026-10-28',scheduledTime:'01:00'}};
const rates=[
  row(1,'Storage',800),
  row(2,'Gate-out Handling',300),
  row(3,'Lift On',500),
  row(4,'Other',75,{billingMode:'OPTIONAL',description:'Sweeping'}),
  row(5,'Storage',999,{collectionPoint:'GATE_IN'}),
  row(6,'Gate-out Handling',100,{classification:'LOCAL'}),
  row(7,'Overtime',250),
];
test('Gate-out transactions preview loads matching active automatic fees and optional services',()=>{
  const preview=gateOutTransactionPreview(rates,booking);
  assert.deepEqual(preview.automatic.map(r=>r.name),['Storage','Gate-out Handling','Lift On','Overtime']);
  assert.equal(preview.automatic.find(r=>r.name==='Storage').basis,'PER_CALENDAR_DAY');
  assert.equal(preview.automatic.find(r=>r.name==='Overtime').basis,'CONDITIONAL_OVERTIME');
  assert.equal(preview.hasBaseCharge,true);
  assert.equal(preview.hasStorageRate,true);
  assert.deepEqual(preview.optional.map(r=>r.name),['Sweeping']);
  assert.ok(preview.automatic.every(r=>r.amount>0));
});
test('Gate-out preview does not invent rates for unmatched International containers',()=>{
  const preview=gateOutTransactionPreview(rates,{...booking,loadStatus:'EMPTY'});
  assert.deepEqual(preview.automatic,[]);
  assert.deepEqual(preview.optional,[]);
  assert.equal(preview.hasStorageRate,false);
});
test('Quote still computes full calendar-day storage, automatic services, OT and VAT',()=>{
  const q=priceLines(rates,booking,'GATE_OUT',{tax:{vatRate:12,vatInclusive:false},storageBilling:{rounding:'CALENDAR_DAYS'},overtime:{active:true,start:'18:00',end:'08:00'}});
  assert.equal(q.lines.find(l=>l.description==='Storage').quantity,2);
  assert.equal(q.lines.find(l=>l.description==='Storage').amount,1600);
  assert.equal(q.lines.find(l=>l.description==='Overtime').amount,250);
  assert.equal(q.lines.some(l=>l.description==='Sweeping'),false);
  assert.equal(q.subtotal,2650);
  assert.equal(q.vat,318);
  assert.equal(q.total,2968);
});
test('Client Gate-out transaction route requires client auth and checks company ownership',()=>{
  const routes=readFileSync(new URL('../src/routes/clientGateOutRoutes.js',import.meta.url),'utf8');
  const ctl=readFileSync(new URL('../src/controllers/clientGateOutController.js',import.meta.url),'utf8');
  assert.match(routes,/clientGateOut\.use\(auth,requireVerified\)/);
  assert.match(routes,/get\('\/:id\/transactions',listClientGateOutTransactions\)/);
  assert.match(ctl,/findOne\(\{_id:req\.params\.id,company:req\.user\.company\._id\}\)/);
});
test('Official Gate-out quote rejects missing storage instead of silently charging optional or overtime only',()=>{
  const service=readFileSync(new URL('../src/services/invoicingService.js',import.meta.url),'utf8');
  assert.match(service,/if \(!available\.hasStorageRate\)/);
  assert.match(service,/No active Gate-out Storage transaction matches/);
});
test('Client modal displays preview before selecting schedule and detailed quote after schedule',()=>{
  const src=readFileSync(new URL('../../client/src/components/booking/GateOutRequest.jsx',import.meta.url),'utf8');
  assert.match(src,/\/gate-out\/\$\{booking\._id\}\/transactions/);
  assert.match(src,/Configured transactions \(before scheduling\)/);
  assert.match(src,/Official itemized Gate-out quotation/);
  assert.match(src,/quoteError &&/);
});
