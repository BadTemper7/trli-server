// Keep financial deletion policy independent of database availability.
// Financial records may be removed only by explicitly confirmed, audited
// operations with the matching module-level DELETE permission.
export function includesIssuedFinancialRecords(invoices = [], payments = []) {
  return invoices.some(invoice => invoice.status === 'PAID')
    || payments.some(payment => ['VERIFIED','REFUNDED','REVERSED','VOIDED'].includes(payment.status));
}

export function acknowledgedFinancialDeletion(body = {}) {
  // Accept only the JSON boolean true; strings/other truthy values are denied.
  return body.purgeFinancial === true;
}
