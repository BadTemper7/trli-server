import AdminAuditLog from '../models/AdminAuditLog.js';

const blockedKeys = new Set(['password','confirmPassword','passwordHash','temporaryPassword','oldPassword']);
function sanitize(value) {
  if (!value || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(sanitize);
  return Object.fromEntries(Object.entries(value).filter(([k]) => !blockedKeys.has(k)).map(([k,v]) => [k, sanitize(v)]));
}

export async function auditAdminAction({ performedBy = null, targetUser = null, action, changes = {} }) {
  return AdminAuditLog.create({ performedBy, targetUser, action, changes: sanitize(changes) });
}
