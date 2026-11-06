import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { priceLines } from '../src/utils/billingMath.js';

const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');

test('client invoice list remains compact; detail endpoint serves complete saved lines', () => {
  const backend = read('../src/controllers/invoiceController.js');
  assert.match(backend, /const INVOICE_LIST_FIELDS =/);
  assert.doesNotMatch(backend.match(/const INVOICE_LIST_FIELDS =[^\n]*/)?.[0] || '', /\blines\b/);
  assert.match(backend, /getClientInvoice[\s\S]*?Invoice\.findOne\(\{_id:req\.params\.id,company:owner\(req\)\}\)\.lean\(\)/);
  assert.match(backend, /data:\{invoice,payments\}/);
});

test('booking detail uses a server-side booking filter, then fetches full invoice before opening payment', () => {
  const ui = read('../../client/src/pages/portal/PreAdviceDetail.jsx');
  assert.match(ui, /api\.get\('\/invoices', \{ params: \{ booking: id, limit: 10 \} \}\)/);
  assert.match(ui, /api\.get\(`\/invoices\/\$\{invoiceId\}`\)/);
  assert.match(ui, /const detailedInvoice = await fetchInvoiceDetails\(invoiceRecord\._id\);\s*setPaymentInvoice\(detailedInvoice\);\s*setPaymentModal\('GATE_IN'\)/);
  assert.match(ui, /const detailedInvoice = await fetchInvoiceDetails\(gateOutInvoice\._id\);/);
  assert.match(ui, /invoice=\{paymentInvoice\}/);
});

test('client itemized breakdown shows actual billed transactions before total and VAT, without silently suppressing missing lines', () => {
  const modal = read('../../client/src/components/payment/BookingPaymentModal.jsx');
  const breakdown = read('../../client/src/components/payment/InvoiceTransactionBreakdown.jsx');
  const form = read('../../client/src/components/payment/BookingGateInPayment.jsx');
  assert.match(modal, /<InvoiceTransactionBreakdown invoice=\{invoice\}/);
  for (const text of ['line.description', 'line.quantity', 'line.unitRate', 'line.amount', 'invoice?.subtotal', 'invoice?.vat', 'invoice?.total']) {
    assert.ok(breakdown.includes(text), `Missing invoice field ${text}`);
  }
  assert.match(breakdown, /role="alert"/);
  assert.match(form, /breakdownAccurate/);
  assert.doesNotMatch(form, /\(invoice\.lines\|\|\[\]\)\.map/);
});

test('Documentation Fee and Lift-On/Off appear with correct VAT when configured as automatic Gate-in charges', () => {
  const base = {status:'ACTIVE',classification:'LOCAL',loadStatus:'EMPTY',containerSize:'20FT',containerCategory:'STANDARD',taxTreatment:'TAXABLE',billingMode:'AUTOMATIC',collectionPoint:'GATE_IN'};
  const rates = [
    {...base, _id:'aaaaaaaaaaaaaaaaaaaaaaaa', name:'Documentation Fee', amount:300},
    {...base, _id:'bbbbbbbbbbbbbbbbbbbbbbbb', name:'Lift On', amount:2000},
    {...base, _id:'cccccccccccccccccccccccc', name:'Lift Off', amount:2000},
  ];
  const booking = {transactionClassification:'LOCAL',containerType:'STANDARD',loadStatus:'EMPTY',containerSize:'20FT',scheduledGateTimeIn:'10:00'};
  const settings = {tax:{vatRate:12},overtime:{active:false},shiftingFee:0};
  const quote = priceLines(rates, booking, 'GATE_IN', settings);
  assert.deepEqual(quote.lines.map(line=>line.description).sort(), ['Documentation Fee','Lift Off','Lift On'].sort());
  assert.equal(quote.subtotal,4300);
  assert.equal(quote.vat,516);
  assert.equal(quote.total,4816);
});
