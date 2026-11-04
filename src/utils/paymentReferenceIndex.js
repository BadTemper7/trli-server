/**
 * One payment may have proof only. Uniqueness applies to real references for
 * active/verified submissions within a payment method, never to blank values.
 * Keep the index definition shared by Mongoose and the index repair migration.
 */
export const PAYMENT_REFERENCE_INDEX_NAME = 'method_1_reference_1';
export const PAYMENT_REFERENCE_INDEX_KEYS = Object.freeze({ method: 1, reference: 1 });
export const PAYMENT_REFERENCE_ACTIVE_STATUSES = Object.freeze(['VERIFIED', 'PENDING_VERIFICATION']);
export const PAYMENT_REFERENCE_PARTIAL_FILTER = Object.freeze({
  status: { $in: [...PAYMENT_REFERENCE_ACTIVE_STATUSES] },
  reference: { $type: 'string', $gt: '' },
});

function canonical(value, operator = '') {
  if (Array.isArray(value)) {
    const mapped = value.map(item => canonical(item));
    return operator === '$in' ? mapped.sort() : mapped;
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key], key)]));
  }
  return value;
}

export function isPaymentReferenceKey(index) {
  const key = index?.key || {};
  return Object.keys(key).length === 2 && key.method === 1 && key.reference === 1;
}

export function isSafePaymentReferenceIndex(index) {
  return isPaymentReferenceKey(index) && index.unique === true &&
    JSON.stringify(canonical(index.partialFilterExpression)) === JSON.stringify(canonical(PAYMENT_REFERENCE_PARTIAL_FILTER));
}

/** Never silently remove unrelated custom reference indexes. */
export function classifyPaymentReferenceIndexes(indexes = []) {
  const candidates = indexes.filter(index => Object.hasOwn(index.key || {}, 'reference'));
  return {
    safe: candidates.filter(isSafePaymentReferenceIndex),
    legacy: candidates.filter(index => isPaymentReferenceKey(index) && !isSafePaymentReferenceIndex(index)),
    unknown: candidates.filter(index => index.unique && !isPaymentReferenceKey(index)),
  };
}
