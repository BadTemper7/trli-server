import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {renderGatePassPdf,renderServiceInvoicePdf} from '../src/services/printableDocuments.js';
import {paymentReviewFailure} from '../src/utils/financialReviewErrors.js';
import {AppError} from '../src/utils/http.js';

const booking={
  _id:'abc',bookingReference:'TRANS-BKG-20261103-0001',containerNumber:'TRLU1234567',containerSize:'40FT',
  containerType:'DRY CONTAINER',loadStatus:'LOADED',truckPlateNumber:'ABC1234',driverName:'Sample Driver',
  shippingLine:'Sample Shipping Line',gateIn:{actualGateInAt:new Date('2026-11-03T13:00:00Z'),
    inspection:{sealNumber:'SL001',sealIntact:true,containerCondition:['GOOD']}},
  gateOut:{requestedAt:new Date('2026-11-03'),approvalStatus:'PENDING_APPROVAL'},
};
const invoice={number:'TRANS-INV-20261103-0001',type:'GATE_IN',status:'UNPAID',
  lines:[{description:'Documentation Fee',quantity:1,unitRate:200,amount:200,taxTreatment:'EXEMPT'},
    {description:'Shifting Fee',quantity:1,unitRate:100,amount:100,taxTreatment:'TAXABLE'}],
  subtotal:300,vat:12,total:312,paidAmount:0,balance:312,vatRate:12,vatInclusive:false,
};
const text=pdf=>pdf.toString('latin1');
test('Gate-in Pass PDF uses stored booking details and form fields',()=>{
  const pdf=renderGatePassPdf({booking,type:'GATE_IN'});
  assert.equal(pdf.subarray(0,8).toString(),'%PDF-1.4');
  for(const label of ['GATE-IN PASS','TRUCK / DRIVER INFORMATION','CONTAINER INFORMATION',
    'CONDITION UPON ENTRY','TRLU1234567','Sample Driver','SL001'])assert.ok(text(pdf).includes(label),label);
});
test('Gate-out pass stays explicitly DRAFT until final gate-out approval',()=>{
  const draft=renderGatePassPdf({booking,type:'GATE_OUT'});
  assert.ok(text(draft).includes('DRAFT - NOT VALID FOR RELEASE'));
  const approved=renderGatePassPdf({booking:{...booking,gateOut:{...booking.gateOut,approvalStatus:'APPROVED'}},type:'GATE_OUT'});
  assert.ok(text(approved).includes('APPROVED FOR RELEASE'));
  assert.ok(!text(approved).includes('Document Status: RELEASED'));
});
test('Service Invoice uses independent invoice reference and tax rows',()=>{
  const pdf=renderServiceInvoicePdf({invoice,booking,companyName:'Sample Company'});
  for(const label of ['SERVICE','INVOICE','TRANS-INV-20261103-0001','TRANS-BKG-20261103-0001',
    'Documentation Fee','Shifting Fee','VATable Sales','VAT-Exempt Sales','312.00'])assert.ok(text(pdf).includes(label),label);
});
test('Large invoices paginate and retain totals on the final page',()=>{
  const many={...invoice,lines:Array.from({length:26},(_,i)=>({description:`Service ${i+1}`,quantity:1,unitRate:10,amount:10,taxTreatment:'TAXABLE'}))};
  const pdf=renderServiceInvoicePdf({invoice:many,booking});
  assert.ok(text(pdf).includes('/Count 3'));
  assert.ok(text(pdf).includes('Service 26'));
});
test('Known duplicate Mongo reference maps to HTTP 409 not 500',()=>{
  assert.equal(paymentReviewFailure({code:11000,message:'duplicate'}).status,409);
});
test('Unsupported Mongo transaction topology maps to HTTP 503',()=>{
  assert.equal(paymentReviewFailure(new Error('Transaction numbers are only allowed on a replica set member or mongos')).status,503);
});
test('Domain errors remain unchanged',()=>{
  const original=new AppError('Already verified',409);
  assert.equal(paymentReviewFailure(original),original);
});
test('Gate-in payment approval commits audit with invoice in same transaction',()=>{
  const source=readFileSync(new URL('../src/controllers/invoiceController.js',import.meta.url),'utf8');
  assert.match(source,/await auditAdminAction\(\{[\s\S]*?session\}\)/);
  assert.match(source,/\[GATE_IN_PAYMENT_NOTIFICATION_RETRY_NEEDED\]/);
});
test('All document downloads require module permission',()=>{
  const routes=readFileSync(new URL('../src/routes/operationsRoutes.js',import.meta.url),'utf8');
  for(const name of ['downloadGateInPass','downloadGateOutPass','downloadReleasePass','downloadOperationalInvoice'])assert.ok(routes.includes(name));
  assert.match(routes,/gate-in\/:id\/pass'.*MODULES\.GATE_IN/);
  assert.match(routes,/release\/:id\/pass'.*MODULES\.RELEASE_CONTAINER/);
});
