import {AppError} from './http.js';
export const HISTORIC_STATUSES=['UNKNOWN','BOOKED','GATED_IN','STORED','GATE_OUT_APPROVED','RELEASED','CANCELLED'];
export function validateHistoryChronology(item){
  const {gateIn={},storage={},gateOut={}}=item||{};
  const dates=[['Gate-in',gateIn.actualGateInAt],['Storage',storage.storedAt],['Gate-out approval',gateOut.approvedAt],['Release',gateOut.releasedAt]]
    .filter(([,v])=>v).map(([label,v])=>[label,new Date(v)]);
  if(dates.some(([,value])=>!Number.isFinite(value.getTime())))throw new AppError('Invalid historical timestamp.',400);
  for(let i=1;i<dates.length;i++)if(dates[i][1]<dates[i-1][1])throw new AppError(`${dates[i][0]} cannot predate ${dates[i-1][0]}.`,400);
  if(item?.approvals?.gateIn && (!gateIn.actualGateInAt || gateIn.inspection?.status!=='ACCEPTED')) throw new AppError('Approved historical Gate-in requires a recorded Gate-in time and accepted inspection.',400);
  if(item?.approvals?.gateOut && (!gateOut.approvedAt || !gateIn.actualGateInAt))throw new AppError('Approved historical Gate-out requires approval and recorded Gate-in timestamps.',400);
  if(item?.status==='RELEASED' && !gateOut.releasedAt)throw new AppError('Released status requires an actual release timestamp.',400);
  if(['GATED_IN','STORED','GATE_OUT_APPROVED'].includes(item?.status) && !gateIn.actualGateInAt)throw new AppError('Active container status requires an actual Gate-in timestamp.',400);
}
export function trackingDates(doc){return {gateIn:doc?.gateIn?.actualGateInAt||null,storedAt:doc?.storage?.storedAt||null,gateOutApproval:doc?.gateOut?.approvedAt||null,releasedAt:doc?.gateOut?.releasedAt||null};}
