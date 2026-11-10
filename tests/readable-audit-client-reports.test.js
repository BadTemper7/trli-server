import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { safeAuditValue, isAuditSensitiveField } from '../src/utils/auditSanitizer.js';
import { auditTitle, auditFields, auditDifferences, presentAuditLog } from '../../admin/src/lib/auditFormatter.js';
const read = file => fs.readFileSync(new URL(file,import.meta.url),'utf8');

test('audit action names and amounts use readable labels and pesos',()=>{
  assert.equal(auditTitle('RECORD_DELETED'),'Record Deleted');
  assert.equal(auditTitle('GATE_IN'),'Gate-In');
  const rows=auditFields({vat:456,total:4256,containerNumber:'SGH23434234'});
  assert.equal(rows.find(x=>x.key==='vat').value,'₱456.00');
  assert.equal(rows.find(x=>x.key==='total').value,'₱4,256.00');
  assert.equal(rows.find(x=>x.key==='containerNumber').value,'SGH23434234');
});
test('legacy nested fields and current payloads remove secrets without printing JSON',()=>{
  const record=safeAuditValue({status:'PAID',password:'secret',nested:{accessToken:'abc',condition:'GOOD',auth:{password:'hidden'}},items:[{apiKey:'key',total:4256}]});
  assert.deepEqual(record,{status:'PAID',nested:{condition:'GOOD'},items:[{total:4256}]});
  assert.ok(isAuditSensitiveField('passwordHash'));
  const entry=presentAuditLog({action:'PAYMENT_CREATED',changes:{method:'BANK',amount:4256,pin:'1234',paymentId:'xxx'},performedBy:{email:'admin@example.com'}});
  assert.doesNotMatch(JSON.stringify(entry),/1234/);
  assert.equal(entry.details.find(x=>x.key==='amount').value,'₱4,256.00');
});
test('updated records show only modified values, including storage slot changes',()=>{
  const diff=auditDifferences({status:'BOOKED',containerSize:'20FT',storage:{blockName:'Block A',bay:1,row:1,tier:1}},
    {status:'GATED_IN',containerSize:'20FT',storage:{blockName:'Block B',bay:2,row:1,tier:1}});
  assert.deepEqual(diff.map(x=>x.field),['Status','Storage / Storage Block','Storage / Bay']);
  assert.equal(diff[0].previous,'Booked');
  assert.equal(diff[0].updated,'Gated In');
});
test('deletion entries show all affected records, reason, and saved counts',()=>{
  const view=presentAuditLog({action:'RECORDS_BULK_DELETED',createdAt:'2026-11-10T02:41:00.000Z',performedBy:{email:'roadway@example.com'},changes:{
    module:'CONTAINER_TRACKING',reason:'Duplicate historical entries',
    records:[{recordId:'id1',containerNumber:'SGH23434234',recordType:'Historical Container',previousStatus:'BOOKED',result:'Deleted'},
      {recordId:'id2',containerNumber:'SGH23434235',recordType:'Historical Container',previousStatus:'STORED',result:'Deleted'}],
    deletionSummary:{totalRecordsDeleted:2,historicalRecordsDeleted:2,financialRecordsDeleted:0},
  }});
  assert.equal(view.records.length,2);assert.equal(view.primary,'SGH23434234');
  assert.equal(view.reason,'Duplicate historical entries');assert.equal(view.deletionSummary.totalRecordsDeleted,2);
  assert.ok(!view.isFailure);
});
test('older delete records with no snapshots degrade gracefully and never invent a container',()=>{
  const view=presentAuditLog({action:'RECORD_DELETED',changes:{module:'CONTAINER_TRACKING',ids:['id1'],reason:'Expired test'}});
  assert.equal(view.records.length,0);assert.equal(view.reason,'Expired test');
});
test('report queries are validated and customer scoped before aggregation, list and export',()=>{
  const source=read('../src/controllers/analyticsController.js');
  const routes=read('../src/routes/adminRoutes.js');
  assert.match(source,/reportScope\(query\s*=\s*\{\}\)/);
  assert.match(source,/Select a valid registered client/);
  assert.match(source,/scopeMatch\(\{deletedAt:null,\.\.\.dateFilter\('createdAt',from,to\)\},company\)/);
  assert.match(source,/Invoice\.aggregate\(\[\{\$match:invoiceRange\(from,to,company\)/);
  assert.match(source,/PaymentSubmission\.aggregate\(revenuePipeline\(from,to/);
  assert.match(source,/cursor\(\{batchSize:100\}\)/);
  assert.match(source,/populate\('storage.block','name'\)/);
  assert.match(source,/await streamRows\(res,\['Client',client\?\.companyName\|\|'All Clients'\]\)/);
  assert.match(routes,/requirePermission\(MODULES.REPORTS, ACTIONS.EXPORT\), exportReports/);
});
test('audit writes are sanitized and existing logs are also sanitized on read',()=>{
  const controller=read('../src/controllers/bulkDeletionController.js');
  const service=read('../src/services/adminAuditService.js');
  const model=read('../src/models/AdminAuditLog.js');
  assert.match(service,/safeAuditValue\(changes\)/);
  assert.match(controller,/safeAuditValue\(item\.changes\)/);
  assert.match(controller,/deletionSummary/);
  assert.match(model,/Audit log entries are immutable/);
});

test('audit comparison includes fields removed from updated records',()=>{
  const changes=auditDifferences({status:'BOOKED',storage:{blockName:'Block A',bay:1},remarks:'Old remark'},
    {status:'GATED_IN',storage:{blockName:'Block B',bay:2}});
  assert.deepEqual(changes.map(x=>x.field),['Status','Storage / Storage Block','Storage / Bay','Remarks']);
  const removed=changes.at(-1);
  assert.equal(removed.previous,'Old remark');
  assert.equal(removed.updated,'Removed');
});
test('new record details remain visible even when audit has no before snapshot',()=>{
  const view=presentAuditLog({action:'RATE_CREATED',changes:{module:'RATE_SETUP',after:{name:'Lift-On',amount:3800,vat:456,apiKey:'must-not-leak'}}});
  assert.equal(view.createdFields.find(x=>x.key==='amount')?.value,'₱3,800.00');
  assert.equal(view.createdFields.find(x=>x.key==='vat')?.value,'₱456.00');
  assert.doesNotMatch(JSON.stringify(view),/must-not-leak/);
  assert.equal(view.result,'Successfully Created');
});
test('payment auditing redacts bank account numbers in both old and new entries',()=>{
  const raw={changes:{receivingAccount:{accountNumber:'1234567890',bankName:'Sample'},amount:4256}};
  const view=presentAuditLog({action:'PAYMENT_VERIFIED',...raw});
  assert.doesNotMatch(JSON.stringify(view),/1234567890/);
  assert.equal(view.details.find(x=>x.key==='amount')?.value,'₱4,256.00');
});
test('deleted and created record details remain readable',()=>{
  const view=presentAuditLog({action:'RECORD_DELETED',changes:{module:'CONTAINER_TRACKING',records:[{containerNumber:'AAAU1234567',recordType:'Historical Container',previousStatus:'BOOKED',result:'Deleted'}],reason:'Duplicate record'}});
  assert.equal(view.result,'Successfully Deleted');
  assert.equal(view.records[0].previousStatus,'Booked');
  assert.equal(view.reason,'Duplicate record');
});
test('report query builder validates scope and bounds page/limit values',()=>{
  const source=read('../src/controllers/analyticsController.js');
  assert.match(source,/reportScope\(query\s*=\s*\{\}\)/);
  assert.match(source,/new mongoose\.Types\.ObjectId\(value\)/);
  assert.match(source,/Number\.isSafeInteger\(pageNumber\)/);
  assert.match(source,/Number\.isSafeInteger\(limitNumber\)/);
  assert.match(source,/pageNumber>100000/);
  assert.match(source,/limitNumber>1000/);
  assert.match(source,/Select a valid registered client/);
});
test('client scoped net revenue events include reversals and event metadata',()=>{
  const source=read('../src/services/revenueService.js');
  assert.match(source,/company \? \{ company \} : \{\}/);
  assert.match(source,/method: 1, reference: 1, receiptNumber: 1/);
  assert.match(source,/refundOnly: true/);
  const report=read('../src/controllers/analyticsController.js');
  assert.match(report,/PaymentSubmission\.aggregate\(revenuePipeline\(from,to/);
  assert.match(report,/Payment Ledger Events \(net of reversals\)/);
  assert.match(report,/paymentCursor\.close\(\)/);
});
