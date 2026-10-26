import test from 'node:test';
import assert from 'node:assert/strict';
import { billableStorageDays, overtimeApplies, priceLines, pickApplicableRates } from '../src/utils/billingMath.js';
import { renderFinancialPdf } from '../src/services/pdfDocuments.js';

const booking={containerType:'DRY CONTAINER',containerSize:'20FT',loadStatus:'EMPTY',transactionClassification:'LOCAL',scheduledGateTimeIn:'08:00',gateIn:{actualGateInAt:'2026-10-26T00:00:00.000Z'},gateOut:{scheduledDate:'2026-10-27',scheduledTime:'10:00'}};
const rates=[
 {status:'ACTIVE',name:'Gate-in Handling',collectionPoint:'GATE_IN',classification:'LOCAL',containerCategory:'STANDARD',loadStatus:'EMPTY',containerSize:'ALL',amount:100,taxTreatment:'TAXABLE',_id:'1'},
 {status:'ACTIVE',name:'Gate-in Handling',collectionPoint:'GATE_IN',classification:'LOCAL',containerCategory:'STANDARD',loadStatus:'EMPTY',containerSize:'20FT',amount:200,taxTreatment:'TAXABLE',_id:'2'},
 {status:'ACTIVE',name:'Storage',collectionPoint:'GATE_OUT',classification:'LOCAL',containerCategory:'STANDARD',loadStatus:'EMPTY',containerSize:'20FT',amount:75,taxTreatment:'EXEMPT',_id:'3'},
];
const settings={shiftingFee:50, overtime:{active:true,start:'17:00',end:'06:00',fee:25}, tax:{vatRate:12,vatInclusive:false}};
test('size-specific handling rate wins over all-size rate',()=>{assert.equal(pickApplicableRates(rates,booking).find(r=>r.name==='Gate-in Handling').amount,200)});
test('shifting once plus VAT excludes exempt fees',()=>{
 const quote=priceLines(rates.filter(r=>r.collectionPoint==='GATE_IN'),booking,'GATE_IN',settings);
 assert.equal(quote.subtotal,250);assert.equal(quote.vat,30);assert.equal(quote.total,280);
 assert.equal(quote.lines.filter(l=>l.description==='Shifting Fee').length,1);
});
test('tax-inclusive VAT extraction and storage day rounding',()=>{
 const invoice=priceLines(rates.filter(r=>r.collectionPoint==='GATE_OUT'),booking,'GATE_OUT',{...settings,tax:{vatRate:12,vatInclusive:true}});
 assert.equal(billableStorageDays(booking.gateIn.actualGateInAt,'2026-10-27','10:00'),2);
 assert.equal(invoice.lines.find(l=>l.description==='Storage').amount,150);
 assert.equal(invoice.vat,0);
});
test('overtime crosses midnight correctly',()=>{
 assert.equal(overtimeApplies('23:00',settings.overtime),true);
 assert.equal(overtimeApplies('05:00',settings.overtime),true);
 assert.equal(overtimeApplies('08:00',settings.overtime),false);
});
test('reefer loaded is rejected by price selection',()=>assert.throws(()=>pickApplicableRates(rates,{...booking,containerType:'REEFER',loadStatus:'LOADED'})));
test('financial PDF has valid header, trailer, invoice and receipt text',()=>{
 const invoice={number:'TRANS-20261026-0001',type:'GATE_IN',createdAt:'2026-10-26T12:00:00Z',lines:[{description:'Gate-in Handling',quantity:1,unitRate:200,amount:200}],vatRate:12,vatInclusive:false,subtotal:200,vat:24,total:224,paidAmount:224,balance:0,status:'PAID'};
 const pdf=renderFinancialPdf({invoice,booking:{bookingReference:'TRANS-20261026-0001',containerNumber:'ABCD1234567'},companyName:'Sample Company'});
 assert.equal(pdf.subarray(0,8).toString(),'%PDF-1.4');assert.match(pdf.toString(),/%%EOF/);assert.match(pdf.toString(),/INVOICE/);
 const receipt=renderFinancialPdf({invoice,booking,companyName:'Sample Company',payment:{receiptNumber:'TRANS-20261026-0002',verifiedAt:'2026-10-26T13:00:00Z',method:'BANK',reference:'REF002',amount:224}});
 assert.match(receipt.toString(),/PAYMENT RECEIPT/);assert.match(receipt.toString(),/REF002/);
});
