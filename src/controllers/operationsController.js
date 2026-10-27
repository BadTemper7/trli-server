import PreAdvice from '../models/PreAdvice.js';
import Rate from '../models/Rate.js';
import PaymentType from '../models/PaymentType.js';
import { ensureDefaultPaymentTypes } from './paymentTypeController.js';
import StorageMovement from '../models/StorageMovement.js';
import StorageBlock from '../models/StorageBlock.js';
import { MODULES } from '../constants/permissions.js';
import { auditAdminAction } from '../services/adminAuditService.js';
import { createNotification } from '../services/notificationService.js';
import { emitToAdminModule, getIO } from '../socket/index.js';
import { AppError, asyncHandler } from '../utils/http.js';
import { advanceWorkflow, ensureWorkflow } from '../utils/preAdviceWorkflow.js';
import { validateHourlySchedule } from '../utils/scheduleValidation.js';
import {buildInvoice,requirePaid} from '../services/invoicingService.js';
import {reserveSlot,releaseSlot} from '../utils/bookingSlots.js';
import {enqueueBookingMail} from '../services/transactionalMail.js';
import mongoose from 'mongoose';
import { parseGateInInspection } from '../utils/gateInInspection.js';
import { storageDaysBetween } from '../utils/storageDuration.js';

const adminId = (req) => String(req.admin?._id || req.admin?.id || 'admin');

const CONTAINER_TYPES = ['DRY CONTAINER', 'REEFER', 'TANK CONTAINER', 'OPEN TOP', 'FLAT RACK'];

function applyInspectionCorrections(item, corrections = {}) {
  const changed = {};
  const setString = (field, max = 160) => {
    if (corrections[field] === undefined) return;
    const value = String(corrections[field] || '').trim().slice(0, max);
    if (value && item[field] !== value) { item[field] = value; changed[field] = value; }
  };
  const setEnum = (field, allowed) => {
    if (corrections[field] === undefined) return;
    const value = String(corrections[field] || '').trim().toUpperCase();
    if (!allowed.includes(value)) throw new AppError(`Invalid ${field}.`, 400);
    if (item[field] !== value) { item[field] = value; changed[field] = value; }
  };
  setString('containerNumber', 30);
  setEnum('containerSize', ['20FT', '40FT']);
  setEnum('containerType', CONTAINER_TYPES);
  setEnum('loadStatus', ['EMPTY', 'LOADED']);
  setEnum('transactionClassification', ['LOCAL', 'INTERNATIONAL']);
  setString('shippingLine'); setString('truckPlateNumber', 50); setString('driverName');
  setString('driverLicenceNumber', 80); setString('hauler'); setString('blNumber'); setString('vesselVoyage');
  if (corrections.weight !== undefined) {
    const weight = Number(corrections.weight);
    if (!Number.isFinite(weight) || weight < 0) throw new AppError('Weight must be a valid non-negative number.', 400);
    if (Number(item.weight) !== weight) { item.weight = weight; changed.weight = weight; }
  }
  if (corrections.cargoDescription !== undefined) {
    const value = String(corrections.cargoDescription || '').trim().slice(0, 1000);
    if (item.cargoDescription !== value) { item.cargoDescription = value; changed.cargoDescription = value; }
  }
  return changed;
}

async function emitStorageOccupancy(blockId) {
  if (!blockId) return;
  const block = await StorageBlock.findById(blockId).lean();
  if (!block) return;
  const occupied = await PreAdvice.countDocuments({ 'storage.block': blockId, 'storage.status': 'STORED' });
  const capacity = Number(block.capacityTeu || 0);
  emitToAdminModule(MODULES.STORAGE_MONITORING, 'storage:occupancy-updated', {
    id: String(block._id), name: block.name, capacityTeu: capacity, containerSize: block.containerSize,
    status: occupied >= capacity && capacity > 0 ? 'FULL' : block.status, operationalStatus: block.status,
    color: block.color, layout: block.layout, occupiedTeu: occupied, containerCount: occupied,
    availableTeu: Math.max(0, capacity - occupied), capacityUnit: block.containerSize === '40FT' ? 'FEU' : 'TEU',
    occupancyRate: capacity ? Math.min(100, Math.round((occupied / capacity) * 100)) : 0,
    physicalSlots: (block.layout?.bays || 0) * (block.layout?.rows || 0) * (block.layout?.tiers || 0),
  });
}
const escapeRx = (value = '') => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

async function matchingRates(item, collectionPoint) {
  const rates = await Rate.find({
    status: 'ACTIVE',
    collectionPoint: { $in: [collectionPoint, 'BOTH'] },
    classification: { $in: [item.transactionClassification, 'ALL'] },
    loadStatus: { $in: [item.loadStatus, 'ALL'] },
    containerSize: { $in: ['ALL', item.containerSize] },
  }).sort({ name: 1, createdAt: 1 }).lean();
  return rates.map((r) => ({
    id: String(r._id), name: r.name, amount: r.amount,
    description: r.description || '', containerSize: r.containerSize,
  }));
}

async function paymentSummary(item, collectionPoint) {
  const Invoice = (await import('../models/Invoice.js')).default;
  const invoice = await Invoice.findOne({booking:item._id,type:collectionPoint}).lean();
  if (invoice) return {
    invoiceId:String(invoice._id), invoiceNumber:invoice.number,
    paymentStatus:invoice.status,charges:invoice.lines||[],total:invoice.total,
    subtotal:invoice.subtotal,vat:invoice.vat,
  };
  // Historical records without an invoice can still show their legacy rate data.
  const charges = await matchingRates(item, collectionPoint);
  return { charges, total: charges.reduce((sum, row) => sum + Number(row.amount || 0), 0) };
}

async function validatePaymentMethod(method, referenceNumber, total) {
  await ensureDefaultPaymentTypes();
  const code = String(method || '').trim().toUpperCase();
  if (!code) throw new AppError('Select a payment type.', 400);
  const type = await PaymentType.findOne({ code, status: 'ACTIVE' }).lean();
  if (!type) throw new AppError('Selected payment type is unavailable or inactive.', 400);
  if (type.code === 'CASH') throw new AppError('Only online payments are supported.',400);
  if (!type.bankName || !type.accountName || !type.accountNumber) {
    throw new AppError(`${type.name} account details are not configured yet. Update Payment Types first.`, 400);
  }
  if (total > 0 && type.requiresReference && !referenceNumber) {
    throw new AppError(`Payment reference number is required for ${type.name}.`, 400);
  }
  return type;
}

function workflowIndex(stage) {
  const stages = [
    'BOOKING_SUBMITTED','BOOKING_APPROVED','READY_FOR_GATE_IN','GATE_IN_PAYMENT_SUBMITTED',
    'GATE_IN','INVENTORY','STORAGE','GATE_OUT_REQUESTED','GATE_OUT_PAYMENT_PENDING',
    'GATE_OUT_PAYMENT_SUBMITTED','GATE_OUT_APPROVED','READY_FOR_RELEASE','CONTAINER_RELEASED',
  ];
  return stages.indexOf(stage);
}

function canAtLeast(item, stage) {
  return workflowIndex(item.workflowStage) >= workflowIndex(stage);
}

function itemDto(item, extras = {}) {
  const company = item.company && typeof item.company === 'object' ? item.company : null;
  const block = item.storage?.block && typeof item.storage.block === 'object' ? item.storage.block : null;
  return {
    id: String(item._id),
    bookingReference: item.bookingReference,
    company: company ? { id: String(company._id), companyName: company.companyName, verificationStatus: company.verificationStatus } : item.company,
    containerNumber: item.containerNumber,
    containerSize: item.containerSize,
    containerType: item.containerType,
    loadStatus: item.loadStatus,
    transactionClassification: item.transactionClassification,
    shippingLine: item.shippingLine,
    scheduledGateDateIn: item.scheduledGateDateIn,
    scheduledGateTimeIn: item.scheduledGateTimeIn,
    truckPlateNumber: item.truckPlateNumber,
    driverName: item.driverName,
    driverLicenceNumber: item.driverLicenceNumber,
    hauler: item.hauler,
    blNumber: item.blNumber || '',
    vesselVoyage: item.vesselVoyage || '',
    weight: item.weight,
    cargoDescription: item.cargoDescription || '',
    remarks: item.remarks || '',
    status: item.status,
    statusHistory: item.statusHistory || [],
    preAdviceReview: item.preAdviceReview || {},
    workflowStage: item.workflowStage,
    workflowHistory: item.workflowHistory || [],
    gateIn: item.gateIn || {},
    inventory: item.inventory || {},
    storage: {
      ...(item.storage?.toObject?.() || item.storage || {}),
      block: block ? { id: String(block._id), name: block.name } : item.storage?.block || null,
    },
    gateOut: item.gateOut || {},
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    ...extras,
  };
}

async function notifyWorkflow(item, module, event, title, message) {
  const payload = itemDto(item);
  emitToAdminModule(module, event, payload);
  getIO()?.to(`company:${item.company?._id || item.company}`).emit('pre-advice:workflow-updated', {
    id: String(item._id),
    workflowStage: item.workflowStage,
    workflowHistory: item.workflowHistory,
    status: item.status,
    gateIn: item.gateIn,
    inventory: item.inventory,
    storage: item.storage,
    gateOut: item.gateOut,
    updatedAt: item.updatedAt,
  });
  if (title && message) {
    await createNotification({
      company: item.company?._id || item.company,
      audience: 'CLIENT',
      type: event.toUpperCase().replace(/[:\-]/g, '_'),
      title,
      message,
      data: { id: item._id, bookingReference: item.bookingReference, workflowStage: item.workflowStage },
    });
  }
  return payload;
}

async function findItem(id) {
  const item = await PreAdvice.findById(id)
    .populate('company', 'companyName verificationStatus')
    .populate('storage.block', 'name');
  if (!item) throw new AppError('Booking/container record not found.', 404);
  ensureWorkflow(item);
  return item;
}

function buildFilter(query = {}, stages = null) {
  const filter = {};
  if (stages?.length) filter.workflowStage = { $in: stages };
  if (query.stage) filter.workflowStage = String(query.stage).toUpperCase();
  if (query.status) filter.status = String(query.status).toUpperCase();
  if (query.search) {
    const rx = { $regex: escapeRx(query.search), $options: 'i' };
    filter.$or = [{ bookingReference: rx }, { containerNumber: rx }, { shippingLine: rx }];
  }
  return filter;
}

const LIST_FIELDS = 'bookingReference company containerNumber containerSize containerType loadStatus transactionClassification shippingLine scheduledGateDateIn scheduledGateTimeIn truckPlateNumber driverName driverLicenceNumber hauler weight status workflowStage preAdviceReview gateIn inventory storage gateOut createdAt updatedAt';

async function listItems(filter, query = {}) {
  const page = Math.max(1, Number.parseInt(query.page, 10) || 1);
  const limit = Math.min(100, Math.max(5, Number.parseInt(query.limit, 10) || 20));
  const [rows, total] = await Promise.all([
    PreAdvice.find(filter)
      .select(LIST_FIELDS)
      .populate('company', 'companyName verificationStatus')
      .populate('storage.block', 'name')
      .sort({ updatedAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit),
    PreAdvice.countDocuments(filter),
  ]);
  return { rows, pagination: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) } };
}

export const listAdminPreAdvice = asyncHandler(async (req, res) => {
  const filter=buildFilter(req.query);
  filter.$and=[{status:{$in:['SUBMITTED','READY_FOR_GATE_IN','REJECTED']}},{$or:[{workflowStage:'BOOKING_SUBMITTED'},{workflowStage:'READY_FOR_GATE_IN'}]}];
  if(req.query.approval==='PENDING')filter.$and.push({status:'SUBMITTED',workflowStage:'BOOKING_SUBMITTED'});
  if(req.query.approval==='APPROVED')filter.$and.push({status:'READY_FOR_GATE_IN'});
  if(req.query.approval==='REJECTED')filter.$and.push({status:'REJECTED'});
  const { rows, pagination } = await listItems(filter, req.query);
  res.json({ success: true, message: 'Pre-advice records loaded.', data: { items: rows.map((row) => itemDto(row)), pagination } });
});

export const getAdminPreAdvice = asyncHandler(async (req, res) => {
  const item = await findItem(req.params.id);
  const [gateIn, gateOut] = await Promise.all([paymentSummary(item, 'GATE_IN'), paymentSummary(item, 'GATE_OUT')]);
  res.json({ success: true, message: 'Pre-advice loaded.', data: itemDto(item, { charges: { gateIn, gateOut } }) });
});

export const approvePreAdvice = asyncHandler(async (req, res) => {
  const session=await mongoose.startSession();
  let booking,invoice;
  try{
    await session.withTransaction(async()=>{
      booking=await PreAdvice.findOne({_id:req.params.id,status:'SUBMITTED',workflowStage:'BOOKING_SUBMITTED'}).session(session);
      if(!booking)throw new AppError('Only pending pre-advice can be approved.',409);
      const now=new Date();
      booking.status='READY_FOR_GATE_IN';booking.statusHistory.push({status:'READY_FOR_GATE_IN',changedAt:now,note:String(req.body?.note||'')});
      booking.preAdviceReview={decision:'APPROVED',reason:'',reviewedAt:now,reviewedBy:req.admin._id};
      advanceWorkflow(booking,['BOOKING_APPROVED','READY_FOR_GATE_IN'],{changedAt:now});
      // Only create a new invoice if none exists. An existing invoice is immutable.
      const {calculateInvoice}=await import('../services/invoicingService.js');
      const {nextReference}=await import('../utils/referenceNumbers.js');
      const Invoice=(await import('../models/Invoice.js')).default;
      invoice=await Invoice.findOne({booking:booking._id,type:'GATE_IN'}).session(session);
      if(!invoice){
        const quote=await calculateInvoice(booking,'GATE_IN');
        invoice=(await Invoice.create([{...quote,number:await nextReference('INVOICE',new Date(),session),booking:booking._id,company:booking.company,type:'GATE_IN',status:quote.total===0?'PAID':'UNPAID'}],{session}))[0];
      }
      booking.gateIn.payment.amountDue=invoice.total;
      await booking.save({session});
      await enqueueBookingMail(booking,{event:'PRE_ADVICE_APPROVED',title:'Booking approved',message:'Your booking has been approved. Your gate-in invoice is ready for online payment.',invoiceNumber:invoice.number,amount:invoice.total},session);
    });
  }finally{await session.endSession();}
  await auditAdminAction({performedBy:req.admin._id,action:'PRE_ADVICE_APPROVED',changes:{bookingReference:booking.bookingReference}});
  const item=await findItem(booking._id);
  const data=await notifyWorkflow(item,MODULES.PRE_ADVICE,'operations:pre-advice-updated','Booking Approved',`${item.bookingReference} is ready for gate-in payment.`);
  emitToAdminModule(MODULES.GATE_IN,'gate-in:queue-updated',data);
  res.json({success:true,message:'Pre-advice approved; gate-in invoice generated.',data});
});

export const rejectPreAdvice = asyncHandler(async (req, res) => {
  const reason = String(req.body?.reason || '').trim().slice(0, 800);
  if (!reason) throw new AppError('A rejection reason is required.', 400);
  const session=await mongoose.startSession();
  let id;
  try {
    await session.withTransaction(async()=>{
      const item=await PreAdvice.findOne({_id:req.params.id,status:'SUBMITTED',workflowStage:'BOOKING_SUBMITTED'}).session(session);
      if(!item)throw new AppError('Only pending pre-advice can be rejected.',409);
      const now=new Date();
      item.status='REJECTED';
      item.preAdviceReview={decision:'REJECTED',reason,reviewedAt:now,reviewedBy:req.admin._id};
      item.statusHistory.push({status:'REJECTED',changedAt:now,note:reason});
      item.workflowHistory.push({stage:'BOOKING_SUBMITTED',changedAt:now,note:`Rejected: ${reason}`});
      await item.save({session});
      await releaseSlot(item._id,item.scheduledGateDateIn,item.scheduledGateTimeIn,session);
      await enqueueBookingMail(item,{event:'PRE_ADVICE_REJECTED',title:'Booking rejected',message:`Your pre-advice was rejected: ${reason}`},session);
      id=item._id;
    });
  }finally{await session.endSession();}
  const item=await findItem(id);
  await auditAdminAction({performedBy:req.admin._id,action:'PRE_ADVICE_REJECTED',changes:{bookingReference:item.bookingReference,reason}});
  const data=await notifyWorkflow(item,MODULES.PRE_ADVICE,'operations:pre-advice-updated','Booking Rejected',`${item.bookingReference}: ${reason}`);
  res.json({success:true,message:'Pre-advice rejected.',data});
});

export const listGateIn = asyncHandler(async (req, res) => {
  const stages = ['READY_FOR_GATE_IN', 'GATE_IN_PAYMENT_SUBMITTED'];
  const { rows, pagination } = await listItems(buildFilter(req.query, stages), req.query);
  const Invoice=(await import('../models/Invoice.js')).default;
  const items=await Promise.all(rows.map(async row=>{
    const invoice=await Invoice.findOne({booking:row._id,type:'GATE_IN'}).lean();
    return itemDto(row,{gateInCharges:{invoiceId:invoice?._id?String(invoice._id):null,total:invoice?.total??0,charges:invoice?.lines||[],invoiceNumber:invoice?.number,paymentStatus:invoice?.status}});
  }));
  res.json({ success: true, message: 'Gate-in queue loaded.', data: { items, pagination } });
});


export const inspectGateIn = asyncHandler(async (req, res) => {
  const item = await findItem(req.params.id);
  if (!['READY_FOR_GATE_IN','GATE_IN_PAYMENT_SUBMITTED'].includes(item.workflowStage)) throw new AppError('Inspection is only available before physical gate-in.', 409);
  if (item.gateIn?.payment?.submittedAt && req.body?.corrections && Object.keys(req.body.corrections).length) throw new AppError('Container and rate-driving details cannot be changed after online payment submission. Contact billing support for a formal adjustment.', 409);

  // A successful inspection is committed together with physical entry by
  // POST /gate-in/:id/process. This endpoint is kept for inspection rejection.
  const status = String(req.body?.status || '').trim().toUpperCase();
  if (status === 'ACCEPTED') throw new AppError('Use Confirm Physical Gate-in to accept the inspection and record entry together.', 409);
  const now = new Date();
  const checked = parseGateInInspection(req.body, adminId(req), now);
  const { sealNumber, sealIntact, containerCondition, remarks, rejectionReason } = checked;
  const corrections = applyInspectionCorrections(item, req.body?.corrections || {});
  item.gateIn.inspection = checked;

  // Rate-driving corrections can change the Gate-in amount due.
  const invoice=await buildInvoice(item,'GATE_IN');
  item.gateIn.payment.amountDue = invoice.total;
  await item.save();
  await auditAdminAction({
    performedBy: req.admin._id,
    action: 'GATE_IN_INSPECTION_REJECTED',
    changes: {
      bookingReference: item.bookingReference,
      containerNumber: item.containerNumber,
      sealNumber,
      sealIntact: req.body.sealIntact,
      containerCondition,
      rejectionReason: status === 'REJECTED' ? rejectionReason : undefined,
      correctedFields: Object.keys(corrections),
    },
  });
  const data = await notifyWorkflow(
    item,
    MODULES.GATE_IN,
    'gate-in:inspection-updated',
    'Gate-in Inspection Requires Attention',
    `${item.containerNumber} was rejected during Gate-in inspection: ${rejectionReason}`,
  );
  res.json({
    success: true,
    message: 'Inspection rejected. Physical Gate-in is blocked. The inspection may be repeated after the issue is resolved.',
    data: itemDto(item, { gateInCharges: await paymentSummary(item,'GATE_IN') }),
  });
});

async function applyGateInPayment(item, req, paymentSummaryResult) {
  const amountSubmitted = Number(req.body?.payment?.amountSubmitted ?? req.body?.amountSubmitted ?? paymentSummaryResult.total);
  if (!Number.isFinite(amountSubmitted) || amountSubmitted < paymentSummaryResult.total) {
    throw new AppError(`Submitted amount must cover the required ₱${paymentSummaryResult.total.toFixed(2)}.`, 400);
  }
  const referenceNumber = String(req.body?.payment?.referenceNumber ?? req.body?.referenceNumber ?? '').trim();
  const method = req.body?.payment?.method ?? req.body?.method;
  const paymentType = await validatePaymentMethod(method, referenceNumber, paymentSummaryResult.total);
  const now = new Date();
  item.gateIn.payment = {
    status: 'SUBMITTED',
    amountDue: paymentSummaryResult.total,
    amountSubmitted,
    referenceNumber,
    method: paymentType.code,
    submittedAt: now,
    submittedBy: adminId(req),
    cancelledAt: null,
    cancelledBy: null,
    cancellationReason: '',
  };
  advanceWorkflow(item, 'GATE_IN_PAYMENT_SUBMITTED', {
    changedAt: now,
    note: referenceNumber ? `Payment ${referenceNumber}` : `Payment via ${paymentType.name}`,
  });
  return { now, amountSubmitted, referenceNumber, paymentType };
}

export const submitGateInPayment = asyncHandler(async (req, res) => {
  throw new AppError('Admin payment recording is disabled. The client must submit online payment proof for independent verification.',403);
  const item = await findItem(req.params.id);
  if (!['READY_FOR_GATE_IN', 'GATE_IN_PAYMENT_SUBMITTED'].includes(item.workflowStage)) throw new AppError('Container is not ready for Gate-in payment.', 409);
  if (item.gateIn?.inspection?.status !== 'ACCEPTED') {
    const reason = item.gateIn?.inspection?.status === 'REJECTED' ? ` Inspection rejected: ${item.gateIn.inspection.rejectionReason || 'No reason provided.'}` : '';
    throw new AppError(`Gate-in inspection must be accepted before payment can be recorded.${reason}`, 409);
  }
  const payment = await paymentSummary(item, 'GATE_IN');
  const recorded = await applyGateInPayment(item, req, payment);
  await item.save();
  await auditAdminAction({ performedBy: req.admin._id, action: 'GATE_IN_PAYMENT_SUBMITTED', changes: { bookingReference: item.bookingReference, amount: recorded.amountSubmitted, referenceNumber: recorded.referenceNumber, method: recorded.paymentType.code } });
  const data = await notifyWorkflow(item, MODULES.GATE_IN, 'gate-in:updated', 'Gate-in Payment Recorded', `${item.bookingReference} Gate-in payment was recorded.`);
  res.json({ success: true, message: 'Gate-in payment recorded.', data });
});

export const cancelGateInPayment = asyncHandler(async (req, res) => {
  throw new AppError('Payment cancellation is disabled. Use the verified invoice workflow.',403);
  const item = await findItem(req.params.id);
  if (!['READY_FOR_GATE_IN', 'GATE_IN_PAYMENT_SUBMITTED'].includes(item.workflowStage)) throw new AppError('Payment can only be cancelled before Gate-in is completed.', 409);
  if (!item.gateIn?.payment?.submittedAt) throw new AppError('There is no submitted Gate-in payment to cancel.', 409);
  const reason = String(req.body?.reason || '').trim().slice(0, 500);
  const now = new Date();
  const previous = {
    amountSubmitted: item.gateIn.payment.amountSubmitted,
    referenceNumber: item.gateIn.payment.referenceNumber,
    method: item.gateIn.payment.method,
    submittedAt: item.gateIn.payment.submittedAt,
  };
  item.gateIn.payment.status = 'CANCELLED';
  item.gateIn.payment.amountSubmitted = 0;
  item.gateIn.payment.referenceNumber = '';
  item.gateIn.payment.method = '';
  item.gateIn.payment.submittedAt = null;
  item.gateIn.payment.submittedBy = null;
  item.gateIn.payment.cancelledAt = now;
  item.gateIn.payment.cancelledBy = adminId(req);
  item.gateIn.payment.cancellationReason = reason;
  item.workflowStage = 'READY_FOR_GATE_IN';
  item.workflowHistory.push({ stage: 'READY_FOR_GATE_IN', changedAt: now, note: reason ? `Gate-in payment cancelled: ${reason}` : 'Gate-in payment cancelled for correction' });
  await item.save();
  await auditAdminAction({ performedBy: req.admin._id, action: 'GATE_IN_PAYMENT_CANCELLED', changes: { bookingReference: item.bookingReference, reason, previous } });
  const payment = await paymentSummary(item, 'GATE_IN');
  const data = await notifyWorkflow(item, MODULES.GATE_IN, 'gate-in:updated', 'Gate-in Payment Cancelled', `${item.bookingReference} Gate-in payment was cancelled and can be resubmitted.`);
  res.json({ success: true, message: 'Gate-in payment cancelled. Payment details can be entered again.', data: itemDto(item, { gateInCharges: payment }) });
});

export const processGateIn = asyncHandler(async (req,res) => {
  // One atomic operation: accept the actual inspection and confirm physical
  // Gate-in. A verified online payment must already exist; no intermediate
  // ACCEPTED state is committed if Gate-in cannot complete.
  const session=await mongoose.startSession();
  let id;
  try{
    await session.withTransaction(async()=>{
      const item=await PreAdvice.findOne({_id:req.params.id,workflowStage:{$in:['READY_FOR_GATE_IN','GATE_IN_PAYMENT_SUBMITTED']}}).session(session);
      if(!item)throw new AppError('Booking was already gated in or is not approved.',409);
      const Invoice=(await import('../models/Invoice.js')).default;
      const paid=await Invoice.findOne({booking:item._id,type:'GATE_IN',status:'PAID',balance:0}).session(session);
      if(!paid || item.gateIn?.payment?.status!=='VERIFIED')throw new AppError('Gate-in payment must be verified before confirming physical entry.',409);
      if(item.gateIn.actualGateInAt)throw new AppError('Container was already gated in.',409);
      if(!req.body?.inspection || typeof req.body.inspection !== 'object') throw new AppError('Complete the arrival inspection before confirming physical Gate-in.',400);
      const now=new Date();
      const inspection=parseGateInInspection({...req.body.inspection,status:'ACCEPTED'},adminId(req),now);
      // Do not silently alter a settled billing snapshot. Corrections to the
      // booking must be handled through the documented adjustment workflow.
      const proposed=req.body.inspection.corrections||{};
      if(proposed && (typeof proposed !== 'object' || Array.isArray(proposed)))throw new AppError('Invalid booking correction details.',400);
      const changed=Object.entries(proposed).filter(([field,value])=>String(item[field]??'')!==String(value??''));
      if(changed.length)throw new AppError('Booking details cannot be changed after payment verification. Contact billing for an adjustment before Gate-in.',409);
      item.gateIn.inspection=inspection;
      item.status='GATED_IN';item.statusHistory.push({status:'GATED_IN',changedAt:now,note:String(req.body?.remarks||'').slice(0,500)});
      item.gateIn.actualGateInAt=now;item.gateIn.processedBy=adminId(req);item.gateIn.remarks=String(req.body?.remarks||'').slice(0,500);
      item.inventory.status='IN_YARD';item.inventory.receivedAt=now;item.inventory.receivedBy=adminId(req);
      item.inventory.condition=[...inspection.containerCondition];
      item.inventory.sealNumber=inspection.sealNumber;
      item.storage.status='WAITING_STORAGE';
      advanceWorkflow(item,['GATE_IN','INVENTORY'],{changedAt:now,note:'Inspection accepted and physical Gate-in confirmed'});
      await item.save({session});id=item._id;
    });
  }finally{await session.endSession();}
  const item=await findItem(id);
  await auditAdminAction({performedBy:req.admin._id,action:'CONTAINER_GATED_IN',changes:{bookingReference:item.bookingReference,inspectionAccepted:true}});
  const data=await notifyWorkflow(item,MODULES.GATE_IN,'gate-in:completed','Container Gated In',`${item.containerNumber} passed inspection and entered the terminal.`);
  emitToAdminModule(MODULES.INVENTORY,'inventory:updated',data);
  emitToAdminModule(MODULES.STORAGE_MONITORING,'storage:waiting-updated',data);
  res.json({success:true,message:'Inspection accepted and physical Gate-in confirmed; container added to inventory.',data});
});

export const listInventory = asyncHandler(async (req, res) => {
  const filter = buildFilter(req.query);
  filter.status = { $in: ['GATED_IN', 'COMPLETED'] };
  if (!req.query.includeReleased) filter.workflowStage = { $ne: 'CONTAINER_RELEASED' };
  const { rows, pagination } = await listItems(filter, req.query);
  res.json({ success: true, message: 'Inventory loaded.', data: { items: rows.map((row) => itemDto(row)), pagination } });
});

export const updateInventory = asyncHandler(async (req, res) => {
  const item = await findItem(req.params.id);
  if (!canAtLeast(item, 'INVENTORY') || item.workflowStage === 'CONTAINER_RELEASED') throw new AppError('Container is not active in inventory.', 409);
  const allowedInventoryConditions = ['GOOD', 'DENTED', 'RUST', 'HOLE', 'DOOR DAMAGE', 'OTHER', 'DAMAGED', 'FOR_INSPECTION'];
  const rawCondition = Array.isArray(req.body?.condition) ? req.body.condition : req.body?.condition ? [req.body.condition] : [];
  const condition = [...new Set(rawCondition.map((value) => String(value || '').trim().toUpperCase()).filter(Boolean))];
  if (condition.some((value) => !allowedInventoryConditions.includes(value))) throw new AppError('Invalid container condition.', 400);
  if (condition.includes('GOOD') && condition.length > 1) throw new AppError('GOOD cannot be combined with damage conditions.', 400);
  if (req.body?.condition !== undefined) item.inventory.condition = condition;
  if (req.body?.sealNumber !== undefined) item.inventory.sealNumber = String(req.body.sealNumber || '').trim().slice(0, 120);
  if (req.body?.notes !== undefined) item.inventory.notes = String(req.body.notes || '').trim().slice(0, 1000);
  await item.save();
  await auditAdminAction({ performedBy: req.admin._id, action: 'INVENTORY_UPDATED', changes: { bookingReference: item.bookingReference, condition: item.inventory.condition, sealNumber: item.inventory.sealNumber } });
  const data = await notifyWorkflow(item, MODULES.INVENTORY, 'inventory:updated');
  res.json({ success: true, message: 'Inventory record updated.', data });
});

export const listGateOut = asyncHandler(async (req, res) => {
  const stages = ['GATE_OUT_PAYMENT_SUBMITTED'];
  const { rows, pagination } = await listItems(buildFilter(req.query, stages), req.query);
  const items = await Promise.all(rows.map(async (row) => {
    const payment = await paymentSummary(row, 'GATE_OUT');
    return itemDto(row, { gateOutCharges: payment });
  }));
  res.json({ success: true, message: 'Gate-out queue loaded.', data: { items, pagination } });
});

export const requestGateOut = asyncHandler(async (req, res) => {
  throw new AppError('Gate-out requests must be initiated by the client portal.',403);
  const item = await findItem(req.params.id);
  if (item.workflowStage !== 'STORAGE' || item.storage?.status !== 'STORED') throw new AppError('Container must be stored before Gate-out can be requested.', 409);
  const date = String(req.body?.scheduledDate || '');
  const time = String(req.body?.scheduledTime || '');
  const scheduleError = validateHourlySchedule(date, time, 'Scheduled Gate-out');
  if (scheduleError) throw new AppError(scheduleError, 400);
  await reserveSlot(item._id,date,time);
  const now = new Date();
  item.gateOut.requestedAt = now;
  item.gateOut.requestedBy = adminId(req);
  item.gateOut.scheduledDate = date;
  item.gateOut.scheduledTime = time;
  item.gateOut.truckPlateNumber = String(req.body?.truckPlateNumber || item.truckPlateNumber || '').trim();
  item.gateOut.driverName = String(req.body?.driverName || item.driverName || '').trim();
  item.gateOut.remarks = String(req.body?.remarks || '').trim().slice(0, 500);
  const invoice=await buildInvoice(item,'GATE_OUT');
  item.gateOut.payment.amountDue = invoice.total;
  advanceWorkflow(item, ['GATE_OUT_REQUESTED', 'GATE_OUT_PAYMENT_PENDING'], { changedAt: now, note: `${date} ${time}` });
  await item.save();
  await auditAdminAction({ performedBy: req.admin._id, action: 'GATE_OUT_REQUESTED', changes: { bookingReference: item.bookingReference, scheduledDate: date, scheduledTime: time } });
  const data = await notifyWorkflow(item, MODULES.GATE_OUT, 'gate-out:updated', 'Gate-out Requested', `${item.bookingReference} is waiting for Gate-out payment.`);
  res.json({ success: true, message: 'Gate-out requested. Waiting for payment.', data });
});

export const submitGateOutPayment = asyncHandler(async (req, res) => {
  throw new AppError('Admin payment recording is disabled. The client must submit online payment proof.',403);
  const item = await findItem(req.params.id);
  if (!['GATE_OUT_PAYMENT_PENDING', 'GATE_OUT_PAYMENT_SUBMITTED'].includes(item.workflowStage)) throw new AppError('Container is not waiting for Gate-out payment.', 409);
  const payment = await paymentSummary(item, 'GATE_OUT');
  const amountSubmitted = Number(req.body?.amountSubmitted ?? payment.total);
  if (!Number.isFinite(amountSubmitted) || amountSubmitted < payment.total) throw new AppError(`Submitted amount must cover the required ₱${payment.total.toFixed(2)}.`, 400);
  const referenceNumber = String(req.body?.referenceNumber || '').trim();
  const paymentType = await validatePaymentMethod(req.body?.method, referenceNumber, payment.total);
  const now = new Date();
  item.gateOut.payment = {
    amountDue: payment.total,
    amountSubmitted,
    referenceNumber,
    method: paymentType.code,
    submittedAt: now,
    submittedBy: adminId(req),
  };
  advanceWorkflow(item, 'GATE_OUT_PAYMENT_SUBMITTED', { changedAt: now, note: referenceNumber ? `Payment ${referenceNumber}` : 'No Gate-out charge' });
  await item.save();
  await auditAdminAction({ performedBy: req.admin._id, action: 'GATE_OUT_PAYMENT_SUBMITTED', changes: { bookingReference: item.bookingReference, amount: amountSubmitted, referenceNumber } });
  const data = await notifyWorkflow(item, MODULES.GATE_OUT, 'gate-out:updated', 'Gate-out Payment Recorded', `${item.bookingReference} Gate-out payment was recorded.`);
  res.json({ success: true, message: 'Gate-out payment recorded.', data });
});

export const approveGateOut = asyncHandler(async (req, res) => {
  const item = await findItem(req.params.id);
  if (!['GATE_OUT_PAYMENT_PENDING', 'GATE_OUT_PAYMENT_SUBMITTED'].includes(item.workflowStage)) throw new AppError('Container is not ready for Gate-out approval.', 409);
  const payment = await paymentSummary(item, 'GATE_OUT');
  await requirePaid(item,'GATE_OUT');
  const now = new Date();
  item.gateOut.approvedAt = now;
  item.gateOut.approvedBy = adminId(req);
  item.gateOut.readyForReleaseAt = now;
  item.inventory.status = 'RELEASE_PENDING';
  advanceWorkflow(item, ['GATE_OUT_APPROVED', 'READY_FOR_RELEASE'], { changedAt: now, note: String(req.body?.remarks || '') });
  await item.save();
  await auditAdminAction({ performedBy: req.admin._id, action: 'GATE_OUT_APPROVED', changes: { bookingReference: item.bookingReference, containerNumber: item.containerNumber } });
  const data = await notifyWorkflow(item, MODULES.GATE_OUT, 'gate-out:approved', 'Gate-out Approved', `${item.containerNumber} is ready for release.`);
  emitToAdminModule(MODULES.RELEASE_CONTAINER, 'release:queue-updated', data);
  res.json({ success: true, message: 'Gate-out approved. Container is ready for release.', data });
});

export const listRelease = asyncHandler(async (req, res) => {
  const { rows, pagination } = await listItems(buildFilter(req.query, ['READY_FOR_RELEASE']), req.query);
  res.json({ success: true, message: 'Release queue loaded.', data: { items: rows.map((row) => itemDto(row)), pagination } });
});

export const releaseContainer = asyncHandler(async (req,res) => {
  const session=await mongoose.startSession();
  let id,oldStorage,now;
  try{
    await session.withTransaction(async()=>{
      const item=await PreAdvice.findOne({_id:req.params.id,workflowStage:'READY_FOR_RELEASE'}).session(session);
      if(!item)throw new AppError('Container is not awaiting physical release.',409);
      const Invoice=(await import('../models/Invoice.js')).default;
      if(!await Invoice.exists({booking:item._id,type:'GATE_OUT',status:'PAID',balance:0}).session(session))throw new AppError('Gate-out invoice is not verified.',409);
      if(!item.gateIn?.actualGateInAt||!item.gateOut?.approvedAt||item.gateOut?.releasedAt)throw new AppError('Invalid gate-out release status.',409);
      oldStorage=item.storage?.block?{block:item.storage.block,bay:item.storage.bay,row:item.storage.row,tier:item.storage.tier}:null;
      now=new Date();
      item.gateOut.approvalStatus='RELEASED';item.gateOut.releasedAt=now;item.gateOut.releasedBy=adminId(req);
      // Actual release duration follows the inclusive Manila calendar-day policy.
      // Existing paid invoices remain immutable and are not recalculated here.
      item.gateOut.finalDaysInTerminal=storageDaysBetween(item.gateIn.actualGateInAt,now,'CALENDAR_DAYS');
      item.gateOut.remarks=String(req.body?.remarks||item.gateOut.remarks||'').slice(0,500);
      item.inventory.status='RELEASED';item.storage.status='RELEASED';
      item.storage.block=null;item.storage.bay=null;item.storage.row=null;item.storage.tier=null;
      item.status='COMPLETED';item.statusHistory.push({status:'COMPLETED',changedAt:now,note:'Container physically released'});
      advanceWorkflow(item,'CONTAINER_RELEASED',{changedAt:now,note:'Physical release confirmed'});
      await item.save({session});
      if(oldStorage?.block)await StorageMovement.create([{container:item._id,action:'REMOVED',from:oldStorage,performedBy:adminId(req),performedAt:now}],{session});
      await enqueueBookingMail(item,{event:'CONTAINER_RELEASED',title:'Container released',message:`Your container was physically released on ${now.toLocaleString('en-PH',{timeZone:'Asia/Manila'})}.`},session);
      id=item._id;
    });
  }finally{await session.endSession();}
  if(oldStorage?.block)await emitStorageOccupancy(oldStorage.block);
  const item=await findItem(id);
  await auditAdminAction({performedBy:req.admin._id,action:'CONTAINER_RELEASED',changes:{bookingReference:item.bookingReference,containerNumber:item.containerNumber}});
  const data=await notifyWorkflow(item,MODULES.RELEASE_CONTAINER,'release:completed','Container Released',`${item.containerNumber} has been physically released.`);
  emitToAdminModule(MODULES.INVENTORY,'inventory:updated',data);
  emitToAdminModule(MODULES.STORAGE_MONITORING,'storage:container-removed',{id:String(item._id),containerNumber:item.containerNumber});
  res.json({success:true,message:'Physical container release recorded.',data});
});
