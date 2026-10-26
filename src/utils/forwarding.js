/** Forwarding is a non-financial movement record, distinct from PreAdvice. */
export const FORWARDING_STATUSES = Object.freeze(['IN_TERMINAL','GATED_OUT']);
export const FORWARDING_SIZES = Object.freeze(['20FT','40FT','45FT']);
export const FORWARDING_TYPES = Object.freeze(['STANDARD','REEFER','TANK','OPEN_TOP','FLAT_RACK','OTHER']);

export function normalizeContainerNumber(value) {
  const number = String(value ?? '').trim().toUpperCase().replace(/\s+/g,'');
  if (!/^[A-Z0-9-]{4,20}$/.test(number)) throw new Error('Container number must contain 4–20 letters, numbers, or hyphens.');
  return number;
}

export function manilaForwardingDate(date, time) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date)) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(String(time))) throw new Error('Gate-in requires a valid date and time.');
  // Philippines has no DST: UTC+08:00. Validate the resulting calendar day, not only Date.parse coercion.
  const instant = new Date(`${date}T${time}:00+08:00`);
  if (!Number.isFinite(instant.getTime()) || new Date(instant.getTime()+8*3600000).toISOString().slice(0,16)!==`${date}T${time}`) throw new Error('Invalid gate-in calendar date.');
  if (instant.getTime()>Date.now()+60000) throw new Error('Gate-in cannot be scheduled in the future for a recorded movement.');
  return instant;
}

export function terminalDuration(gateInAt, gateOutAt = new Date()) {
  const start = new Date(gateInAt).getTime(), end = new Date(gateOutAt).getTime();
  if (!Number.isFinite(start)||!Number.isFinite(end)||end<start) throw new Error('Gate-out must be at or after Gate-in.');
  const elapsedHours = Math.round((end-start)/36000)/100;
  const elapsedDays = Math.round((end-start)/864000)/100;
  return {elapsedHours,elapsedDays,billableDays:Math.max(1,Math.ceil((end-start)/86400000))};
}

export function validateForwardingInput(body={}) {
  const field = (key, max=150) => {
    const value=String(body[key]??'').trim();
    if (!value || value.length>max) throw new Error(`${key} is required (max ${max} characters).`);
    return value;
  };
  const containerNumber=normalizeContainerNumber(body.containerNumber);
  const containerSize=field('containerSize',20).toUpperCase();
  const containerType=field('containerType',30).toUpperCase();
  const loadStatus=field('loadStatus',20).toUpperCase();
  if(!FORWARDING_SIZES.includes(containerSize))throw new Error('Invalid container size.');
  if(!FORWARDING_TYPES.includes(containerType))throw new Error('Invalid container type.');
  if(!['EMPTY','LOADED'].includes(loadStatus))throw new Error('Invalid load status.');
  const gateInDate=field('gateInDate',10),gateInTime=field('gateInTime',5);
  const gateInAt=manilaForwardingDate(gateInDate,gateInTime);
  return {containerNumber,containerSize,containerType,loadStatus,gateInDate,gateInTime,gateInAt,
    shippingLine:field('shippingLine'),truckPlateNumber:field('truckPlateNumber',50),driverName:field('driverName'),
    driverLicense:field('driverLicense',100),hauler:field('hauler')};
}
