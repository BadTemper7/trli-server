export function canPrintGateIn(item){
  return Boolean(item?.gateIn?.actualGateInAt && item?.gateIn?.inspection?.status==='ACCEPTED');
}
export function canPrintGateOut(item){
  return Boolean(['APPROVED','RELEASED'].includes(item?.gateOut?.approvalStatus) && item?.gateOut?.approvedAt);
}
export function canPrintHistorical(item,type){
  if(item?.deletedAt)return false;
  if(type==='GATE_IN')return Boolean(item?.approvals?.gateIn===true && item?.gateIn?.actualGateInAt && item?.gateIn?.inspection?.status==='ACCEPTED');
  if(type==='GATE_OUT')return Boolean(item?.approvals?.gateOut===true && item?.gateOut?.approvedAt && item?.gateIn?.actualGateInAt);
  return false;
}
