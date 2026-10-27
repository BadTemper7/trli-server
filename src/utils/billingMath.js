import { requireGateOutAfterGateIn, storageDaysBetween } from './storageDuration.js';

/** All currency amounts are server-computed and rounded to PHP centavos. */
export const money = (value) => Math.round((Number(value) + Number.EPSILON) * 100) / 100;

// Fixed/automatic service rates cannot be silently switched to manual billing.
export const AUTOMATIC_RATE_NAMES = Object.freeze([
  'Gate-in Handling', 'Gate-out Handling', 'Lift On', 'Lift Off', 'Storage', 'Shifting Fee', 'Overtime',
]);
export const OPTIONAL_RATE_NAMES = Object.freeze(['Documentation Fee', 'Congestion Surcharge', 'Other']);
export const ALWAYS_OPTIONAL_RATE_NAMES = Object.freeze(['Documentation Fee', 'Other']);
export const rateBillingMode = (rate) => AUTOMATIC_RATE_NAMES.includes(rate.name)
  ? 'AUTOMATIC'
  : (ALWAYS_OPTIONAL_RATE_NAMES.includes(rate.name) ? 'OPTIONAL' : (rate.billingMode === 'AUTOMATIC' ? 'AUTOMATIC' : 'OPTIONAL'));

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
  const gateInOnly=new Set(['Gate-in Handling','Shifting Fee','Documentation Fee']);
  const gateOutOnly=new Set(['Gate-out Handling','Storage']);
  return rates.filter(r => (!r.collectionPoint || r.collectionPoint===type || (r.name === 'Overtime' && r.collectionPoint === 'BOTH'))
    && !(type==='GATE_IN'&&gateOutOnly.has(r.name))
    && !(type==='GATE_OUT'&&gateInOnly.has(r.name)));
}

/**
 * Matching uses all-dimension wildcard support only for Overtime. A specific
 * override beats a universal price; equally specific Gate-in/Gate-out rates
 * beat a BOTH rate. Exactly one overtime row can be chosen per transaction.
 */
export function pickApplicableRates(rates, booking, collectionPoint = null) {
  const category = booking.containerType === 'REEFER' ? 'REEFER' : 'STANDARD';
  if (category === 'REEFER' && booking.loadStatus === 'LOADED') throw new Error('Loaded reefer pricing is unsupported.');
  const eligible = rates.filter(r => {
    if (r.status !== 'ACTIVE' || (r.effectiveFrom && new Date(r.effectiveFrom) > new Date()) || r.name === 'Total Handling Reference') return false;
    if (r.name === 'Overtime') {
      return (!collectionPoint || r.collectionPoint === collectionPoint || r.collectionPoint === 'BOTH')
        && (!r.classification || r.classification === 'ALL' || r.classification === booking.transactionClassification)
        && (!r.loadStatus || r.loadStatus === 'ALL' || r.loadStatus === booking.loadStatus)
        && (!r.containerCategory || r.containerCategory === 'ALL' || r.containerCategory === category)
        && (!r.containerSize || r.containerSize === 'ALL' || r.containerSize === booking.containerSize);
    }
    return r.classification === booking.transactionClassification
      && r.loadStatus === booking.loadStatus
      && ['ALL', booking.containerSize].includes(r.containerSize || 'ALL')
      && (!r.containerCategory || r.containerCategory === category);
  });
  const chosen = new Map();
  const normalScore = r => (r.containerSize === booking.containerSize ? 2 : 0) + (r.containerCategory === category ? 1 : 0);
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

export function getOptionalRateChoices(rates, booking, type = null) {
  return pickApplicableRates(type?allowedRatesForCollection(rates,type):rates, booking, type)
    .filter(r => rateBillingMode(r) === 'OPTIONAL')
    .map(r => ({ id: String(r._id), name: r.name, description: r.description || '', amount: money(r.amount), taxTreatment: r.taxTreatment || 'TAXABLE' }));
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
    amount: money(rate.amount),
    taxTreatment: rate.taxTreatment || 'TAXABLE',
    basis: rate.name === 'Storage' ? 'PER_CALENDAR_DAY' : rate.name === 'Overtime' ? 'CONDITIONAL_OVERTIME' : 'PER_TRANSACTION',
    isOptional: rateBillingMode(rate) === 'OPTIONAL',
  });
  const automatic = matches.filter(rate => rateBillingMode(rate) === 'AUTOMATIC' && rate.name !== 'Shifting Fee').map(toItem);
  // Preview the Settings fallback when no explicit matching OT rate exists.
  if (!matches.some(r => r.name === 'Overtime') && settings.overtime?.active !== false && Number(settings.overtime?.fee) > 0) {
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

export function optionalPriceLines(rates, booking, selectedRateIds, type = null) {
  const ids = parseOptionalRateIds(selectedRateIds);
  const applicable = pickApplicableRates(type?allowedRatesForCollection(rates,type):rates, booking, type).filter(rate => rateBillingMode(rate) === 'OPTIONAL');
  const chosen = applicable.filter(rate => ids.includes(String(rate._id)));
  if (chosen.length !== ids.length) throw new Error('Selected optional charge is not active or does not apply to this container.');
  return chosen.map(rate => ({
    description: rate.name === 'Other' && rate.description ? rate.description : rate.name,
    quantity: 1, unitRate: money(rate.amount), amount: money(rate.amount),
    taxTreatment: rate.taxTreatment || 'TAXABLE', rateId: String(rate._id), isOptional: true,
  }));
}

export function totalsForLines(lines, vatRate = 12, vatInclusive = false) {
  if (!Number.isFinite(Number(vatRate)) || Number(vatRate) < 0 || Number(vatRate) > 100) throw new Error('Invalid VAT settings.');
  const subtotal = money(lines.reduce((n, line) => n + Number(line.amount || 0), 0));
  const taxableSubtotal = money(lines.filter(line => line.taxTreatment === 'TAXABLE').reduce((n, line) => n + Number(line.amount || 0), 0));
  const vat = money(vatInclusive ? taxableSubtotal * vatRate / (100 + Number(vatRate)) : taxableSubtotal * vatRate / 100);
  return { lines, subtotal, vat, total: money(subtotal + (vatInclusive ? 0 : vat)), taxableSubtotal, vatRate: Number(vatRate), vatInclusive: Boolean(vatInclusive) };
}

/**
 * The invoice snapshot is based on the scheduled Manila time. A material change
 * to the actual physical time requires a separately reviewed adjustment, NEVER
 * an undisclosed mutation of a previously verified/paid invoice.
 */
export function priceLines(rates, booking, type, settings, now = new Date(), optionalRateIds = []) {
  if (!['GATE_IN', 'GATE_OUT'].includes(type)) throw new Error('Invalid billing collection point.');
  const days = type === 'GATE_OUT'
    ? billableStorageDays(booking.gateIn?.actualGateInAt, booking.gateOut?.scheduledDate, booking.gateOut?.scheduledTime, now, 'CALENDAR_DAYS')
    : 1;
  const applicable = pickApplicableRates(allowedRatesForCollection(rates,type), booking, type);
  const lines = applicable.filter(r => !['Overtime', 'Shifting Fee'].includes(r.name) && rateBillingMode(r) === 'AUTOMATIC')
    .map(r => {
      const quantity = r.name === 'Storage' ? days : 1;
      return { description: r.name, quantity, unitRate: money(r.amount), amount: money(quantity * r.amount), taxTreatment: r.taxTreatment || 'TAXABLE', rateId: String(r._id), isOptional: false };
    });
  lines.push(...optionalPriceLines(rates, booking, optionalRateIds, type));

  if (type === 'GATE_IN') {
    // One shifting charge: size-specific rate wins, legacy Settings amount is fallback only.
    const shifting = applicable.find(r => r.name === 'Shifting Fee');
    const fee = Number(shifting ? shifting.amount : (settings.shiftingFee || 0));
    if (fee > 0) lines.push({ description: 'Shifting Fee', quantity: 1, unitRate: money(fee), amount: money(fee), taxTreatment: shifting?.taxTreatment || 'TAXABLE', rateId: shifting ? String(shifting._id) : undefined, isOptional: false });
  }

  const time = type === 'GATE_IN' ? booking.scheduledGateTimeIn : booking.gateOut?.scheduledTime;
  if (overtimeApplies(time, settings.overtime || { active: true, start: '18:00', end: '08:00' })) {
    // A service-specific Rate Setup amount overrides the generic Settings fallback.
    const overtime = applicable.find(r => r.name === 'Overtime');
    const fee = Number(overtime ? overtime.amount : (settings.overtime?.fee || 0));
    if (fee > 0) lines.push({ description: 'Overtime', quantity: 1, unitRate: money(fee), amount: money(fee), taxTreatment: overtime?.taxTreatment || 'TAXABLE', rateId: overtime ? String(overtime._id) : undefined, isOptional: false });
  }

  return totalsForLines(lines, Number(settings.tax?.vatRate ?? 12), Boolean(settings.tax?.vatInclusive));
}
