import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {parseGateOutReleaseCondition,parseGateOutReleaseRemarks,GATE_OUT_RELEASE_CONDITIONS} from '../src/utils/gateOutReleaseCondition.js';
import {renderGatePassPdf} from '../src/services/printableDocuments.js';

const read = path => readFileSync(new URL(path,import.meta.url),'utf8');

test('Gate-out approval requires a release condition even when a client omits the frontend',()=>{
 for(const input of [undefined,null,'GOOD',[],[''],['NOT REAL'],[true]]) {
  assert.throws(()=>parseGateOutReleaseCondition(input),error=>error.status===400);
 }
});

test('Gate-out checker can select multiple damage conditions but cannot combine GOOD and damage',()=>{
 assert.deepEqual(parseGateOutReleaseCondition([' dented ','RUST','dented']),['DENTED','RUST']);
 assert.deepEqual(parseGateOutReleaseCondition(['GOOD']),['GOOD']);
 assert.throws(()=>parseGateOutReleaseCondition(['GOOD','HOLE']),error=>error.status===400);
 assert.deepEqual(GATE_OUT_RELEASE_CONDITIONS,['GOOD','DENTED','RUST','HOLE','DOOR DAMAGE','OTHER']);
});

test('Condition remarks are optional, trimmed and length/type-checked',()=>{
 assert.equal(parseGateOutReleaseRemarks(undefined),'');
 assert.equal(parseGateOutReleaseRemarks('  Forklift scratches near rear corner  '),'Forklift scratches near rear corner');
 assert.throws(()=>parseGateOutReleaseRemarks('x'.repeat(801)),error=>error.status===400);
 assert.throws(()=>parseGateOutReleaseRemarks({hidden:'value'}),error=>error.status===400);
});

test('Gate-out approval saves condition within the payment/booking/audit transaction',()=>{
 const controller=read('../src/controllers/clientGateOutController.js');
 const model=read('../src/models/PreAdvice.js');
 assert.match(controller,/conditionUponRelease=parseGateOutReleaseCondition\(req\.body\?\.conditionUponRelease\)/);
 assert.match(controller,/conditionRemarks=parseGateOutReleaseRemarks\(req\.body\?\.remarks\)/);
 assert.match(controller,/booking\.gateOut\.conditionUponRelease=conditionUponRelease/);
 assert.match(controller,/booking\.gateOut\.conditionRecordedBy=String\(req\.admin\._id\)/);
 assert.match(controller,/await payment\.save\(\{session\}\);await invoice\.save\(\{session\}\);await booking\.save\(\{session\}\)/);
 assert.match(controller,/conditionUponRelease,conditionRemarks.*\},session\}\)/);
 assert.match(model,/conditionUponRelease: \[\{type:String,enum:/);
 assert.match(model,/conditionRemarks: \{type:String,default:''\}/);
});

test('Approved Gate-out Pass contains release condition remarks, not the later physical release note',()=>{
 const booking={bookingReference:'TRANS-2026-001',containerNumber:'TRLU1234567',containerSize:'40FT',containerType:'REEFER',
  gateOut:{approvalStatus:'APPROVED',conditionUponRelease:['DENTED','RUST'],conditionRemarks:'Scratch on rear door',conditionRecordedAt:new Date(),remarks:'Released physically at noon'}};
 const content=renderGatePassPdf({booking,type:'GATE_OUT'}).toString('latin1');
 assert.match(content,/CONDITION UPON RELEASE/);
 assert.match(content,/Scratch on rear door/);
 assert.doesNotMatch(content,/Released physically at noon/);
 assert.match(read('../src/services/printableDocuments.js'),/booking\.gateOut\?\.conditionUponRelease \|\| \[\]/);
});

test('New approvals with blank optional condition remarks do not print later physical-release remarks',()=>{
 const booking={bookingReference:'TRM-002',containerNumber:'TRLU1234567',
  gateOut:{approvalStatus:'RELEASED',conditionUponRelease:['GOOD'],conditionRemarks:'',conditionRecordedAt:new Date('2026-11-04'),remarks:'Physical release note only'}};
 const content=renderGatePassPdf({booking,type:'GATE_OUT'}).toString('latin1');
 assert.doesNotMatch(content,/Physical release note only/);
 const legacy=renderGatePassPdf({booking:{...booking,gateOut:{approvalStatus:'APPROVED',remarks:'Original historical notes'}},type:'GATE_OUT'}).toString('latin1');
 assert.match(legacy,/Original historical notes/);
});

test('Admin Gate-out approval UI requires selection and offers optional remarks',()=>{
 const ui=read('../../admin/src/pages/GateOut/GateOutPage.jsx');
 assert.match(ui,/Condition Upon Release/);
 assert.match(ui,/conditionUponRelease\.length/);
 assert.match(ui,/aria-pressed=\{conditionUponRelease\.includes\(option\)\}/);
 assert.match(ui,/remarks:conditionRemarks/);
 assert.match(ui,/Remarks <span className="font-normal text-muted-foreground">\(optional\)<\/span>/);
});

test('Admin invoice and payment history share the other modules page margins',()=>{
 const invoices=read('../../admin/src/pages/PaymentHistory/InvoiceReviewPage.jsx');
 const payments=read('../../admin/src/pages/PaymentHistory/PaymentHistoryPage.jsx');
 assert.match(invoices,/import PageContainer from/);
 assert.match(invoices,/import PageHeader from/);
 assert.match(invoices,/return <PageContainer>/);
 assert.match(invoices,/<\/PageContainer>/);
 assert.match(payments,/InvoiceReviewPage/);
});