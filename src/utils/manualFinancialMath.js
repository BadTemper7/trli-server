import { money, totalsForLines } from './billingMath.js';

export const MANUAL_TRANSACTION_TYPES = Object.freeze([
  'GATE_IN_FEE','GATE_OUT_FEE','DOCUMENTATION_FEE','LIFT_ON','LIFT_OFF',
  'STORAGE_FEE','OVERTIME_FEE','OTHER_CHARGES',
]);
export const TRANSACTION_LABELS = Object.freeze({
  GATE_IN_FEE:'Gate-In Fee',GATE_OUT_FEE:'Gate-Out Fee',DOCUMENTATION_FEE:'Documentation Fee',
  LIFT_ON:'Lift-On Fee',LIFT_OFF:'Lift-Off Fee',STORAGE_FEE:'Storage Fee',
  OVERTIME_FEE:'Overtime Fee',OTHER_CHARGES:'Other Charges',
});
const cents = value => Number.isFinite(Number(value)) && Math.abs(Number(value)*100-Math.round(Number(value)*100))<1e-6;
export function manualChargeInput(input={}) {
  const chargeType=String(input.transactionType||'').toUpperCase();
  if (!MANUAL_TRANSACTION_TYPES.includes(chargeType)) throw new Error('Select a valid transaction type.');
  const amount=Number(input.amount),quantity=Number(input.quantity??1);
  if(!cents(input.amount)||amount<=0||amount>100_000_000)throw new Error('Charge amount must be greater than zero and have at most two decimal places.');
  if(!Number.isSafeInteger(quantity)||quantity<1||quantity>100)throw new Error('Quantity must be a whole number from 1 to 100.');
  const taxTreatment=String(input.taxTreatment||'TAXABLE').toUpperCase();
  if(!['TAXABLE','EXEMPT','ZERO_RATED'].includes(taxTreatment))throw new Error('Invalid VAT classification.');
  const description=String(input.description||TRANSACTION_LABELS[chargeType]).trim();
  if(!description||description.length>200)throw new Error('Charge description must be 1 to 200 characters.');
  return {chargeType,description,amount:money(amount),quantity,taxTreatment};
}
export function recordedPaymentInput(input={}) {
  const amount=Number(input.amount);
  if(!cents(input.amount)||amount<=0||amount>100_000_000)throw new Error('Payment must be positive and have at most two decimal places.');
  const method=String(input.method||'').trim().toUpperCase();
  if(!/^[A-Z0-9_ -]{2,40}$/.test(method))throw new Error('A valid payment method is required.');
  const reference=String(input.reference||'').trim();
  if(reference.length>120)throw new Error('Payment reference exceeds 120 characters.');
  if(method!=='CASH'&&!reference)throw new Error('A reference is required for noncash payments; cash may be recorded without a reference.');
  return {amount:money(amount),method,reference};
}
export function updatedInvoiceForCharge(invoice, line) {
  const totals=totalsForLines([...(invoice.lines||[]),line],invoice.vatRate,invoice.vatInclusive===true);
  const paid=money(invoice.paidAmount||0);
  return {...totals,paidAmount:paid,balance:money(totals.total-paid),status:paid>0?'PARTIALLY_PAID':'UNPAID'};
}
export function updatedInvoiceForPayment(invoice, amount) {
  const balance=money(invoice.balance),paid=money(invoice.paidAmount||0);
  if(money(amount)>balance)throw new Error('Payment exceeds the outstanding invoice balance.');
  const nextBalance=money(balance-amount);
  return {paidAmount:money(paid+amount),balance:nextBalance,status:nextBalance===0?'PAID':'PARTIALLY_PAID'};
}
