import PaymentType, { PAYMENT_TYPE_CODES } from '../models/PaymentType.js';
import { MODULES } from '../constants/permissions.js';
import { emitToAdminModule } from '../socket/index.js';
import { auditAdminAction } from '../services/adminAuditService.js';
import { AppError, asyncHandler } from '../utils/http.js';

const DEFAULTS = [
  { code: 'CASH', name: 'Cash', requiresReference: false, description: 'Cash payment collected at the terminal.' },
  { code: 'BANK', name: 'Bank', requiresReference: true, description: 'Bank deposit or bank transfer payment.' },
  { code: 'E_WALLET', name: 'E-wallet', requiresReference: true, description: 'Electronic wallet payment.' },
];

const clean = (value, max = 300) => String(value ?? '').trim().slice(0, max);

export async function ensureDefaultPaymentTypes() {
  for (const item of DEFAULTS) {
    await PaymentType.updateOne(
      { code: item.code },
      { $setOnInsert: { ...item, status: 'ACTIVE' } },
      { upsert: true },
    );
  }
}

function dto(row) {
  return {
    id: String(row._id), code: row.code, name: row.name, status: row.status,
    requiresReference: Boolean(row.requiresReference), description: row.description || '',
    bankName: row.bankName || '', accountName: row.accountName || '', accountNumber: row.accountNumber || '',
    createdAt: row.createdAt, updatedAt: row.updatedAt,
  };
}

function normalize(body = {}, current = null) {
  const code = String(body.code ?? current?.code ?? '').trim().toUpperCase();
  if (!PAYMENT_TYPE_CODES.includes(code)) throw new AppError('Select a valid payment type.', 400);
  const defaultRow = DEFAULTS.find((x) => x.code === code);
  const name = clean(body.name ?? current?.name ?? defaultRow?.name, 80);
  if (!name) throw new AppError('Payment type name is required.', 400);
  const status = String(body.status ?? current?.status ?? 'ACTIVE').toUpperCase();
  if (!['ACTIVE', 'INACTIVE'].includes(status)) throw new AppError('Invalid payment type status.', 400);
  const requiresReference = code === 'CASH' ? false : body.requiresReference === undefined ? Boolean(current?.requiresReference ?? true) : Boolean(body.requiresReference);
  const paymentAccount = code === 'CASH' ? { bankName: '', accountName: '', accountNumber: '' } : {
    bankName: clean(body.bankName ?? current?.bankName, 120),
    accountName: clean(body.accountName ?? current?.accountName, 120),
    accountNumber: clean(body.accountNumber ?? current?.accountNumber, 120),
  };
  if (code !== 'CASH') {
    if (!paymentAccount.bankName) throw new AppError(code === 'BANK' ? 'Bank name is required.' : 'E-wallet name is required.', 400);
    if (!paymentAccount.accountName) throw new AppError('Account owner name is required.', 400);
    if (!paymentAccount.accountNumber) throw new AppError('Account number is required.', 400);
  }
  return { code, name, status, requiresReference, description: clean(body.description ?? current?.description, 300), ...paymentAccount };
}

export const listPaymentTypes = asyncHandler(async (req, res) => {
  await ensureDefaultPaymentTypes();
  const filter = {};
  if (req.query.status) filter.status = String(req.query.status).toUpperCase();
  const rows = await PaymentType.find(filter).sort({ code: 1 }).lean();
  res.json({ success: true, message: 'Payment types loaded.', data: rows.map(dto) });
});

export const listActivePaymentTypes = asyncHandler(async (req, res) => {
  await ensureDefaultPaymentTypes();
  const rows = await PaymentType.find({ status: 'ACTIVE' }).sort({ code: 1 }).lean();
  res.json({ success: true, message: 'Active payment types loaded.', data: rows.map(dto) });
});

export const createPaymentType = asyncHandler(async (req, res) => {
  const input = normalize(req.body);
  const exists = await PaymentType.findOne({ code: input.code });
  if (exists) throw new AppError('This payment type already exists. Edit the existing record instead.', 409);
  const row = await PaymentType.create({ ...input, createdBy: req.admin._id, updatedBy: req.admin._id });
  const data = dto(row);
  await auditAdminAction({ performedBy: req.admin._id, action: 'PAYMENT_TYPE_CREATED', changes: { code: row.code, name: row.name, status: row.status } });
  emitToAdminModule(MODULES.PAYMENT_TYPES, 'payment-type:created', data);
  res.status(201).json({ success: true, message: 'Payment type created.', data });
});

export const updatePaymentType = asyncHandler(async (req, res) => {
  const row = await PaymentType.findById(req.params.id);
  if (!row) throw new AppError('Payment type not found.', 404);
  const input = normalize(req.body, row);
  if (input.code !== row.code) {
    const duplicate = await PaymentType.exists({ code: input.code, _id: { $ne: row._id } });
    if (duplicate) throw new AppError('This payment type already exists.', 409);
  }
  Object.assign(row, input, { updatedBy: req.admin._id });
  await row.save();
  const data = dto(row);
  await auditAdminAction({ performedBy: req.admin._id, action: 'PAYMENT_TYPE_UPDATED', changes: { code: row.code, name: row.name, status: row.status, requiresReference: row.requiresReference, bankName: row.bankName, accountName: row.accountName } });
  emitToAdminModule(MODULES.PAYMENT_TYPES, 'payment-type:updated', data);
  res.json({ success: true, message: 'Payment type updated.', data });
});

export const deletePaymentType = asyncHandler(async (req, res) => {
  const row = await PaymentType.findById(req.params.id);
  if (!row) throw new AppError('Payment type not found.', 404);
  row.status = 'INACTIVE';
  row.updatedBy = req.admin._id;
  await row.save();
  const data = dto(row);
  await auditAdminAction({ performedBy: req.admin._id, action: 'PAYMENT_TYPE_DISABLED', changes: { code: row.code, name: row.name } });
  emitToAdminModule(MODULES.PAYMENT_TYPES, 'payment-type:updated', data);
  res.json({ success: true, message: 'Payment type disabled.', data });
});
