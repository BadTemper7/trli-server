// Shared rules for online receiving accounts and offline Cash payment choice.
export const ONLINE_METHODS = Object.freeze(['BANK', 'GCASH', 'MAYA', 'E_WALLET']);
export const PAYMENT_METHOD_CODES = Object.freeze(['CASH', ...ONLINE_METHODS]);
export function isConfiguredReceivingAccount(value) {
  return Boolean(value && ONLINE_METHODS.includes(value.code) && value.status === 'ACTIVE'
    && String(value.bankName || '').trim() && String(value.accountName || '').trim()
    && String(value.accountNumber || '').trim());
}
export function isAvailablePaymentChoice(value) {
  return Boolean(value?.status === 'ACTIVE' && (value.code === 'CASH' || isConfiguredReceivingAccount(value)));
}
export function receivingAccountSnapshot(row) {
  return {
    bankName: row.bankName, accountName: row.accountName,
    accountNumber: row.accountNumber, paymentTypeName: row.name,
    ...(row._id ? { paymentTypeId: String(row._id) } : {}),
  };
}
