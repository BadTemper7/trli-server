import { requireGateOutAfterGateIn, storageDaysBetween } from './storageDuration.js';

/** All currency amounts are server-computed and rounded to PHP centavos. */
export const money = (value) => Math.round((Number(value) + Number.EPSILON) * 100) / 100;

// Rate application (automatic vs optional) is configurable for every service.
export const AUTOMATIC_RATE_NAMES = Object.freeze(['Gate-in Handling','Gate-out Handling','Lift On','Lift Off','Storage','Shifting Fee','Overtime']);
export const OPTIONAL_RATE_NAMES = Object.freeze(['Documentation Fee','Congestion Surcharge','Other']);
export const ALWAYS_OPTIONAL_RATE_NAMES = Object.freeze([]);
export const rateBillingMode = rate => rate.billingMode === 'OPTIONAL' ? 'OPTIONAL' : (rate.billingMode === 'AUTOMATIC' ? 'AUTOMATIC' : (OPTIONAL_RATE_NAMES.includes(rate.name) ? 'OPTIONAL' : 'AUTOMATIC'));

export function overtimeApplies(time, settings = {}) {
  if (settings.active === false || !time) return false;
  const { start = '18:00', end = '08:00' } = settings;
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(start) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(end) || start === end) return false;
  // Overnight: 18:00 ... 23:59 and 00:00 ... 07:59 (Asia/Manila time).
  return start < end ? time >= start && time < end : time >= start || time < end;
}

export function billableStorageDays(actualGateInAt, scheduledDate, scheduledTime, asOf = new Date(), rounding = 'CALENDAR_DAYS') {
  if (!actualGateInAt) return 0;
  const gateOutAt = scheduledDate && scheduledTime
    ? requireGateOutAfterGateIn(actualGateInAt, scheduledDate, scheduledTime)
    : asOf;
  return storageDaysBetween(actualGateInAt, gateOutAt, rounding);
}

export function allowedRatesForCollection(rates, type) {
  return rates.filter(rate=>rate.collectionPoint===type || rate.collectionPoint==='BOTH' || !rate.collectionPoint);
}

/**
 * Matching uses all-dimension wildcard support only for Overtime. A specific
 * override beats a universal price; equally specific Gate-in/Gate-out rates
 * beat a BOTH rate. Exactly one overtime row can be chosen per transaction.
 */
export function pickApplicableRates(rates, booking, collectionPoint = null) {
  const category = booking.containerType === 'REEFER' ? 'REEFER' : 'STANDARD';
  const eligible = rates.filter(r => {
    if (r.status !== 'ACTIVE' || (r.effectiveFrom && new Date(r.effectiveFrom) > new Date()) || r.name === 'Total Handling Reference') return false;
    if (r.name === 'Overtime') {
      return (!collectionPoint || r.collectionPoint === collectionPoint || r.collectionPoint === 'BOTH')
        && (!r.classification || r.classification === 'ALL' || r.classification === booking.transactionClassification)
        && (!r.loadStatus || r.loadStatus === 'ALL' || r.loadStatus === booking.loadStatus)
        && (!r.containerCategory || r.containerCategory === 'ALL' || r.containerCategory === category)
        && (!r.containerSize || r.containerSize === 'ALL' || r.containerSize === booking.containerSize);
    }
    return (!collectionPoint || r.collectionPoint === collectionPoint || r.collectionPoint === 'BOTH')
      && r.classification === booking.transactionClassification
      && r.loadStatus === booking.loadStatus
      && ['ALL', booking.containerSize].includes(r.containerSize || 'ALL')
      && (!r.containerCategory || r.containerCategory === category);
  });
  const chosen = new Map();
  const normalScore = r => (r.containerSize === booking.containerSize ? 20 : 0) + (r.containerCategory === category ? 10 : 0) + (collectionPoint && r.collectionPoint===collectionPoint ? 1 : 0);
  const overtimeScore = r => {
    const specifics = [r.classification === booking.transactionClassification, r.containerCategory === category, r.loadStatus === booking.loadStatus, r.containerSize === booking.containerSize];
    const specificity = specifics.filter(Boolean).length;
    const collectionBonus = collectionPoint && r.collectionPoint === collectionPoint ? 1 : 0;
    return specificity * 100 + collectionBonus * 16 + (specifics[0] ? 8 : 0) + (specifics[1] ? 4 : 0) + (specifics[2] ? 2 : 0) + (specifics[3] ? 1 : 0);
  };
  for (const rate of eligible) {
    const key = rate.name;
    const prev = chosen.get(key);
    const score = key === 'Overtime' ? overtimeScore(rate) : normalScore(rate);
    const prevScore = !prev ? -1 : key === 'Overtime' ? overtimeScore(prev) : normalScore(prev);
    if (score > prevScore) chosen.set(key, rate);
    else if (score === prevScore && prev && String(rate._id) !== String(prev._id)) throw new Error(`Duplicate active rate configured: ${rate.name}.`);
  }
  return [...chosen.values()];
}

/** A configured service takes precedence over the old Settings fallback even
 * when it is collected at the OTHER gate. Respect its collection-point choice.
 */
export function hasConfiguredService(rates, booking, name) {
  return rates.some(rate => rate.name === name && pickApplicableRates([rate],booking).length > 0);
}

export function getOptionalRateChoices(rates, booking, type = null) {
  return pickApplicableRates(type?allowedRatesForCollection(rates,type):rates, booking, type)
    .filter(r => rateBillingMode(r) === 'OPTIONAL')
    .map(r => ({ id: String(r._id), name: r.name, description: r.description || '', amount: r.pricingMode==='MANUAL'?(booking.manualRateAmounts?.get?.(String(r._id))??booking.manualRateAmounts?.[String(r._id)]??null):money(r.amount), pricingMode:r.pricingMode||'FIXED', collectionPoint:r.collectionPoint, taxTreatment: r.taxTreatment || 'TAXABLE' }));
}

/**
 * Client-facing preview of exactly the currently applicable Gate-out tariff
 * entries.  This is NOT an invoice or payment amount: quantities (especially
 * calendar-day storage and conditional overtime) are calculated by priceLines
 * only after a valid scheduled Gate-out time has been selected.
 */
export function gateOutTransactionPreview(rates, booking, settings = {}) {
  const matches = pickApplicableRates(allowedRatesForCollection(rates, 'GATE_OUT'), booking, 'GATE_OUT').filter(rate => settings.overtime?.active !== false || rate.name !== 'Overtime');
  const toItem = rate => ({
    id: String(rate._id),
    name: rate.name === 'Other' && rate.description ? rate.description : rate.name,
    description: rate.description || '',
    amount: money(rate.amount), pricingMode:rate.pricingMode||'FIXED', collectionPoint:rate.collectionPoint,
    taxTreatment: rate.taxTreatment || 'TAXABLE',
    basis: rate.name === 'Storage' ? 'PER_CALENDAR_DAY' : rate.name === 'Overtime' ? 'CONDITIONAL_OVERTIME' : 'PER_TRANSACTION',
    isOptional: rateBillingMode(rate) === 'OPTIONAL',
  });
  const automatic = matches.filter(rate => rateBillingMode(rate) === 'AUTOMATIC').map(toItem);
  // Preview the Settings fallback when no explicit matching OT rate exists.
  if (!hasConfiguredService(rates, booking, 'Overtime') && settings.overtime?.active !== false && Number(settings.overtime?.fee) > 0) {
    automatic.push({ id: 'settings-overtime', name: 'Overtime', description: `Configured universal overtime (${settings.overtime.start || '18:00'}-${settings.overtime.end || '08:00'} Asia/Manila)`, amount: money(settings.overtime.fee), taxTreatment: 'TAXABLE', basis: 'CONDITIONAL_OVERTIME', isOptional: false });
  }
  const optional = matches.filter(rate => rateBillingMode(rate) === 'OPTIONAL').map(toItem);
  return { automatic, optional, hasBaseCharge: automatic.some(item => item.basis !== 'CONDITIONAL_OVERTIME'), hasStorageRate: automatic.some(item => item.basis === 'PER_CALENDAR_DAY') };
}

export function parseOptionalRateIds(value) {
  let values = value;
  if (typeof values === 'string') {
    try { const parsed = JSON.parse(values); values = Array.isArray(parsed) ? parsed : values.split(','); }
    catch { values = values.split(','); }
  }
  if (values == null || values === '') return [];
  if (!Array.isArray(values) || values.length > 20) throw new Error('Invalid optional charge selection.');
  const ids = values.map(v => String(v).trim()).filter(Boolean);
  if (ids.some(id => !/^[a-f\d]{24}$/i.test(id)) || new Set(ids).size !== ids.length) throw new Error('Invalid or repeated optional rate ID.');
  return ids;
}

/** Resolve a transaction-only manual amount. Never accept a client-supplied rate override. */
export function resolveRateAmount(rate, manualAmounts = {}) {
  if (rate.pricingMode !== 'MANUAL') return money(rate.amount);
  const value = manualAmounts?.[String(rate._id)] ?? manualAmounts?.get?.(String(rate._id));
  if (value === undefined || value === null || value === '') throw new Error(`Manual price is required for ${rate.name}; ask an authorized administrator to set it before billing.`);
  const amount=Number(value);
  if (!Number.isFinite(amount) || amount<=0 || Math.abs(amount*100-Math.round(amount*100))>0.0001) throw new Error(`Invalid manual price for ${rate.name}.`);
  return money(amount);
}

export function stageCharge(rate, fullAmount, type, previousAmount = null) {
  const total=money(fullAmount);
  if(rate.collectionPoint!=='BOTH')return total;
  const mode=rate.allocationMode||'PERCENTAGE';
  const first=mode==='FIXED'
    ? money(Number(rate.gateInAllocation??Number(rate.amount)/2)* (Number(rate.amount)>0 ? total/Number(rate.amount) : 1))
    : money(total*Number(rate.gateInAllocation??50)/100);
  if(type==='GATE_IN')return first;
  // A previously collected gate-in portion is authoritative even if actual Storage days change.
  // A service selected only at Gate-out collects 100% here, never drops the first portion.
  return money(Math.max(0,total-(previousAmount===null?0:Number(previousAmount))));
}

export function optionalPriceLines(rates, booking, selectedRateIds, type = null, options={}) {
  const ids = parseOptionalRateIds(selectedRateIds);
  const applicable = pickApplicableRates(type?allowedRatesForCollection(rates,type):rates, booking, type).filter(rate => rateBillingMode(rate) === 'OPTIONAL');
  const prior = options.previousInvoice?.lines || [];
  const carried = type === 'GATE_OUT' ? prior.filter(line=>line.isOptional && line.collectionPoint==='BOTH').map(line=>String(line.rateId)) : [];
  const chosen = applicable.filter(rate => ids.includes(String(rate._id)) || carried.includes(String(rate._id)));
  if (chosen.length !== new Set([...ids,...carried.filter(id=>applicable.some(r=>String(r._id)===id))]).size) throw new Error('Selected optional charge is not active or does not apply to this container.');
  return chosen.map(rate => makeRateLine(rate,booking,type,options,true));
}

function makeRateLine(rate,booking,type,options,isOptional=false) {
  const quantity = rate.name==='Storage' && type==='GATE_OUT' ? Number(options.days||1) : 1;
  const earlier=(options.previousInvoice?.lines||[]).find(line=>String(line.rateId)===String(rate._id));
  const unitRate=earlier?.pricingMode==='MANUAL' && rate.pricingMode==='MANUAL' && earlier?.fullAmount
    ? money(earlier.fullAmount/Number(earlier.quantity||1)) : resolveRateAmount(rate,options.manualAmounts);
  const fullAmount=money(quantity*unitRate);
  const amount=stageCharge(rate,fullAmount,type,earlier?.amount??null);
  return {description:rate.name==='Other'&&rate.description?rate.description:rate.name,quantity,unitRate,fullAmount,amount,
    taxTreatment:rate.taxTreatment||'TAXABLE',rateId:String(rate._id),isOptional,
    pricingMode:rate.pricingMode||'FIXED',collectionPoint:rate.collectionPoint};
}

/** New rates are VAT-exclusive. The explicit legacy `vatInclusive` flag is
 * accepted only when recalculating an existing, previously issued invoice.
 * NEVER infer the tax basis from SiteSettings or charge tax to exempt rows.
 */
export function totalsForLines(lines, vatRate = 12, vatInclusive = false) {
  if (!Number.isFinite(Number(vatRate)) || Number(vatRate) < 0 || Number(vatRate) > 100) throw new Error('Invalid VAT settings.');
  const taxableSubtotal=money(lines.filter(line => (line.taxTreatment||'TAXABLE')==='TAXABLE').reduce((n,line)=>n+Number(line.amount||0),0));
  const nonVatableSales=money(lines.filter(line => (line.taxTreatment||'TAXABLE')!=='TAXABLE').reduce((n,line)=>n+Number(line.amount||0),0));
  const subtotal=money(taxableSubtotal+nonVatableSales);
  const vat=money(vatInclusive ? taxableSubtotal*Number(vatRate)/(100+Number(vatRate)) : taxableSubtotal*Number(vatRate)/100);
  const vatableSales=money(taxableSubtotal-(vatInclusive?vat:0));
  const total=money(subtotal+(vatInclusive?0:vat));
  return {lines,subtotal,vat,total,subtotalWithVat:total,taxableSubtotal,vatableSales,nonVatableSales,vatRate:Number(vatRate),vatInclusive:Boolean(vatInclusive)};
}

/**
 * The invoice snapshot is based on the scheduled Manila time. A material change
 * to the actual physical time requires a separately reviewed adjustment, NEVER
 * an undisclosed mutation of a previously verified/paid invoice.
 */
export function priceLines(rates, booking, type, settings, now = new Date(), optionalRateIds = [], options={}) {
  if (!['GATE_IN','GATE_OUT'].includes(type)) throw new Error('Invalid billing collection point.');
  const days=type==='GATE_OUT'
    ? billableStorageDays(booking.gateIn?.actualGateInAt,booking.gateOut?.scheduledDate,booking.gateOut?.scheduledTime,now,'CALENDAR_DAYS') : 1;
  const applicable=pickApplicableRates(allowedRatesForCollection(rates,type),booking,type);
  const context={...options,days,manualAmounts:options.manualAmounts||booking.manualRateAmounts||{}};
  const lines=applicable.filter(r=>!['Overtime','Shifting Fee'].includes(r.name)&&rateBillingMode(r)==='AUTOMATIC')
    .map(r=>makeRateLine(r,booking,type,context));
  lines.push(...optionalPriceLines(rates,booking,optionalRateIds,type,context));
  const shifting=applicable.find(r=>r.name==='Shifting Fee');
  // Settings fallback is Gate-in only. An explicit Rate Setup row follows its own collection stage.
  if(shifting && rateBillingMode(shifting)==='AUTOMATIC') lines.push(makeRateLine(shifting,booking,type,context));
  else if(type==='GATE_IN'&&!hasConfiguredService(rates,booking,'Shifting Fee')&&Number(settings.shiftingFee||0)>0) {
    const fee=money(settings.shiftingFee);
    lines.push({description:'Shifting Fee',quantity:1,unitRate:fee,fullAmount:fee,amount:fee,taxTreatment:'TAXABLE',isOptional:false,collectionPoint:'GATE_IN'});
  }
  const time=type==='GATE_IN'?booking.scheduledGateTimeIn:booking.gateOut?.scheduledTime;
  if(overtimeApplies(time,settings.overtime||{active:true,start:'18:00',end:'08:00'})){
    const overtime=applicable.find(r=>r.name==='Overtime');
    if(overtime&&rateBillingMode(overtime)==='AUTOMATIC')lines.push(makeRateLine(overtime,booking,type,context));
    else if(!hasConfiguredService(rates,booking,'Overtime')&&Number(settings.overtime?.fee||0)>0){
      const fee=money(settings.overtime.fee);
      lines.push({description:'Overtime',quantity:1,unitRate:fee,fullAmount:fee,amount:fee,taxTreatment:'TAXABLE',isOptional:false,collectionPoint:type});
    }
  }
  // New invoices use the configured net rates, plus VAT on TAXABLE lines.
  // Legacy invoice corrections must explicitly pass the original tax basis.
  const useHistoricalInclusive = options.existingInvoiceVatInclusive === true;
  return totalsForLines(lines.filter(line=>line.amount>0),Number(settings.tax?.vatRate??12),useHistoricalInclusive);
}
