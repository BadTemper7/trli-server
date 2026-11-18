import PaymentType, { PAYMENT_TYPE_CODES } from '../models/PaymentType.js';
import { MODULES } from '../constants/permissions.js';
import { emitToAdminModule, getIO } from '../socket/index.js';
import { auditAdminAction } from '../services/adminAuditService.js';
import { AppError, asyncHandler } from '../utils/http.js';
import { isConfiguredReceivingAccount, isAvailablePaymentChoice } from '../services/paymentMethods.js';

const DEFAULTS = [
  { code: 'CASH', name: 'Cash', requiresReference: false, description: 'Pay in person at the terminal cashier. An administrator records the actual payment.' },
  { code: 'BANK', name: 'Bank', requiresReference: false, description: 'Bank deposit or bank transfer.' },
  { code: 'E_WALLET', name: 'E-wallet', requiresReference: false, description: 'Electronic wallet transfer.' },
  { code: 'GCASH', name: 'GCash', bankName: 'GCash', requiresReference: false, description: 'GCash transfer.' },
  { code: 'MAYA', name: 'Maya', bankName: 'Maya', requiresReference: false, description: 'Maya transfer.' },
];
const clean = (value, max = 300) => String(value ?? '').trim().slice(0, max);

export async function ensureDefaultPaymentTypes() {
  // Keep existing records, even when disabled. Defaults never re-enable a
  // method or overwrite account information selected by an administrator.
  for (const item of DEFAULTS) {
    if (await PaymentType.exists({ code: item.code })) continue;
    await PaymentType.updateOne({ code: item.code }, { $setOnInsert: { ...item, status: 'ACTIVE' } }, { upsert: true });
  }
}

function dto(row) {
  return {
    id: String(row._id), code: row.code, type: row.code === 'CASH' ? 'cash' : row.code === 'BANK' ? 'bank' : 'ewallet',
    name: row.name, status: row.status, requiresReference: Boolean(row.requiresReference),
    description: row.description || '', bankName: row.bankName || '',
    accountName: row.accountName || '', accountNumber: row.accountNumber || '',
    isConfigured: row.code === 'CASH' ? row.status === 'ACTIVE' : isConfiguredReceivingAccount(row),
    createdAt: row.createdAt, updatedAt: row.updatedAt,
  };
}

function normalize(body = {}, current = null) {
  const code = String(body.code ?? current?.code ?? '').trim().toUpperCase();
  if (!PAYMENT_TYPE_CODES.includes(code)) throw new AppError('Select a valid payment type.', 400);
  if (current && current.code !== code) throw new AppError('Payment category cannot be changed after creation.', 400);
  if (!current && code === 'CASH') throw new AppError('Cash is automatically created. Enable or edit its existing record.', 409);
  const defaultRow = DEFAULTS.find((item) => item.code === code);
  const name = clean(body.name ?? current?.name ?? defaultRow?.name, 80);
  if (!name) throw new AppError('Payment account name is required.', 400);
  const status = String(body.status ?? current?.status ?? 'ACTIVE').toUpperCase();
  if (!['ACTIVE', 'INACTIVE'].includes(status)) throw new AppError('Invalid payment type status.', 400);
  const paymentAccount = code === 'CASH' ? { bankName: '', accountName: '', accountNumber: '' } : {
    bankName: clean(body.bankName ?? current?.bankName ?? defaultRow?.bankName, 120),
    accountName: clean(body.accountName ?? current?.accountName, 120),
    accountNumber: clean(body.accountNumber ?? current?.accountNumber, 120),
  };
  if (code !== 'CASH' && status === 'ACTIVE') {
    if (!paymentAccount.bankName) throw new AppError(code === 'BANK' ? 'Bank name is required.' : 'E-wallet name is required.', 400);
    if (!paymentAccount.accountName) throw new AppError('Account owner name is required.', 400);
    if (!paymentAccount.accountNumber) throw new AppError('Account number is required.', 400);
  }
  return { code, name, status, requiresReference: false,
    description: clean(body.description ?? current?.description ?? defaultRow?.description, 300), ...paymentAccount };
}

function notifyChange(event, data) {
  emitToAdminModule(MODULES.PAYMENT_TYPES, event, data);
  // Client selectors refresh on demand. Existing payments retain their own
  // immutable receiving-account snapshots after a method is disabled.
  getIO()?.emit('payment-types:updated', { id: data.id, status: data.status });
}

export const listPaymentTypes = asyncHandler(async (req, res) => {
  await ensureDefaultPaymentTypes();
  const filter = {};
  if (req.query.status) {
    const status = String(req.query.status).toUpperCase();
    if (!['ACTIVE','INACTIVE'].includes(status)) throw new AppError('Invalid status filter.',400);
    filter.status = status;
  }
  const rows = await PaymentType.find(filter).sort({ code: 1, name: 1, _id: 1 }).lean();
  res.json({ success: true, message: 'Payment types loaded.', data: rows.map(dto) });
});

export const listActivePaymentTypes = asyncHandler(async (req, res) => {
  await ensureDefaultPaymentTypes();
  const rows = await PaymentType.find({ status: 'ACTIVE' }).sort({ code: 1, name: 1, _id: 1 }).lean();
  res.json({ success: true, message: 'Available payment types loaded.', data: rows.filter(isAvailablePaymentChoice).map(dto) });
});

export const createPaymentType = asyncHandler(async (req, res) => {
  const input = normalize(req.body);
  // Multiple BANK/E_WALLET/GCASH/MAYA accounts are deliberately permitted.
  let row;
  try { row = await PaymentType.create({ ...input, createdBy: req.admin._id, updatedBy: req.admin._id }); }
  catch (error) {
    if (error?.code === 11000) throw new AppError('The old unique payment-category index may still be installed. Run npm run migrate:payment-types -- --apply after backing up MongoDB.', 409);
    throw error;
  }
  const data = dto(row);
  await auditAdminAction({ performedBy: req.admin._id, action: 'PAYMENT_TYPE_CREATED', changes: { module: 'PAYMENT_TYPES', id: data.id, code: row.code, name: row.name, status: row.status } });
  notifyChange('payment-type:created', data);
  res.status(201).json({ success: true, message: 'Payment account created.', data });
});

export const updatePaymentType = asyncHandler(async (req, res) => {
  const row = await PaymentType.findById(req.params.id);
  if (!row) throw new AppError('Payment type not found.', 404);
  const before = dto(row);
  const input = normalize(req.body, row);
  Object.assign(row, input, { updatedBy: req.admin._id });
  await row.save();
  const data = dto(row);
  await auditAdminAction({ performedBy: req.admin._id, action: 'PAYMENT_TYPE_UPDATED', changes: { module: 'PAYMENT_TYPES', before, after: data } });
  notifyChange('payment-type:updated', data);
  res.json({ success: true, message: 'Payment type updated.', data });
});

export const deletePaymentType = asyncHandler(async (req, res) => {
  const row = await PaymentType.findById(req.params.id);
  if (!row) throw new AppError('Payment type not found.', 404);
  row.status = 'INACTIVE';
  row.updatedBy = req.admin._id;
  await row.save();
  const data = dto(row);
  await auditAdminAction({ performedBy: req.admin._id, action: 'PAYMENT_TYPE_DISABLED', changes: { module: 'PAYMENT_TYPES', id: data.id, code: row.code, name: row.name } });
  notifyChange('payment-type:updated', data);
  res.json({ success: true, message: 'Payment type disabled. Historical payments are preserved.', data });
});
