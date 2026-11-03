import PreAdvice from '../models/PreAdvice.js';
import Invoice from '../models/Invoice.js';
import Rate from '../models/Rate.js';
import { availableBookingLoadStatuses } from '../utils/bookingRateOptions.js';
import { buildBookingFilter } from '../services/tableFilters.js';
import { getBookingSummary } from '../services/tableSummaries.js';
import { listDocuments } from '../utils/tableQuery.js';
import { clearSummaryCache } from '../utils/summaryCache.js';
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

// Reefer bookings must reference a currently configured and effective Reefer
// load status. Existing bookings remain editable if only unrelated fields
// change after a rate expires; historical financial snapshots are untouched.
async function requireAvailableReeferLoadStatus(data, existing = null) {
  const containerType=data.containerType??existing?.containerType;
  if(containerType!=='REEFER')return;
  const containerSize=data.containerSize??existing?.containerSize;
  const transactionClassification=data.transactionClassification??existing?.transactionClassification;
  const loadStatus=data.loadStatus??existing?.loadStatus;
  const rates=await Rate.find({status:'ACTIVE',containerCategory:'REEFER',
    classification:{$in:[transactionClassification,'ALL']},
    containerSize:{$in:[containerSize,'ALL']},
    loadStatus:{$in:['EMPTY','LOADED','ALL']},
    $or:[{effectiveFrom:null},{effectiveFrom:{$exists:false}},{effectiveFrom:{$lte:new Date()}}],
  }).select('status name containerCategory classification containerSize loadStatus collectionPoint effectiveFrom').lean();
  const available=availableBookingLoadStatuses(rates,{containerType,containerSize,transactionClassification});
  if(!available.includes(loadStatus))throw new AppError(
    `No active Reefer ${loadStatus||'load-status'} rate is configured for ${transactionClassification} / ${containerSize}. Choose an available load status or ask an administrator to configure the rate.`,409);
}

export const availability = asyncHandler(async(req,res)=>{if(!/^\d{4}-\d{2}-\d{2}$/.test(String(req.query.day||'')))throw new AppError('A valid date is required.',400); ok(res,{slots:await slotAvailability(req.query.day)});});

export const list = asyncHandler(async (req, res) => {
  const filter = await buildBookingFilter(req.query, req.user.company._id);
  const { items, pagination } = await listDocuments(PreAdvice, filter, req.query, {
    defaultLimit: 20, maxLimit: 100,
    sorts: ['createdAt', 'updatedAt', 'bookingReference', 'containerNumber', 'status'],
    select: 'bookingReference company containerNumber containerSize containerType scheduledGateDateIn scheduledGateTimeIn shippingLine status workflowStage cancellation createdAt updatedAt gateIn.actualGateInAt gateIn.inspection gateIn.payment storage gateOut truckPlateNumber driverName driverLicenceNumber hauler loadStatus',
    populate: { path: 'storage.block', select: 'name' },
  });
  // Compatibility: old portal integrations read data.summary and data.bookings.
  // A cached full-collection aggregation, never the paginated items, drives it.
  const { summary } = await getBookingSummary({}, req.user.company._id, 'global');
  const bookings = items.map(item => ({ ...item, id: String(item._id) }));
  res.json({ success: true, message: 'Bookings loaded.',
    items, total: pagination.total ?? null, page: pagination.page, limit: pagination.limit,
    pages: pagination.pages ?? null, nextCursor: pagination.nextCursor ?? null,
    hasMore: pagination.hasMore ?? (pagination.page < pagination.totalPages),
    data: { items, bookings, summary, pagination } });
});

export const summary = asyncHandler(async (req, res) => {
  const { scope, summary: cards } = await getBookingSummary(req.query, req.user.company._id);
  ok(res, { ...cards, scope, summary: cards });
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
  await requireAvailableReeferLoadStatus(data);

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

  clearSummaryCache();
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
    data: { id: item._id, bookingId: item._id, bookingReference: item.bookingReference },
  }).catch(error => console.error('[PRE_ADVICE_NOTIFICATION_FAILED]', {bookingId:String(item._id),message:error.message}));

  ok(res, { item }, 'Pre-advice created.');
});

export const update = asyncHandler(async (req, res) => {
  const item = await PreAdvice.findOne({ _id: req.params.id, company: req.user.company._id });
  if (!item) throw new AppError('Pre-advice not found.', 404);
  if (item.workflowStage !== 'BOOKING_SUBMITTED' || !['DRAFT', 'SUBMITTED'].includes(item.status)) {
    throw new AppError('Only bookings that are still awaiting Pre-advice approval can be edited by the client.', 409);
  }

  const updates = pick(req.body);
  if (['containerType','containerSize','loadStatus','transactionClassification'].some(k => updates[k] !== undefined && updates[k] !== item[k])) {
    await requireAvailableReeferLoadStatus(updates, item);
  }
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
  clearSummaryCache();
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
  clearSummaryCache();
  getIO()?.to(`company:${item.company}`).emit('pre-advice:status-updated', payload);
  emitToAdminModule(MODULES.PRE_ADVICE, 'pre-advice:cancelled', payload);
  await createNotification({
    company: item.company,
    audience: 'ADMIN',
    type: 'PRE_ADVICE_CANCELLED',
    title: 'Booking Cancelled',
    message: `${item.bookingReference} was cancelled by the client.`,
    data: { id: item._id, bookingId: item._id, reason },
  }).catch(error => console.error('[PRE_ADVICE_NOTIFICATION_FAILED]', {bookingId:String(item._id),message:error.message}));

  ok(res, { item }, 'Booking cancelled.');
});
