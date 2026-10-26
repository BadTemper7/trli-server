import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const read = p => readFileSync(new URL(p,import.meta.url),'utf8');

test('Gate-in optional-charge endpoints require authorized admin Gate-in processing permission',()=>{
 const src=read('../src/routes/invoiceRoutes.js');
 assert.match(src,/adminInvoices\.get\('\/:id\/optional-charges',requirePermission\(MODULES\.GATE_IN,ACTIONS\.PROCESS\),getInvoiceOptionalCharges\)/);
 assert.match(src,/adminInvoices\.put\('\/:id\/optional-charges',requirePermission\(MODULES\.GATE_IN,ACTIONS\.PROCESS\),updateInvoiceOptionalCharges\)/);
});
test('Fee adjustments are rejected once an invoice has been submitted for payment',()=>{
 const src=read('../src/services/invoicingService.js');
 assert.match(src,/invoice\.status!=='UNPAID'/);
 assert.match(src,/invoice\.lines\|\|\[\]/);
 assert.match(src,/filter\(line=>!line\.isOptional\)/);
});
test('Gate-out client quote and payment submit carry validated optional IDs to the same server quote',()=>{
 const server=read('../src/controllers/clientGateOutController.js');
 const ui=read('../../client/src/components/booking/GateOutRequest.jsx');
 assert.match(server,/parseOptionalRateIds\(req\.query\.optionalRateIds\)/);
 assert.match(server,/parseOptionalRateIds\(req\.body\.optionalRateIds\)/);
 assert.match(ui,/optionalRateIds:selectedOptional\.join/);
 assert.match(ui,/form\.append\('optionalRateIds',JSON\.stringify\(selectedOptional\)\)/);
});
test('Rate Setup supports Gate-in Documentation and Shifting and settings default OT begins at 18:00',()=>{
 const rateForm=read('../../admin/src/components/rates/RateFormModal.jsx');
 const settings=read('../src/models/SiteSettings.js');
 const rateController=read('../src/controllers/rateController.js');
 for(const fee of ['Documentation Fee','Shifting Fee','Overtime']) assert.ok(rateForm.includes(`'${fee}'`));
 assert.match(rateController,/Documentation Fee','Shifting Fee','Gate-in Handling/);
 assert.match(settings,/default:'18:00'/);
});
