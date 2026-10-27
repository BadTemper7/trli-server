import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const read = p=>readFileSync(new URL(p,import.meta.url),'utf8');

test('client bookings and gate-out routes are mounted',()=>{
 const app=read('../src/app.js'), bookings=read('../src/routes/clientRoutes.js'), out=read('../src/routes/clientGateOutRoutes.js');
 assert.match(app,/app\.use\('\/api\/client',clientRoutes\)/);
 assert.match(bookings,/r\.get\('\/bookings',bookingList\)/);
 assert.match(bookings,/r\.post\('\/bookings',requireVerified/);
 assert.match(app,/app\.use\('\/api\/gate-out',clientGateOut\)/);
 assert.match(out,/clientGateOut\.post\('\/:id\/request',paymentProofUpload\.single\('proof'\),requestClientGateOut\)/);
});
test('admin combined gate-out, release and invoices routes are mounted',()=>{
 const app=read('../src/app.js'), out=read('../src/routes/clientGateOutRoutes.js'), ops=read('../src/routes/operationsRoutes.js');
 assert.match(app,/app\.use\('\/api\/admin\/gate-out-review',adminGateOutReview\)/);
 assert.match(app,/app\.use\('\/api\/admin\/invoices',adminInvoices\)/);
 assert.match(out,/adminGateOutReview\.post\('\/:id\/review',requirePermission/);
 assert.match(ops,/router\.post\('\/release\/:id',\s*validateId\(\),\s*requirePermission/);
 assert.doesNotMatch(ops,/router\.post\('\/gate-out\/:id\/approve'/);
});
test('financial PDFs and private payment proofs are route-protected',()=>{
 const client=read('../src/routes/invoiceRoutes.js');
 assert.match(client,/clientInvoices\.use\(auth\)/);
 assert.match(client,/clientInvoices\.get\('\/:id\/pdf',downloadFinancialPdf\)/);
 assert.match(client,/clientInvoices\.get\('\/:id\/receipt',downloadFinancialPdf\)/);
 assert.match(client,/clientInvoices\.get\('\/payments\/:id\/proof',proofFile\)/);
 assert.match(client,/adminInvoices\.use\(adminAuth,requirePasswordChanged\)/);
});
test('physical gate-in verifies payment and accepts inspection atomically with entry',()=>{
 const ctl=read('../src/controllers/operationsController.js');
 const fn=ctl.split('export const processGateIn =')[1].split('export const listInventory =')[0];
 assert.match(fn,/session\.withTransaction/);
 assert.match(fn,/type:'GATE_IN',status:'PAID',balance:0/);
 assert.match(fn,/payment\?\.status!=='VERIFIED'/);
 assert.match(fn,/parseGateInInspection/);
 assert.match(fn,/item\.gateIn\.inspection=inspection/);
 assert.match(fn,/item\.gateIn\.actualGateInAt=now/);
 assert.match(fn,/if\(item\.gateIn\.actualGateInAt\)/);
 assert.match(fn,/await item\.save\(\{session\}\)/);
});
test('combined gate-out verifies payment before final approval in one transaction',()=>{
 const ctl=read('../src/controllers/clientGateOutController.js');
 assert.match(ctl,/session\.withTransaction\(async\(\)=>\{/);
 assert.match(ctl,/payment\.status='VERIFIED'/);
 assert.match(ctl,/invoice\.status='PAID'/);
 assert.match(ctl,/booking\.gateOut\.approvalStatus='APPROVED'/);
 assert.match(ctl,/await reserveSlot\(fresh\._id,day,hour,session,'GATE_OUT'\)/);
});
test('site settings defaults to 4 and rejects uncontrolled hourly bookings',()=>{
 const model=read('../src/models/SiteSettings.js'), slots=read('../src/utils/bookingSlots.js');
 assert.match(model,/maxBookingsPerHour:\{type:Number,default:4/);
 assert.match(slots,/\$expr:\{\$lt:\[\{\$size:'\$bookings'\},s\.maxBookingsPerHour\]\}/);
});
test('backend prevents payment status changes by clients and rejects cash',()=>{
 const api=read('../src/routes/invoiceRoutes.js'), service=read('../src/controllers/invoiceController.js');
 assert.match(api,/adminInvoices\.post\('\/payments\/:id\/review',requirePermission/);
 assert.match(service,/await getReceivingMethod\(method\)/);
 assert.match(read('../src/services/paymentMethods.js'),/!ONLINE_METHODS\.includes\(code\)/);
});
