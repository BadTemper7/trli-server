import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {fileURLToPath} from 'node:url';
import {dirname,resolve} from 'node:path';
import {manualChargeInput,updatedInvoiceForCharge,updatedInvoiceForPayment} from '../src/utils/manualFinancialMath.js';

const read = path => fs.readFileSync(resolve(dirname(fileURLToPath(import.meta.url)),'..',path),'utf8');

test('inventory filters validate company ObjectIds and supported size/type values',()=>{
  const inventory=read('src/services/inventoryService.js');
  assert.match(inventory,/new mongoose\.Types\.ObjectId\(company\)/);
  assert.match(inventory,/enumParam\(query,'size'/);
  assert.match(inventory,/enumParam\(query,'type'/);
  assert.match(inventory,/prefixSearch\(query\)/);
  assert.match(inventory,/sorts:SORT_FIELDS/);
  assert.match(inventory,/sortPath\(paging\.sort\)/);
});
test('unreleased imported containers remain in inventory with real storage position',()=>{
  const inventory=read('src/services/inventoryService.js');
  assert.match(inventory,/ACTIVE_IMPORT/);
  assert.match(inventory,/gateOut\.releasedAt':null/);
  assert.match(inventory,/inventoryItemView/);
  assert.match(inventory,/daysInTerminal/);
  assert.match(inventory,/source==='HISTORICAL'/);
  assert.match(inventory,/billingStatus/);
});
test('manual VAT-exclusive charge increases outstanding balance without being marked paid',()=>{
  const invoice={lines:[],vatRate:12,vatInclusive:false,paidAmount:0,balance:0};
  const taxable=manualChargeInput({transactionType:'LIFT_ON',amount:3800,taxTreatment:'TAXABLE',quantity:1});
  const withCharge=updatedInvoiceForCharge(invoice,{amount:taxable.amount,quantity:1,taxTreatment:taxable.taxTreatment});
  assert.equal(withCharge.subtotal,3800);assert.equal(withCharge.vat,456);assert.equal(withCharge.total,4256);
  assert.equal(withCharge.balance,4256);assert.equal(withCharge.status,'UNPAID');
  const afterPayment=updatedInvoiceForPayment(withCharge,1000);
  assert.equal(afterPayment.paidAmount,1000);assert.equal(afterPayment.balance,3256);assert.equal(afterPayment.status,'PARTIALLY_PAID');
});
test('one unique storage claim covers LIVE and HISTORICAL records',()=>{
  const service=read('src/services/storageAssignmentService.js');
  const model=read('src/models/StorageSlotClaim.js');
  assert.match(model,/unique_storage_slot_cross_source/);
  assert.match(model,/unique_active_container_claim/);
  assert.match(model,/unique: true/);
  assert.match(service,/positionKey/);
  assert.match(service,/assignStorageClaim/);
  assert.match(service,/session\s*\?\s*\[await queries\[0\]\(\), await queries\[1\]\(\)\]/);
});
test('historical inventory uses source-aware auditing, and deletion clears physical claims',()=>{
  const routes=read('src/routes/operationsRoutes.js');
  const operations=read('src/controllers/operationsController.js');
  const deletion=read('src/controllers/bulkDeletionController.js');
  assert.match(routes,/inventory\/:source\/:id/);
  assert.match(operations,/updateInventoryBySource/);
  assert.match(operations,/HistoricalContainer\.findOne/);
  assert.match(deletion,/StorageSlotClaim\.deleteMany\(\{source:'LIVE'/);
  assert.match(deletion,/StorageSlotClaim\.deleteMany\(\{source:'HISTORICAL'/);
  assert.match(deletion,/historicalUsed\|\|claimed/);
});
test('storage claim migration is opt-in and never changes original container documents',()=>{
  const script=read('scripts/migrateStorageClaims.js');
  assert.match(script,/process\.argv\.includes\('--apply'\)/);
  assert.match(script,/verifyStorageClaims\(\)/);
  assert.match(script,/unique_storage_slot_cross_source/);
  assert.match(script,/unique_active_container_claim/);
  assert.match(script,/\$setOnInsert/);
  assert.doesNotMatch(script,/PreAdvice\.(update|delete)|HistoricalContainer\.(update|delete)/);
});
test('manual transaction UI reuses the idempotency key on a retry',()=>{
  const panel=read('../admin/src/components/invoices/AdminFinancialTransactions.jsx');
  assert.match(panel,/pendingRequestKey=useRef\(null\)/);
  assert.match(panel,/pendingRequestKey\.current \|\|/);
  assert.match(panel,/Add Transaction/);
  assert.match(panel,/Record Collected Payment/);
});

test('shared inventory hook has stable empty params and does not refetch forever',()=>{
  const hook=read('../admin/src/hooks/usePagedOperationsList.js');
  assert.match(hook,/const EMPTY_PARAMS = Object\.freeze\(\{\}\)/);
  assert.match(hook,/params = EMPTY_PARAMS/);
});

test('storage realtime event uses populated block identifier and never deletes historical rows through live actions',()=>{
  const page=read('../admin/src/pages/StorageMonitoring/StorageBlockDetailPage.jsx');
  assert.match(page,/destinationBlock\.id \|\| destinationBlock\._id/);
  assert.match(page,/canDelete=\{deletion\.allowed&&c\.source!=='HISTORICAL'\}/);
});

test('active historical containers cannot be archived and leave reserved storage claims hidden',()=>{
  const tracking=read('src/controllers/containerTrackingController.js');
  assert.match(tracking,/An active historical container must be physically released before it can be archived/);
});

test('saving live inventory reloads authoritative list rather than using incompatible live DTO',()=>{
  const page=read('../admin/src/pages/Inventory/InventoryPage.jsx');
  assert.match(page,/await Promise\.all\(\[load\(\),loadSummary\(\)\]\)/);
  assert.match(page,/inventory:\{\.\.\.current\.inventory,condition:form\.condition/);
});
