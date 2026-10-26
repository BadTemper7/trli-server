import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {normalizeContainerNumber,validateForwardingInput,terminalDuration,manilaForwardingDate} from '../src/utils/forwarding.js';
import {validatePaymentEvidence,validateUploadedProof} from '../src/services/paymentProofValidation.js';
const source=(name)=>fs.readFileSync(new URL(name,import.meta.url),'utf8');
const fields=()=>({containerNumber:'abcU1234567',containerSize:'40FT',containerType:'STANDARD',loadStatus:'EMPTY',gateInDate:'2025-10-26',gateInTime:'10:30',shippingLine:'Sample Line',truckPlateNumber:'ABC-1234',driverName:'Sample Driver',driverLicense:'ABC1234',hauler:'Sample Hauler'});

test('A05 payment reference alone satisfies evidence validation',()=>assert.equal(validatePaymentEvidence('REF-1234',undefined),'REF-1234'));
test('A06 proof of payment alone satisfies evidence validation',()=>assert.equal(validatePaymentEvidence('',{filename:'proof.png'}),''));
test('A07 reference and proof together are valid',()=>assert.equal(validatePaymentEvidence('  TX-12  ',{filename:'payment.pdf'}),'TX-12'));
test('A08 neither reference nor proof is rejected',()=>assert.throws(()=>validatePaymentEvidence('',undefined),/reference OR attach proof/i));
test('Payment evidence rejects references exceeding 120 characters',()=>assert.throws(()=>validatePaymentEvidence('x'.repeat(121)),/exceed/));
test('Uploaded proof validates actual PDF signature',async()=>{
 const filename=path.join(os.tmpdir(),`forwarding-proof-${process.pid}-${Date.now()}.pdf`);
 try{fs.writeFileSync(filename,'%PDF-1.4\nexample');await validateUploadedProof({path:filename,mimetype:'application/pdf'});await validateUploadedProof(undefined);}
 finally{fs.rmSync(filename,{force:true})}
});
test('Invalid proof bytes cannot be submitted regardless of supplied filename',async()=>{
 const filename=path.join(os.tmpdir(),`forwarding-fake-${process.pid}-${Date.now()}.pdf`);
 try{fs.writeFileSync(filename,'fake');await assert.rejects(()=>validateUploadedProof({path:filename,mimetype:'application/pdf'}),/does not match/);}
 finally{fs.rmSync(filename,{force:true})}
});
test('A11 forwarding input normalizes and validates all movement details',()=>{
 const record=validateForwardingInput(fields());
 assert.equal(record.containerNumber,'ABCU1234567');assert.equal(record.containerSize,'40FT');assert.equal(record.gateInAt.toISOString(),'2025-10-26T02:30:00.000Z');
 assert.equal(record.driverLicense,'ABC1234');
});
test('Forwarding validation prevents incomplete registration',()=>assert.throws(()=>validateForwardingInput({...fields(),driverName:''}),/driverName is required/));
test('Forwarding validation prevents an invalid or future Gate-in calendar date',()=>{
 assert.throws(()=>validateForwardingInput({...fields(),gateInDate:'2025-02-31'}),/Invalid gate-in/);
 assert.throws(()=>validateForwardingInput({...fields(),gateInDate:'2099-12-01'}),/future/);
});
test('A15 forwarding duration calculates elapsed and rounded-up days',()=>{
 const start=new Date('2026-10-25T00:00:00.000Z');
 assert.deepEqual(terminalDuration(start,new Date('2026-10-26T01:00:00.000Z')),{elapsedHours:25,elapsedDays:1.04,billableDays:2});
 assert.equal(terminalDuration(start,new Date('2026-10-26T00:00:00.000Z')).billableDays,1);
});
test('Final forwarding duration rejects impossible reversed timestamps',()=>assert.throws(()=>terminalDuration(new Date('2026-10-26'),new Date('2026-10-25')),/after Gate-in/));
test('Forwarding duplicate active container has a MongoDB unique partial index (static contract)',()=>{
 const m=source('../src/models/ForwardingContainer.js');
 assert.match(m,/unique_active_forwarding_container/);assert.match(m,/partialFilterExpression:\{status:'IN_TERMINAL'\}/);
});
test('A16 forwarding controller stays isolated from payments and invoice models (static contract)',()=>{
 const c=source('../src/controllers/forwardingController.js');
 assert.doesNotMatch(c,/from ['"].*Invoice/);assert.doesNotMatch(c,/from ['"].*PaymentSubmission/);
 assert.match(c,/status:'GATED_OUT'/);assert.match(c,/findOneAndUpdate\(\{_id:req\.params\.id,status:'IN_TERMINAL',gateOutAt:null\}/);
});
test('Forwarding routes all require adminAuth + module permission (static contract)',()=>{
 const r=source('../src/routes/forwardingRoutes.js');const app=source('../src/app.js');
 assert.match(r,/router\.use\(adminAuth,requirePasswordChanged\)/);
 for(const action of ['VIEW','CREATE','PROCESS'])assert.ok(r.includes(`MODULES.FORWARDING,ACTIONS.${action}`));
 assert.match(app,/app\.use\('\/api\/admin\/forwarding',forwardingRoutes\)/);
});
test('Protected system administrator blocks all User Management mutations (static contract)',()=>{
 const controller=source('../src/controllers/adminUserController.js');const routes=source('../src/routes/adminUserRoutes.js');
 assert.match(controller,/function ensureCanTarget\(actor,target\)\{if\(isProtectedAdmin\(target\)\)/);
 for(const name of ['updateUser','updateStatus','updatePermissions','reissueTemporaryPassword','deleteUser']){
  const expression=new RegExp(`export const ${name}\\s*=[\\s\\S]*?(?=export const |$)`);
  const block=controller.match(expression);
  assert.ok(block,`missing ${name} handler`);
  assert.match(block[0],/ensureCanTarget\(req\.admin,user\)/);
 }
 assert.match(routes,/r\.delete\('\/:id'/);
});
test('Gate-in payment remains available before scheduled Gate-in date (static contract)',()=>{
 const invoice=source('../src/controllers/invoiceController.js');
 const slice=invoice.slice(invoice.indexOf('export const submitProof'),invoice.indexOf('export const reviewPayment'));
 assert.match(slice,/READY_FOR_GATE_IN/);assert.doesNotMatch(slice,/scheduledGateDateIn|scheduledGateTimeIn/);
});
