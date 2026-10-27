import Rate, { RATE_NAMES } from '../models/Rate.js';
import { MODULES } from '../constants/permissions.js';
import { emitToAdminModule } from '../socket/index.js';
import { AppError, asyncHandler } from '../utils/http.js';
import { AUTOMATIC_RATE_NAMES, ALWAYS_OPTIONAL_RATE_NAMES, rateBillingMode } from '../utils/billingMath.js';

const cleanString = (value, max = 500) => String(value ?? '').trim().slice(0, max);
const allowed = {
  classification: new Set(['LOCAL', 'INTERNATIONAL', 'ALL']),
  loadStatus: new Set(['EMPTY', 'LOADED', 'ALL']),
  containerSize: new Set(['ALL', '20FT', '40FT']),
  collectionPoint: new Set(['GATE_IN', 'GATE_OUT', 'BOTH']),
  status: new Set(['ACTIVE', 'INACTIVE']),
};

const normalizeRateName = (value, legacy = {}) => {
  const raw = cleanString(value, 120);
  const direct = RATE_NAMES.find((name) => name.toLowerCase() === raw.toLowerCase());
  if (direct) return direct;

  const text = raw.toUpperCase().replace(/[-_]+/g, ' ');
  if (text.includes('LIFT ON')) return 'Lift On';
  if (text.includes('LIFT OFF')) return 'Lift Off';
  if (text.includes('CONGESTION')) return 'Congestion Surcharge';
  if (text.includes('TOTAL HANDLING')) return 'Total Handling Reference';
  if (text.includes('STORAGE')) return 'Storage';
  if (text.includes('DOCUMENT')) return 'Documentation Fee';
  if (text.includes('SHIFT')) return 'Shifting Fee';
  if (text.includes('OVERTIME') || text === 'OT') return 'Overtime';

  const legacyType = String(legacy.serviceType ?? legacy.rateType ?? legacy.type ?? '').toUpperCase();
  if (legacyType === 'LIFT_ON') return 'Lift On';
  if (legacyType === 'LIFT_OFF') return 'Lift Off';
  if (legacyType === 'STORAGE') return 'Storage';
  return 'Other';
};

function enumValue(name, value, fallback) {
  const normalized = String(value ?? fallback ?? '').trim().toUpperCase();
  if (!allowed[name].has(normalized)) throw new AppError(`Invalid ${name}.`, 400);
  return normalized;
}

function cleanRateInput(body = {}) {
  const name = normalizeRateName(body.name, body);
  if (!RATE_NAMES.includes(name)) throw new AppError('Select a valid rate name.', 400);
  const category = String(body.containerCategory || (name === 'Overtime' ? 'ALL' : 'STANDARD')).toUpperCase();
  const tax = String(body.taxTreatment || 'TAXABLE').toUpperCase();
  if (!['STANDARD','REEFER','ALL'].includes(category) || !['TAXABLE','EXEMPT','ZERO_RATED'].includes(tax)) throw new AppError('Invalid container category or tax treatment.',400);
  const classification = enumValue('classification', body.classification, name === 'Overtime' ? 'ALL' : undefined);
  const loadStatus = enumValue('loadStatus', body.loadStatus, name === 'Overtime' ? 'ALL' : undefined);
  const collectionPoint = enumValue('collectionPoint', body.collectionPoint, name === 'Overtime' ? 'BOTH' : undefined);
  if (name !== 'Overtime' && [classification,loadStatus,category,collectionPoint].includes('ALL')) throw new AppError('All classifications, categories, and load statuses are supported only for Overtime.',400);
  if (name !== 'Overtime' && collectionPoint === 'BOTH') throw new AppError('Collect at both Gate-in and Gate-out is supported only for Overtime.',400);
  if (category === 'REEFER' && loadStatus === 'LOADED') throw new AppError('Loaded reefer rates are unsupported.',400);
  const billingMode = AUTOMATIC_RATE_NAMES.includes(name) ? 'AUTOMATIC' : ALWAYS_OPTIONAL_RATE_NAMES.includes(name) ? 'OPTIONAL' : String(body.billingMode || 'OPTIONAL').toUpperCase();
  if (!['AUTOMATIC', 'OPTIONAL'].includes(billingMode)) throw new AppError('Invalid charge mode.',400);
  if (['Documentation Fee','Shifting Fee','Gate-in Handling'].includes(name) && collectionPoint !== 'GATE_IN') throw new AppError(`${name} is collected at Gate-in.`,400);
  if (name === 'Gate-out Handling' && collectionPoint !== 'GATE_OUT') throw new AppError('Gate-out Handling is collected at Gate-out.',400);
  if (name === 'Storage' && collectionPoint !== 'GATE_OUT') throw new AppError('Storage is collected at Gate-out.',400);
  if (name === 'Total Handling Reference') throw new AppError('Total Handling Reference cannot be created as a billable rate.',400);
  if(body.effectiveFrom && (!/^\d{4}-\d{2}-\d{2}$/.test(String(body.effectiveFrom)) || Number.isNaN(new Date(`${body.effectiveFrom}T00:00:00+08:00`).getTime())))throw new AppError('Effective date must be valid.',400);
  const amount = Number(body.amount);
  if (!Number.isFinite(amount) || amount <= 0) throw new AppError('Rate amount must be greater than zero.', 400);
  return {
    name,
    containerCategory:category,
    taxTreatment:tax,
    billingMode,
    classification,
    loadStatus,
    containerSize: enumValue('containerSize', body.containerSize, 'ALL'),
    amount: Math.round(amount * 100) / 100,
    collectionPoint,
    status: enumValue('status', body.status, 'ACTIVE'),
    description: cleanString(body.description, 500),
    effectiveFrom:body.effectiveFrom?new Date(`${body.effectiveFrom}T00:00:00+08:00`):null,
  };
}

function dto(rate) {
  return {
    id: String(rate._id),
    name: normalizeRateName(rate.name, rate),
    classification: rate.classification,
    containerCategory:rate.containerCategory||'STANDARD',
    taxTreatment:rate.taxTreatment||'TAXABLE',
    billingMode: rateBillingMode(rate),
    loadStatus: rate.loadStatus,
    containerSize: rate.containerSize,
    amount: rate.amount,
    collectionPoint: rate.collectionPoint,
    status: rate.status,
    description: rate.description || '',
    effectiveFrom: rate.effectiveFrom,
    createdAt: rate.createdAt,
    updatedAt: rate.updatedAt,
  };
}

export const listRates = asyncHandler(async (req, res) => {
  const filter = {};
  const q = cleanString(req.query.search, 120);
  if (q) filter.$or = [
    { name: { $regex: q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' } },
    { description: { $regex: q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' } },
  ];
  if (req.query.name) {
    const requestedName = normalizeRateName(req.query.name);
    filter.name = requestedName;
  }
  for (const key of ['classification','loadStatus','containerSize','collectionPoint','status']) {
    if (!req.query[key]) continue;
    const selected = enumValue(key, req.query[key]);
    filter[key] = key === 'collectionPoint' && selected !== 'BOTH' ? { $in: [selected, 'BOTH'] } : selected;
  }
  const rows = await Rate.find(filter).sort({ status: 1, name: 1, createdAt: -1 }).lean();
  res.json({ success: true, message: 'Rates loaded.', data: rows.map(dto) });
});

export const getRate = asyncHandler(async (req, res) => {
  const rate = await Rate.findById(req.params.id).lean();
  if (!rate) throw new AppError('Rate not found.', 404);
  res.json({ success: true, message: 'Rate loaded.', data: dto(rate) });
});

export const createRate = asyncHandler(async (req, res) => {
  const input = cleanRateInput(req.body);
  if(input.status==='ACTIVE'&&await Rate.exists({name:input.name,classification:input.classification,containerCategory:input.containerCategory,loadStatus:input.loadStatus,containerSize:input.containerSize,collectionPoint:input.collectionPoint,status:'ACTIVE'}))throw new AppError('An active rate for this exact category and size already exists.',409);
  const rate = await Rate.create({ ...input, createdBy: req.admin._id, updatedBy: req.admin._id });
  const data = dto(rate);
  emitToAdminModule(MODULES.RATE_SETUP, 'rate:created', data);
  res.status(201).json({ success: true, message: 'Rate created.', data });
});

export const updateRate = asyncHandler(async (req, res) => {
  const input = cleanRateInput(req.body);
  const rate = await Rate.findById(req.params.id);
  if (!rate) throw new AppError('Rate not found.', 404);
  if(input.status==='ACTIVE'&&await Rate.exists({_id:{$ne:rate._id},name:input.name,classification:input.classification,containerCategory:input.containerCategory,loadStatus:input.loadStatus,containerSize:input.containerSize,collectionPoint:input.collectionPoint,status:'ACTIVE'}))throw new AppError('An active rate already exists for this category and size.',409);
  Object.assign(rate, input, { updatedBy: req.admin._id });
  rate.set('serviceType', undefined, { strict: false });
  await rate.save();
  const data = dto(rate);
  emitToAdminModule(MODULES.RATE_SETUP, 'rate:updated', data);
  res.json({ success: true, message: 'Rate updated.', data });
});

export const deleteRate = asyncHandler(async (req, res) => {
  const rate = await Rate.findById(req.params.id);
  if (!rate) throw new AppError('Rate not found.', 404);
  await rate.deleteOne();
  const data = { id: String(rate._id) };
  emitToAdminModule(MODULES.RATE_SETUP, 'rate:deleted', data);
  res.json({ success: true, message: 'Rate deleted.', data });
});

export const importRates = asyncHandler(async (req, res) => {
  const rows = Array.isArray(req.body?.rates) ? req.body.rates.slice(0, 200) : [];
  if (!rows.length) return res.json({ success: true, message: 'No local rates to migrate.', data: { imported: 0, skipped: 0 } });
  let imported = 0;
  let skipped = 0;
  for (const raw of rows) {
    let input;
    try { input = cleanRateInput(raw); } catch { skipped += 1; continue; }
    const exists = await Rate.exists({
      name: input.name,
      classification: input.classification,
      loadStatus: input.loadStatus,
      containerSize: input.containerSize,
      collectionPoint: input.collectionPoint,
      amount: input.amount,
    });
    if (exists) { skipped += 1; continue; }
    await Rate.create({ ...input, createdBy: req.admin._id, updatedBy: req.admin._id });
    imported += 1;
  }
  if (imported) emitToAdminModule(MODULES.RATE_SETUP, 'rate:bulk-imported', { imported });
  res.json({ success: true, message: 'Local Rate Setup migration completed.', data: { imported, skipped } });
});
