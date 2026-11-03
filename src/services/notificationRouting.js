import { MODULES } from '../constants/permissions.js';

// A notification is delivered only to permission-protected work queues.
// One payment can serve two queues, but never broadcast to every admin.
export function notificationModuleForType(type = '') {
  const name = String(type || '').toUpperCase();
  if (name.startsWith('PRE_ADVICE_')) return MODULES.PRE_ADVICE;
  if (name.startsWith('GATE_IN_')) return MODULES.GATE_IN;
  if (name.startsWith('GATE_OUT_')) return MODULES.GATE_OUT;
  if (name.startsWith('VERIFICATION_') || name.startsWith('CLIENT_VERIFICATION_')) return MODULES.CLIENT_VERIFICATION;
  if (name.startsWith('PAYMENT_')) return MODULES.PAYMENT_HISTORY;
  return MODULES.DASHBOARD;
}

export function notificationModulesForType(type = '') {
  const primary = notificationModuleForType(type);
  // The same submitted proof is actionable from Gate-in/Gate-out and relevant
  // to the payment history team. Each user receives one notification document.
  if (type === 'GATE_IN_PAYMENT_SUBMITTED') return [MODULES.GATE_IN, MODULES.PAYMENT_HISTORY];
  if (type === 'GATE_OUT_REQUESTED') return [MODULES.GATE_OUT, MODULES.PAYMENT_HISTORY];
  return [primary];
}

export function accessibleNotificationModules(admin) {
  if (!admin || admin.mustChangePassword || admin.status !== 'ACTIVE') return [];
  if (admin.role === 'SUPER_ADMIN') return Object.keys(MODULES).map(key => MODULES[key]);
  return [...new Set((admin.permissions || [])
    .filter(permission => permission.actions?.includes('VIEW') && Object.values(MODULES).includes(permission.module))
    .map(permission => permission.module))];
}

// Older ADMIN notifications have no module. Keep them readable without exposing
// records outside of the current admin's VIEW permissions.
const legacyPrefixes = [
  [MODULES.PRE_ADVICE, /^PRE_ADVICE_/],
  [MODULES.GATE_IN, /^GATE_IN_/],
  [MODULES.GATE_OUT, /^GATE_OUT_/],
  [MODULES.CLIENT_VERIFICATION, /^(VERIFICATION_|CLIENT_VERIFICATION_)/],
  [MODULES.PAYMENT_HISTORY, /^PAYMENT_/],
];
const knownPrefixes = /^(PRE_ADVICE_|GATE_IN_|GATE_OUT_|VERIFICATION_|CLIENT_VERIFICATION_|PAYMENT_)/;

export function adminNotificationFilter(admin) {
  const modules = accessibleNotificationModules(admin);
  if (!modules.length) return { audience: 'ADMIN', _id: { $exists: false } };
  const clauses = [{ module: { $in: modules } }, { modules: { $in: modules } }];
  for (const [module, prefix] of legacyPrefixes) {
    if (modules.includes(module)) clauses.push({ module: null, type: prefix });
  }
  if (modules.includes(MODULES.DASHBOARD)) {
    clauses.push({ module: null, type: { $not: knownPrefixes } });
  }
  return { audience: 'ADMIN', $or: clauses };
}
