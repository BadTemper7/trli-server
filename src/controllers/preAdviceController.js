import PreAdvice from '../models/PreAdvice.js';
import mongoose from 'mongoose';
import { getIO, emitToAdminModule } from '../socket/index.js';
import { MODULES } from '../constants/permissions.js';
import { createNotification } from '../services/notificationService.js';
import { asyncHandler, ok, AppError } from '../utils/http.js';
import { validateHourlySchedule } from '../utils/scheduleValidation.js';
import {nextReference} from '../utils/referenceNumbers.js';
import {reserveSlot,releaseSlot,validateSlot,slotAvailability} from '../utils/bookingSlots.js';
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

export const availability = asyncHandler(async(req,res)=>{if(!/^\d{4}-\d{2}-\d{2}$/.test(String(req.query.day||'')))throw new AppError('A valid date is required.',400); ok(res,{slots:await slotAvailability(req.query.day)});});

export const list = asyncHandler(async (req, res) => {
  const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
  const limit = Math.min(50, Math.max(5, Number.parseInt(req.query.limit, 10) || 10));
  const filter = { company: req.user.company._id };
  const status = String(req.query.status || '').trim().toUpperCase();
  if (['DRAFT', 'SUBMITTED', 'REJECTED', 'SCHEDULED', 'READY_FOR_GATE_IN', 'GATED_IN', 'COMPLETED', 'CANCELLED'].includes(status)) filter.status = status;
  const search = String(req.query.search || '').trim();
  if (search) {
    const escaped = search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const rx = { $regex: escaped, $options: 'i' };
    filter.$or = [{ bookingReference: rx }, { containerNumber: rx }, { shippingLine: rx }];
  }

  const [items, total, summaryRows] = await Promise.all([
    PreAdvice.find(filter)
      .select('bookingReference containerNumber containerSize containerType scheduledGateDateIn scheduledGateTimeIn shippingLine status workflowStage cancellation createdAt updatedAt gateIn.actualGateInAt storage gateOut truckPlateNumber driverName driverLicenceNumber hauler loadStatus')
      .populate('storage.block','name')
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
    bookings: items.map(item=>({...item,id:String(item._id)})),
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

  data.bookingReference = await nextReference('BOOKING');
  data.company = req.user.company._id;
  data.createdBy = req.user._id;
  data.status = 'SUBMITTED';
  data.statusHistory = [{ status: data.status }];
  data.workflowStage = 'BOOKING_SUBMITTED';
  data.workflowHistory = [{ stage: 'BOOKING_SUBMITTED', changedAt: new Date() }];
  data.documents = fileDocs(req);

  const item = new PreAdvice(data);
  const session=await mongoose.startSession();
  try {await session.withTransaction(async()=>{
    await reserveSlot(item._id,item.scheduledGateDateIn,item.scheduledGateTimeIn,session);
    await item.save({session});
  });}finally{await session.endSession();}

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

  const oldDate = item.scheduledGateDateIn;
  const oldTime = item.scheduledGateTimeIn;
  const newDate = updates.scheduledGateDateIn ?? oldDate;
  const newTime = updates.scheduledGateTimeIn ?? oldTime;
  const changedSlot = newDate !== oldDate || newTime !== oldTime;
  const newDocs = fileDocs(req);
  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      const fresh = await PreAdvice.findOne({
        _id: item._id, company: req.user.company._id, status: 'SUBMITTED', workflowStage: 'BOOKING_SUBMITTED',
      }).session(session);
      if (!fresh) throw new AppError('Booking is no longer editable.', 409);
      if (changedSlot) await reserveSlot(fresh._id, newDate, newTime, session);
      Object.assign(fresh, updates);
      if (newDocs.length) fresh.documents.push(...newDocs);
      await fresh.save({ session });
      if (changedSlot) await releaseSlot(fresh._id, oldDate, oldTime, session);
    });
  } finally { await session.endSession(); }


  const updated = await PreAdvice.findById(item._id);
  getIO()?.to(`company:${item.company}`).emit('pre-advice:updated', updated);
  emitToAdminModule(MODULES.PRE_ADVICE, 'pre-advice:updated', updated);


  ok(res, { item: updated }, 'Pre-advice updated.');
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
  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      const fresh = await PreAdvice.findOne({ _id: item._id, company: req.user.company._id, status: 'SUBMITTED', workflowStage: 'BOOKING_SUBMITTED' }).session(session);
      if (!fresh) throw new AppError('The booking is no longer eligible for cancellation.', 409);
      fresh.status = 'CANCELLED';
      fresh.cancellation = { cancelledAt: now, cancelledBy: req.user._id, reason };
      fresh.statusHistory.push({ status: 'CANCELLED', changedAt: now, note: reason || 'Cancelled by client' });
      await fresh.save({ session });
      await releaseSlot(fresh._id, fresh.scheduledGateDateIn, fresh.scheduledGateTimeIn, session);
    });
  } finally { await session.endSession(); }
  item.status='CANCELLED';
  item.cancellation={cancelledAt:now,cancelledBy:req.user._id,reason};

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
