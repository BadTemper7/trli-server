import { AppError } from './http.js';

const CONDITIONS = ['GOOD', 'DENTED', 'RUST', 'HOLE', 'DOOR DAMAGE', 'OTHER'];

/** Shared validation for inspection rejection and single-action physical Gate-in. */
export function parseGateInInspection(input, inspectedBy, inspectedAt = new Date()) {
  const status = String(input?.status || '').trim().toUpperCase();
  if (!['ACCEPTED','REJECTED'].includes(status)) throw new AppError('Inspection status must be ACCEPTED or REJECTED.',400);
  const sealNumber = String(input?.sealNumber||'').trim().slice(0,120);
  if (!sealNumber) throw new AppError('Seal number is required.',400);
  if (typeof input?.sealIntact !== 'boolean') throw new AppError('Seal intact selection is required.',400);
  const raw = Array.isArray(input?.containerCondition) ? input.containerCondition : [input?.containerCondition];
  const containerCondition=[...new Set(raw.map(value=>String(value||'').trim().toUpperCase()).filter(Boolean))];
  if (!containerCondition.length) throw new AppError('Select at least one container condition.',400);
  if (containerCondition.some(value=>!CONDITIONS.includes(value))) throw new AppError('Select valid container conditions.',400);
  if (containerCondition.includes('GOOD')&&containerCondition.length>1) throw new AppError('GOOD cannot be combined with damage conditions.',400);
  const rejectionReason=String(input?.rejectionReason||'').trim().slice(0,1000);
  if(status==='REJECTED'&&!rejectionReason)throw new AppError('Rejection reason is required when inspection is rejected.',400);
  return {
    status,sealNumber,sealIntact:input.sealIntact,containerCondition,
    remarks:String(input?.remarks||'').trim().slice(0,1000),
    rejectionReason:status==='REJECTED'?rejectionReason:'',
    inspectedAt,inspectedBy,
  };
}
