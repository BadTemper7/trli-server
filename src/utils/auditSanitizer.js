// Audit records must never persist or return credentials. Applies to nested
// documents and legacy entries when read back, not just newly-written logs.
export const isAuditSensitiveField = key =>
  /(?:password|passwd|passphrase|secret|token|auth(?:orization)?|credential|cookie|session(?:id|key)?|api[_-]?key|private[_-]?key|otp|pin|cvv|cvc|cardNumber|accountNumber|routingNumber|iban|passwordHash|storedName|salt|twoFactor|mfa)/i.test(String(key));

export function safeAuditValue(value, depth = 0) {
  if (value == null || typeof value !== 'object') return value;
  if (value instanceof Date) return value;
  if (value?._bsontype === 'ObjectId') return String(value);
  if (Buffer.isBuffer(value)) return '[File redacted]';
  if (depth > 7) return '[Nested details omitted]';
  if (Array.isArray(value)) return value.slice(0, 500).map(item => safeAuditValue(item, depth+1));
  if (value instanceof Map) return safeAuditValue(Object.fromEntries(value), depth+1);
  const result={};
  for (const [key,item] of Object.entries(value)) {
    if (!isAuditSensitiveField(key) && !key.startsWith('$')) result[key]=safeAuditValue(item,depth+1);
  }
  return result;
}
