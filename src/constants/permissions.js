export const MODULES = Object.freeze({
  DASHBOARD: 'DASHBOARD',
  CLIENT_VERIFICATION: 'CLIENT_VERIFICATION',
  USER_MANAGEMENT: 'USER_MANAGEMENT',
  PRE_ADVICE: 'PRE_ADVICE',
  GATE_IN: 'GATE_IN',
  INVENTORY: 'INVENTORY',
  STORAGE_MONITORING: 'STORAGE_MONITORING',
  RATE_SETUP: 'RATE_SETUP',
  PAYMENT_TYPES: 'PAYMENT_TYPES',
  GATE_OUT: 'GATE_OUT',
  FORWARDING: 'FORWARDING',
  RELEASE_CONTAINER: 'RELEASE_CONTAINER',
  PAYMENT_HISTORY: 'PAYMENT_HISTORY',
  REPORTS: 'REPORTS',
  SETTINGS: 'SETTINGS',
});

export const ACTIONS = Object.freeze({
  VIEW: 'VIEW', CREATE: 'CREATE', EDIT: 'EDIT', DELETE: 'DELETE',
  APPROVE: 'APPROVE', REJECT: 'REJECT', PROCESS: 'PROCESS', EXPORT: 'EXPORT',
  MANAGE_ACCESS: 'MANAGE_ACCESS', ASSIGN: 'ASSIGN', RELOCATE: 'RELOCATE', RESET_PASSWORD: 'RESET_PASSWORD',
});

export const MODULE_ACTIONS = Object.freeze({
  DASHBOARD: ['VIEW'],
  CLIENT_VERIFICATION: ['VIEW','APPROVE','REJECT'],
  USER_MANAGEMENT: ['VIEW','CREATE','EDIT','DELETE','MANAGE_ACCESS','RESET_PASSWORD'],
  PRE_ADVICE: ['VIEW','CREATE','EDIT','DELETE'],
  GATE_IN: ['VIEW','PROCESS'],
  INVENTORY: ['VIEW','EDIT'],
  STORAGE_MONITORING: ['VIEW','CREATE','EDIT','DELETE','ASSIGN','RELOCATE'],
  RATE_SETUP: ['VIEW','CREATE','EDIT','DELETE'],
  PAYMENT_TYPES: ['VIEW','CREATE','EDIT','DELETE'],
  GATE_OUT: ['VIEW','PROCESS'],
  FORWARDING: ['VIEW','CREATE','PROCESS'],
  RELEASE_CONTAINER: ['VIEW','PROCESS'],
  PAYMENT_HISTORY: ['VIEW'],
  REPORTS: ['VIEW','EXPORT'],
  SETTINGS: ['VIEW','EDIT'],
});

export function normalizePermissions(input = []) {
  const validModules = new Set(Object.keys(MODULE_ACTIONS));
  return input.filter(Boolean).map((entry) => {
    const module = String(entry.module || '').toUpperCase();
    if (!validModules.has(module)) return null;
    const allowed = new Set(MODULE_ACTIONS[module]);
    const actions = [...new Set((entry.actions || []).map((a) => String(a).toUpperCase()).filter((a) => allowed.has(a)))];
    if (actions.some((a) => a !== 'VIEW') && !actions.includes('VIEW')) actions.unshift('VIEW');
    return actions.length ? { module, actions } : null;
  }).filter(Boolean);
}
