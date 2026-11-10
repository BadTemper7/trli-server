import AdminAuditLog from '../models/AdminAuditLog.js';
import { safeAuditValue } from '../utils/auditSanitizer.js';

export async function auditAdminAction({ performedBy = null, targetUser = null, action, changes = {}, session = null }) {
  const record = { performedBy, targetUser, action, changes: safeAuditValue(changes) };
  if (session) return (await AdminAuditLog.create([record], { session }))[0];
  return AdminAuditLog.create(record);
}
