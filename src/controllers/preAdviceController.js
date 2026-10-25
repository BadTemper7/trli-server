import PreAdvice from '../models/PreAdvice.js';
import { getIO, emitToAdminModule } from '../socket/index.js';
import { MODULES } from '../constants/permissions.js';
import { createNotification } from '../services/notificationService.js';
import { asyncHandler, ok, AppError } from '../utils/http.js';
import { validateHourlySchedule } from '../utils/scheduleValidation.js';
import { ensureWorkflow, syncWorkflowFromStatus } from '../utils/preAdviceWorkflow.js';

const allowed = [
  'containerNumber',
  'containerSize',
  'containerType',
  'loadStatus',
  'transactionClassification',
  'scheduledGateDateIn',
  'scheduledGateTimeIn',
  'shippingLine',
  'truckPlateNumber',
  'driverName',
  'driverLicenceNumber',
  'hauler',
  'blNumber',
  'vesselVoyage',
  'weight',
  'cargoDescription',
  'remarks',
  'status',
];

const pick = (body) => Object.fromEntries(
  allowed.filter((key) => body[key] !== undefined).map((key) => [key, body[key]]),
);

const fileDocs = (req) => Object.entries(req.files || {}).flatMap(([type, files]) =>
  files.map((file) => ({
    type,
    name: file.originalname,
    storedName: file.filename,
    mimeType: file.mimetype,
    size: file.size,
  })),
);

function validateGateInSchedule(data, existing = null) {
  const date = data.scheduledGateDateIn ?? existing?.scheduledGateDateIn;
  const time = data.scheduledGateTimeIn ?? existing?.scheduledGateTimeIn;
  const error = validateHourlySchedule(date, time, 'Scheduled Gate-in');
  if (error) throw new AppError(error, 400);
}

const ref = async () => {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  const prefix = `PA-${y}${m}${day}-`;
  const last = await PreAdvice.findOne({ bookingReference: { $regex: `^${prefix}` } })
    .sort({ bookingReference: -1 });
  const next = last ? Number(last.bookingReference.split('-').pop()) + 1 : 1;
  return `${prefix}${String(next).padStart(4, '0')}`;
};

export const list = asyncHandler(async (req, res) => {
  const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
  const limit = Math.min(50, Math.max(5, Number.parseInt(req.query.limit, 10) || 10));
  const filter = { company: req.user.company._id };
  const status = String(req.query.status || '').trim().toUpperCase();
  if (['DRAFT', 'SUBMITTED', 'SCHEDULED', 'READY_FOR_GATE_IN', 'GATED_IN', 'COMPLETED', 'CANCELLED'].includes(status)) filter.status = status;
  const search = String(req.query.search || '').trim();
  if (search) {
    const escaped = search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const rx = { $regex: escaped, $options: 'i' };
    filter.$or = [{ bookingReference: rx }, { containerNumber: rx }, { shippingLine: rx }];
  }

  const [items, total, summaryRows] = await Promise.all([
    PreAdvice.find(filter)
      .select('bookingReference containerNumber containerSize containerType scheduledGateDateIn scheduledGateTimeIn shippingLine status workflowStage cancellation createdAt updatedAt')
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean(),
    PreAdvice.countDocuments(filter),
    PreAdvice.aggregate([
      { $match: { company: req.user.company._id } },
      { $group: { _id: null,
        all: { $sum: 1 },
        pending: { $sum: { $cond: [{ $in: ['$status', ['DRAFT', 'SUBMITTED']] }, 1, 0] } },
        yard: { $sum: { $cond: [{ $or: [{ $in: ['$status', ['READY_FOR_GATE_IN', 'GATED_IN']] }, { $in: ['$workflowStage', ['GATE_IN_PAYMENT_SUBMITTED', 'GATE_IN', 'INVENTORY', 'STORAGE']] }] }, 1, 0] } },
        complete: { $sum: { $cond: [{ $or: [{ $eq: ['$status', 'COMPLETED'] }, { $eq: ['$workflowStage', 'CONTAINER_RELEASED'] }] }, 1, 0] } },
      } },
    ]),
  ]);
  const summary = summaryRows[0] || { all: 0, pending: 0, yard: 0, complete: 0 };
  ok(res, {
    items,
    summary: { all: summary.all || 0, pending: summary.pending || 0, yard: summary.yard || 0, complete: summary.complete || 0 },
    pagination: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) },
  });
});

export const detail = asyncHandler(async (req, res) => {
  const item = await PreAdvice.findOne({ _id: req.params.id, company: req.user.company._id });
  if (!item) throw new AppError('Pre-advice not found.', 404);
  const before = item.workflowHistory?.length || 0;
  ensureWorkflow(item);
  if ((item.workflowHistory?.length || 0) !== before) await item.save();
  ok(res, { item });
});

export const create = asyncHandler(async (req, res) => {
  const data = pick(req.body);
  validateGateInSchedule(data);

  data.bookingReference = await ref();
  data.company = req.user.company._id;
  data.createdBy = req.user._id;
  data.status = data.status || 'SUBMITTED';
  data.statusHistory = [{ status: data.status }];
  data.workflowStage = 'BOOKING_SUBMITTED';
  data.workflowHistory = [{ stage: 'BOOKING_SUBMITTED', changedAt: new Date() }];
  data.documents = fileDocs(req);

  const item = await PreAdvice.create(data);

  emitToAdminModule(MODULES.PRE_ADVICE, 'pre-advice:new', {
    id: String(item._id),
    bookingReference: item.bookingReference,
    companyId: String(item.company),
    containerNumber: item.containerNumber,
    status: item.status,
    createdAt: item.createdAt,
  });
  getIO()?.to(`company:${item.company}`).emit('pre-advice:created', item);
  await createNotification({
    company: item.company,
    audience: 'ADMIN',
    type: 'PRE_ADVICE_CREATED',
    title: 'New Pre-advice',
    message: `${item.bookingReference} was submitted.`,
    data: { id: item._id },
  });

  ok(res, { item }, 'Pre-advice created.');
});

export const update = asyncHandler(async (req, res) => {
  const item = await PreAdvice.findOne({ _id: req.params.id, company: req.user.company._id });
  if (!item) throw new AppError('Pre-advice not found.', 404);
  if (item.workflowStage !== 'BOOKING_SUBMITTED' || !['DRAFT', 'SUBMITTED'].includes(item.status)) {
    throw new AppError('Only bookings that are still awaiting Pre-advice approval can be edited by the client.', 409);
  }

  const updates = pick(req.body);
  if (updates.scheduledGateDateIn !== undefined || updates.scheduledGateTimeIn !== undefined) {
    validateGateInSchedule(updates, item);
  }

  const previous = item.status;
  Object.assign(item, updates);

  const newDocs = fileDocs(req);
  if (newDocs.length) item.documents.push(...newDocs);
  if (item.status !== previous) {
    const changedAt = new Date();
    item.statusHistory.push({ status: item.status, changedAt });
    syncWorkflowFromStatus(item, item.status, { changedAt });
  }

  await item.save();

  getIO()?.to(`company:${item.company}`).emit('pre-advice:updated', item);
  emitToAdminModule(MODULES.PRE_ADVICE, 'pre-advice:updated', item);

  if (item.status !== previous) {
    getIO()?.to(`company:${item.company}`).emit('pre-advice:status-updated', {
      id: String(item._id),
      bookingReference: item.bookingReference,
      previousStatus: previous,
      status: item.status,
      updatedAt: item.updatedAt,
      workflowStage: item.workflowStage,
      workflowHistory: item.workflowHistory,
    });
    await createNotification({
      company: item.company,
      audience: 'CLIENT',
      type: 'PRE_ADVICE_STATUS_CHANGED',
      title: 'Booking Status Updated',
      message: `${item.bookingReference}: ${previous} → ${item.status}`,
      data: { id: item._id, status: item.status },
    });
  }

  ok(res, { item }, 'Pre-advice updated.');
});

export const cancel = asyncHandler(async (req, res) => {
  const item = await PreAdvice.findOne({ _id: req.params.id, company: req.user.company._id });
  if (!item) throw new AppError('Pre-advice not found.', 404);
  if (item.status === 'CANCELLED') throw new AppError('This booking is already cancelled.', 409);
  if (item.workflowStage !== 'BOOKING_SUBMITTED' || !['DRAFT', 'SUBMITTED'].includes(item.status)) {
    throw new AppError('This booking can no longer be cancelled because it has already been approved in Pre-advice.', 409);
  }

  const reason = String(req.body?.reason || '').trim().slice(0, 500);
  const now = new Date();
  item.status = 'CANCELLED';
  item.cancellation = { cancelledAt: now, cancelledBy: req.user._id, reason };
  item.statusHistory.push({ status: 'CANCELLED', changedAt: now, note: reason || 'Cancelled by client' });
  await item.save();

  const payload = {
    id: String(item._id),
    _id: String(item._id),
    bookingReference: item.bookingReference,
    status: item.status,
    workflowStage: item.workflowStage,
    cancellation: item.cancellation,
    updatedAt: item.updatedAt,
  };
  getIO()?.to(`company:${item.company}`).emit('pre-advice:status-updated', payload);
  emitToAdminModule(MODULES.PRE_ADVICE, 'pre-advice:cancelled', payload);
  await createNotification({
    company: item.company,
    audience: 'ADMIN',
    type: 'PRE_ADVICE_CANCELLED',
    title: 'Booking Cancelled',
    message: `${item.bookingReference} was cancelled by the client.`,
    data: { id: item._id, reason },
  });

  ok(res, { item }, 'Booking cancelled.');
});
