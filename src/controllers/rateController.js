import Rate, { RATE_NAMES } from '../models/Rate.js';
import { MODULES } from '../constants/permissions.js';
import { emitToAdminModule } from '../socket/index.js';
import { AppError, asyncHandler } from '../utils/http.js';

const cleanString = (value, max = 500) => String(value ?? '').trim().slice(0, max);
const allowed = {
  classification: new Set(['LOCAL', 'INTERNATIONAL']),
  loadStatus: new Set(['EMPTY', 'LOADED']),
  containerSize: new Set(['ALL', '20FT', '40FT']),
  collectionPoint: new Set(['GATE_IN', 'GATE_OUT']),
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
  const amount = Number(body.amount);
  if (!Number.isFinite(amount) || amount <= 0) throw new AppError('Rate amount must be greater than zero.', 400);
  return {
    name,
    classification: enumValue('classification', body.classification),
    loadStatus: enumValue('loadStatus', body.loadStatus),
    containerSize: enumValue('containerSize', body.containerSize, 'ALL'),
    amount: Math.round(amount * 100) / 100,
    collectionPoint: enumValue('collectionPoint', body.collectionPoint),
    status: enumValue('status', body.status, 'ACTIVE'),
    description: cleanString(body.description, 500),
  };
}

function dto(rate) {
  return {
    id: String(rate._id),
    name: normalizeRateName(rate.name, rate),
    classification: rate.classification,
    loadStatus: rate.loadStatus,
    containerSize: rate.containerSize,
    amount: rate.amount,
    collectionPoint: rate.collectionPoint,
    status: rate.status,
    description: rate.description || '',
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
    if (req.query[key]) filter[key] = enumValue(key, req.query[key]);
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
  const rate = await Rate.create({ ...input, createdBy: req.admin._id, updatedBy: req.admin._id });
  const data = dto(rate);
  emitToAdminModule(MODULES.RATE_SETUP, 'rate:created', data);
  res.status(201).json({ success: true, message: 'Rate created.', data });
});

export const updateRate = asyncHandler(async (req, res) => {
  const input = cleanRateInput(req.body);
  const rate = await Rate.findById(req.params.id);
  if (!rate) throw new AppError('Rate not found.', 404);
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
