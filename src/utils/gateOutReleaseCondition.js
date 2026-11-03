import { AppError } from './http.js';

// These options match the printed Gate-out Pass and the existing Gate-in
// inspection vocabulary. A healthy container cannot also be marked damaged.
export const GATE_OUT_RELEASE_CONDITIONS = Object.freeze([
  'GOOD', 'DENTED', 'RUST', 'HOLE', 'DOOR DAMAGE', 'OTHER',
]);

export function parseGateOutReleaseCondition(value) {
  if (!Array.isArray(value)) {
    throw new AppError('Select a Condition Upon Release before approving Gate-out.', 400);
  }
  const conditions = [...new Set(value.map((condition) =>
    typeof condition === 'string' ? condition.trim().toUpperCase() : '',
  ))];
  if (!conditions.length || conditions.some((condition) => !GATE_OUT_RELEASE_CONDITIONS.includes(condition))) {
    throw new AppError('Select at least one valid Condition Upon Release.', 400);
  }
  if (conditions.includes('GOOD') && conditions.length > 1) {
    throw new AppError('GOOD cannot be combined with damage conditions.', 400);
  }
  return conditions;
}

export function parseGateOutReleaseRemarks(value) {
  if (value !== undefined && value !== null && typeof value !== 'string') {
    throw new AppError('Gate-out remarks must be text.', 400);
  }
  const remarks = String(value ?? '').trim();
  if (remarks.length > 800) throw new AppError('Gate-out remarks must be 800 characters or fewer.', 400);
  return remarks;
}