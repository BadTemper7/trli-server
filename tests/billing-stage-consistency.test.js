import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {priceLines,gateOutTransactionPreview,totalsForLines} from '../src/utils/billingMath.js';
import {ratesForNewInvoice} from '../src/utils/billingRateSelection.js';

const base={status:'ACTIVE',classification:'LOCAL',loadStatus:'EMPTY',containerSize:'40FT',containerCategory:'STANDARD',billingMode:'AUTOMATIC',taxTreatment:'TAXABLE'};
const rate=(id,name,amount,collectionPoint,extra={})=>({...base,_id:id.repeat(24),name,amount,collectionPoint,...extra});
const booking={_id:'f'.repeat(24),transactionClassification:'LOCAL',loadStatus:'EMPTY',containerSize:'40FT',containerType:'DRY CONTAINER',scheduledGateTimeIn:'10:00',gateIn:{actualGateInAt:'2026-11-01T02:00:00Z'},gateOut:{scheduledDate:'2026-11-02',scheduledTime:'18:00'}};
const settings={tax:{vatRate:12},overtime:{start:'18:00',end:'08:00',active:true,fee:99},shiftingFee:25};
const oldBoth=rate('a','Gate-in Handling',3800,'BOTH',{gateInAllocation:50,gateOutAllocation:50});
const gateIn=priceLines([oldBoth],booking,'GATE_IN',{...settings,overtime:{...settings.overtime,fee:0},shiftingFee:0});
const previousInvoice={lines:gateIn.lines};
const current=[
  rate('a','Gate-in Handling',4800,'BOTH',{gateInAllocation:50,gateOutAllocation:50}),
  rate('b','Storage',100,'GATE_OUT'),
  rate('c','Overtime',200,'GATE_OUT'),
  rate('d','Shifting Fee',150,'GATE_OUT'),
];

test('Gate-out uses new active fees while preserving the previous Gate-in BOTH allocation',()=>{
  const selected=ratesForNewInvoice({...booking,rateSnapshots:[oldBoth]},'GATE_OUT',current,previousInvoice);
  assert.equal(selected.find(x=>x.name==='Gate-in Handling').amount,3800);
  assert.deepEqual(selected.map(x=>x.name),['Storage','Overtime','Shifting Fee','Gate-in Handling']);
  const quote=priceLines(selected,booking,'GATE_OUT',settings,new Date(),[],{previousInvoice});
  assert.deepEqual(quote.lines.map(x=>x.description).sort(),['Gate-in Handling','Overtime','Shifting Fee','Storage'].sort());
  assert.equal(quote.lines.find(x=>x.description==='Storage').quantity,2);
  assert.equal(quote.lines.find(x=>x.description==='Gate-in Handling').amount,1900);
  assert.equal(quote.lines.find(x=>x.description==='Overtime').amount,200);
  assert.equal(quote.lines.find(x=>x.description==='Shifting Fee').amount,150);
  assert.equal(quote.subtotal,2450);
  assert.equal(quote.vat,294);
  assert.equal(quote.total,2744);
  assert.equal(gateIn.total+quote.total,4872);
});

test('Gate-out preview includes a Shifting Fee explicitly configured for Gate-out',()=>{
  const selected=ratesForNewInvoice({...booking,rateSnapshots:[oldBoth]},'GATE_OUT',current,previousInvoice);
  const preview=gateOutTransactionPreview(selected,booking,settings);
  assert.equal(preview.hasStorageRate,true);
  assert.ok(preview.automatic.some(x=>x.name==='Shifting Fee'));
  assert.ok(preview.automatic.some(x=>x.name==='Overtime'&&x.basis==='CONDITIONAL_OVERTIME'));
});

test('Overtime is charged for an eligible Gate-out time only, not an ordinary hour',()=>{
  const selected=ratesForNewInvoice({...booking,rateSnapshots:[oldBoth]},'GATE_OUT',current,previousInvoice);
  const day={...booking,gateOut:{...booking.gateOut,scheduledTime:'10:00'}};
  const result=priceLines(selected,day,'GATE_OUT',settings,new Date(),[],{previousInvoice});
  assert.equal(result.lines.some(x=>x.description==='Overtime'),false);
  const disabled=priceLines(selected,booking,'GATE_OUT',{...settings,overtime:{...settings.overtime,active:false}},new Date(),[],{previousInvoice});
  assert.equal(disabled.lines.some(x=>x.description==='Overtime'),false);
});

test('an overtime rate collected at the opposite gate does not create an unintended Settings fee',()=>{
  const gateInOvertime=rate('e','Overtime',450,'GATE_IN');
  const quote=priceLines([gateInOvertime],booking,'GATE_OUT',{...settings,shiftingFee:0});
  assert.equal(quote.lines.some(x=>x.description==='Overtime'),false);
  const gateOutShifting=rate('f','Shifting Fee',120,'GATE_OUT');
  const inQuote=priceLines([gateOutShifting],booking,'GATE_IN',{...settings,shiftingFee:25});
  assert.equal(inQuote.lines.some(x=>x.description==='Shifting Fee'),false);
});

test('new Gate-in invoices still use their original rate snapshot and remain payable at the original tax basis',()=>{
  const selected=ratesForNewInvoice({...booking,rateSnapshots:[oldBoth]},'GATE_IN',current);
  assert.equal(selected.length,1);
  assert.equal(selected[0].amount,3800);
  assert.equal(gateIn.subtotal,1900);
  assert.equal(gateIn.vat,228);
  assert.equal(gateIn.total,2128);
});

test('VAT-inclusive total is subtotal plus VAT, while exempt charges do not receive VAT',()=>{
  const result=totalsForLines([{amount:3800,taxTreatment:'TAXABLE'},{amount:300,taxTreatment:'EXEMPT'}],12);
  assert.equal(result.subtotal,4100);
  assert.equal(result.vatableSales,3800);
  assert.equal(result.nonVatableSales,300);
  assert.equal(result.vat,456);
  assert.equal(result.total,4556);
  assert.equal(result.subtotalWithVat,4556);
});

test('refreshing an unpaid Gate-in invoice is a separate permission-protected admin action',()=>{
  const routes=readFileSync(new URL('../src/routes/invoiceRoutes.js',import.meta.url),'utf8');
  const controller=readFileSync(new URL('../src/controllers/optionalInvoiceController.js',import.meta.url),'utf8');
  assert.match(routes,/refresh-unpaid.*requirePermission\(MODULES.GATE_IN,ACTIONS.PROCESS\)/);
  assert.match(controller,/status:'UNPAID'/);
  assert.match(controller,/PENDING_VERIFICATION','VERIFIED'/);
  assert.match(controller,/GATE_IN_INVOICE_REPRICED/);
});
