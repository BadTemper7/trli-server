// Shared pure validation for online payment setup and receiving account snapshots.
export const ONLINE_METHODS = Object.freeze(['BANK','GCASH','MAYA','E_WALLET']);
export function isConfiguredReceivingAccount(value) {
  return Boolean(value && ONLINE_METHODS.includes(value.code) && value.status === 'ACTIVE'
    && String(value.bankName || '').trim() && String(value.accountName || '').trim()
    && String(value.accountNumber || '').trim());
}
export function receivingAccountSnapshot(row) {
  return {bankName:row.bankName,accountName:row.accountName,accountNumber:row.accountNumber,paymentTypeName:row.name};
}
