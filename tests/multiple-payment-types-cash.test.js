import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { isAvailablePaymentChoice, isConfiguredReceivingAccount, receivingAccountSnapshot } from '../src/utils/paymentMethodRules.js';
const source=relative=>readFileSync(new URL(relative,import.meta.url),'utf-8');

test('Cash is selectable only when enabled; banks need active complete receiving accounts',()=>{
 const bank={_id:'bank1',code:'BANK',status:'ACTIVE',bankName:'BDO',accountName:'Trans Roadway',accountNumber:'0123456789',name:'BDO Main'};
 assert.equal(isAvailablePaymentChoice({code:'CASH',status:'ACTIVE'}),true);
 assert.equal(isAvailablePaymentChoice({code:'CASH',status:'INACTIVE'}),false);
 assert.equal(isConfiguredReceivingAccount(bank),true);
 assert.equal(isAvailablePaymentChoice(bank),true);
 assert.equal(isAvailablePaymentChoice({...bank,status:'INACTIVE'}),false);
 assert.equal(isAvailablePaymentChoice({...bank,accountNumber:''}),false);
 assert.equal(isAvailablePaymentChoice({...bank,code:'E_WALLET'}),true);
});
test('Snapshots identify the selected account and preserve its details for payment history',()=>{
 const row={_id:'account222',code:'BANK',name:'BDO Secondary',bankName:'BDO',accountName:'Trans Roadway',accountNumber:'0123897645'};
 assert.deepEqual(receivingAccountSnapshot(row),{
  paymentTypeId:'account222',paymentTypeName:'BDO Secondary',bankName:'BDO',accountName:'Trans Roadway',accountNumber:'0123897645',
 });
});
test('PaymentType schema stores multiple records per BANK code and protects the single Cash option',()=>{
 const model=source('../src/models/PaymentType.js');
 assert.match(model,/code:\s*\{\s*type:\s*String,\s*enum:\s*PAYMENT_TYPE_CODES,\s*required:\s*true\s*\}/);
 assert.doesNotMatch(model,/code:\s*\{[^}]*unique:\s*true/);
 assert.match(model,/unique_cash_payment_type/);
 assert.match(model,/idx_payment_type_category_status/);
 const controller=source('../src/controllers/paymentTypeController.js');
 assert.match(controller,/code: 'CASH', name: 'Cash'/);
 assert.match(controller,/if \(!current && code === 'CASH'\)/);
 assert.match(controller,/row\.status = 'INACTIVE'/);
 assert.match(controller,/Multiple BANK\/E_WALLET\/GCASH\/MAYA accounts/);
});
test('Clients select a specific available account ID; disabled choices are revalidated server-side',()=>{
 const selector=source('../../client/src/components/payment/OnlinePaymentMethod.jsx');
 assert.match(selector,/<option key=\{item\.id\} value=\{item\.id\}/);
 assert.match(selector,/payment-types\/active/);
 assert.match(selector,/Cash \(pay at cashier\)/);
 const service=source('../src/services/paymentMethods.js');
 assert.match(service,/mongoose\.isValidObjectId\(value\)/);
 assert.match(service,/\{ _id: value, status: 'ACTIVE' \}/);
 assert.match(service,/if \(row\.code === 'CASH'\)/);
 assert.match(service,/if \(!allowCash\)/);
 assert.match(service,/if \(matches\.length > 1\)/);
 const invoice=source('../src/controllers/invoiceController.js');
 assert.match(invoice,/method=receivingMethod\.code/);
 assert.match(invoice,/paymentType:receivingMethod\._id/);
});
test('Cash selection does not create a payment, issue a receipt, or mark the invoice paid',()=>{
 const invoice=source('../src/controllers/invoiceController.js');
 const cashIntent=invoice.split('export const selectClientCashPayment')[1].split('export const submitProof')[0];
 assert.doesNotMatch(cashIntent,/PaymentSubmission\.create/);
 assert.doesNotMatch(cashIntent,/uniqueReceiptNumber/);
 assert.doesNotMatch(cashIntent,/invoice\.status\s*=/);
 assert.match(cashIntent,/booking\.gateIn\.payment\.status = 'PENDING'/);
 const gateout=source('../src/controllers/clientGateOutController.js');
 assert.match(gateout,/invoiceStatus=cash\?'UNPAID':'PAYMENT_SUBMITTED'/);
 assert.match(gateout,/if\(!cash\)await PaymentSubmission\.create/);
 assert.match(gateout,/amountSubmitted=cash\?0:amount/);
 assert.match(gateout,/GATE_OUT_PAYMENT_PENDING/);
 assert.match(gateout,/submitPendingGateOutEvidence/);
});
test('Payment-type index migration is explicitly applied and does not touch existing payments',()=>{
 const migration=source('../scripts/migrateMultiplePaymentTypes.js');
 assert.match(migration,/process\.argv\.includes\('--apply'\)/);
 assert.match(migration,/if \(!apply\)/);
 assert.match(migration,/unique_cash_payment_type/);
 assert.match(migration,/dropIndex\(index\.name\)/);
 assert.doesNotMatch(migration,/PaymentSubmission\.delete/);
 assert.doesNotMatch(migration,/deleteMany\(/);
 const bulk=source('../src/controllers/bulkDeletionController.js');
 assert.match(bulk,/PaymentType\.updateMany\(\{_id:\{\$in:ids\}\},\{\$set:\{status:'INACTIVE'/);
 assert.doesNotMatch(bulk,/PaymentType\.deleteMany/);
});
