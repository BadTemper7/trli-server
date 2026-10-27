// Database-free formatter so the public number layout can be tested without MongoDB.
// Historical stored references keep their original format.
export const REFERENCE_PREFIX = Object.freeze({
  BOOKING: 'TRANS-BKG',
  INVOICE: 'TRANS-INV',
  RECEIPT: 'TRANS-RCT',
});

export function referenceDay(date) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone:'Asia/Manila', year:'numeric', month:'2-digit', day:'2-digit',
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map(({type, value}) => [type, value]));
  return `${values.year}${values.month}${values.day}`;
}

export function formatReference(type, date, sequence) {
  const documentType = String(type || '').toUpperCase();
  const prefix = REFERENCE_PREFIX[documentType];
  if (!prefix) throw new Error(`Unsupported reference type: ${documentType}`);
  return `${prefix}-${referenceDay(date)}-${String(sequence).padStart(4, '0')}`;
}
