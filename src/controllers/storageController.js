import mongoose from 'mongoose';
import PreAdvice from '../models/PreAdvice.js';
import StorageBlock from '../models/StorageBlock.js';
import StorageMovement from '../models/StorageMovement.js';
import HistoricalContainer from '../models/HistoricalContainer.js';
import { getStoredOccupancy, availableStorageSlots, assignStorageClaim, clearStorageClaim, occupiedPositions } from '../services/storageAssignmentService.js';
import { getIO, emitToAdminModule } from '../socket/index.js';
import { MODULES } from '../constants/permissions.js';
import { AppError, asyncHandler } from '../utils/http.js';
import { auditAdminAction } from '../services/adminAuditService.js';
import { advanceWorkflow, ensureWorkflow } from '../utils/preAdviceWorkflow.js';
import { storageDaysBetween } from '../utils/storageDuration.js';

const VALID_STATUS = ['ACTIVE', 'INACTIVE', 'MAINTENANCE', 'FULL'];
const VALID_SIZE = ['20FT', '40FT'];
const adminId = (req) => String(req.admin?.id || 'external-admin');

function cleanBlockInput(body) {
  const name = String(body.name || '').trim().toUpperCase();
  const capacityTeu = Number(body.capacityTeu);
  const containerSize = String(body.containerSize || '').toUpperCase();
  const status = String(body.status || 'ACTIVE').toUpperCase();
  const color = String(body.color || '').toUpperCase();
  const bays = Number(body.layout?.bays ?? body.bays);
  const rows = Number(body.layout?.rows ?? body.rows);
  const tiers = Number(body.layout?.tiers ?? body.tiers);

  if (!name) throw new AppError('Block name is required.', 400);
  if (!Number.isInteger(capacityTeu) || capacityTeu < 1) throw new AppError('Capacity must be a positive whole number.', 400);
  if (!VALID_SIZE.includes(containerSize)) throw new AppError('Container size must be 20FT or 40FT.', 400);
  if (!VALID_STATUS.includes(status)) throw new AppError('Invalid block status.', 400);
  if (!/^#[0-9A-F]{6}$/i.test(color)) throw new AppError('Block color must be a valid hex color.', 400);
  if (![bays, rows, tiers].every((n) => Number.isInteger(n) && n > 0)) throw new AppError('Bays, rows and tiers must be positive whole numbers.', 400);
  const physicalSlots = bays * rows * tiers;
  const unit = containerSize === '40FT' ? 'FEU' : 'TEU';
  if (capacityTeu > physicalSlots) throw new AppError(`Capacity cannot exceed the ${physicalSlots} physical slots available in this block (${physicalSlots} ${unit}).`, 400);

  return { name, capacityTeu, containerSize, status, color, layout: { bays, rows, tiers } };
}

const occupancyMap = getStoredOccupancy;

function blockDto(block, occ = { teu: 0, count: 0 }) {
  const availableTeu = Math.max(0, block.capacityTeu - occ.teu);
  const occupancyRate = block.capacityTeu ? Math.min(100, Math.round((occ.teu / block.capacityTeu) * 100)) : 0;
  const displayStatus = availableTeu <= 0 ? 'FULL' : block.status;
  const capacityUnit = block.containerSize === '40FT' ? 'FEU' : 'TEU';
  return {
    id: String(block._id), name: block.name, capacityTeu: block.capacityTeu,
    containerSize: block.containerSize, status: displayStatus, operationalStatus: block.status,
    color: block.color, layout: block.layout, occupiedTeu: occ.teu, containerCount: occ.count,
    availableTeu, capacityUnit, occupancyRate, physicalSlots: block.layout.bays * block.layout.rows * block.layout.tiers,
    createdAt: block.createdAt, updatedAt: block.updatedAt,
  };
}

export async function emitBlockOccupancy(blockId) {
  const block = await StorageBlock.findById(blockId);
  if (!block) return;
  const map = await occupancyMap([blockId]);
  emitToAdminModule(MODULES.STORAGE_MONITORING, 'storage:occupancy-updated', blockDto(block, map.get(String(blockId))));
}

export const listBlocks = asyncHandler(async (req, res) => {
  const filter = {};
  const search = String(req.query.search || '').trim();
  const status = String(req.query.status || '').trim().toUpperCase();
  const size = String(req.query.size || '').trim().toUpperCase();
  if (search) filter.name = { $regex: search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' };
  if (VALID_STATUS.includes(status)) filter.status = status;
  if (VALID_SIZE.includes(size)) filter.containerSize = size;
  const blocks = await StorageBlock.find(filter).sort({ name: 1 });
  const map = await occupancyMap(blocks.map((b) => b._id));
  res.json({ success: true, message: 'Storage blocks loaded.', data: blocks.map((b) => blockDto(b, map.get(String(b._id)))) });
});

export const getBlock = asyncHandler(async (req, res) => {
  const block = await StorageBlock.findById(req.params.id);
  if (!block) throw new AppError('Storage block not found.', 404);
  const map = await occupancyMap([block._id]);
  res.json({ success: true, message: 'Storage block loaded.', data: blockDto(block, map.get(String(block._id))) });
});

export const createBlock = asyncHandler(async (req, res) => {
  const input = cleanBlockInput(req.body);
  const exists = await StorageBlock.exists({ name: input.name });
  if (exists) throw new AppError('A storage block with this name already exists.', 409);
  const block = await StorageBlock.create({ ...input, createdBy: adminId(req), updatedBy: adminId(req) });
  const data = blockDto(block);
  emitToAdminModule(MODULES.STORAGE_MONITORING, 'storage:block-created', data);
  res.status(201).json({ success: true, message: 'Storage block created.', data });
});

export const updateBlock = asyncHandler(async (req, res) => {
  const input = cleanBlockInput(req.body);
  const block = await StorageBlock.findById(req.params.id);
  if (!block) throw new AppError('Storage block not found.', 404);
  const duplicate = await StorageBlock.exists({ _id: { $ne: block._id }, name: input.name });
  if (duplicate) throw new AppError('A storage block with this name already exists.', 409);
  const map = await occupancyMap([block._id]);
  const occupied = map.get(String(block._id))?.teu || 0;
  if (input.capacityTeu < occupied) { const unit = block.containerSize === '40FT' ? 'FEU' : 'TEU'; throw new AppError(`Capacity cannot be lower than the currently occupied ${occupied} ${unit}.`, 409); }
  if (block.containerSize !== input.containerSize && occupied > 0) throw new AppError('Container size cannot be changed while containers are stored in this block.', 409);
  Object.assign(block, input, { updatedBy: adminId(req) });
  await block.save();
  const data = blockDto(block, map.get(String(block._id)));
  emitToAdminModule(MODULES.STORAGE_MONITORING, 'storage:block-updated', data);
  res.json({ success: true, message: 'Storage block updated.', data });
});

export const deleteBlock = asyncHandler(async (req, res) => {
  const block = await StorageBlock.findById(req.params.id);
  if (!block) throw new AppError('Storage block not found.', 404);
  const assigned = await Promise.all([PreAdvice.exists({ 'storage.block': block._id, 'storage.status': 'STORED', deletedAt:null, 'gateOut.releasedAt':null }), HistoricalContainer.exists({ 'storage.block': block._id, status: { $in: ['GATED_IN', 'STORED', 'GATE_OUT_APPROVED'] }, deletedAt: null, 'gateOut.releasedAt':null })]);
  if (assigned.some(Boolean)) throw new AppError('This block cannot be deleted while containers are assigned to it.', 409);
  await block.deleteOne();
  emitToAdminModule(MODULES.STORAGE_MONITORING, 'storage:block-deleted', { id: String(block._id) });
  res.json({ success: true, message: 'Storage block deleted.', data: { id: String(block._id) } });
});

export const waitingContainers = asyncHandler(async (req, res) => {
  const containers = await PreAdvice.find({
    status: 'GATED_IN',
    $or: [{ 'storage.status': null }, { 'storage.status': 'WAITING_STORAGE' }],
  }).populate('company', 'companyName').sort({ updatedAt: 1 }).limit(500);
  res.json({ success: true, message: 'Waiting containers loaded.', data: containers.map(containerDto) });
});

export const storageSlots = asyncHandler(async(req, res) => {
  const data = await availableStorageSlots(req.params.id);
  res.json({ success: true, data });
});

export const blockContainers = asyncHandler(async (req, res) => {
  const block = await StorageBlock.findById(req.params.id);
  if (!block) throw new AppError('Storage block not found.', 404);
  const [live, historical] = await Promise.all([
    PreAdvice.find({ 'storage.block': block._id, 'storage.status': 'STORED',deletedAt:null,'gateOut.releasedAt':null }).populate('company','companyName').sort({ 'storage.bay':1, 'storage.row':1 }),
    HistoricalContainer.find({ 'storage.block':block._id, status:{ $in:['GATED_IN','STORED','GATE_OUT_APPROVED'] }, deletedAt:null,'gateOut.releasedAt':null }).populate('company','companyName'),
  ]);
  const mapped = [...live.map(x => ({ ...containerDto(x), source:'LIVE' })), ...historical.map(x => ({
    ...x.toObject(), id:String(x._id), source:'HISTORICAL', size:x.containerSize,type:x.containerType,client:x.company?.companyName||'',companyName:x.company?.companyName||'',
    daysInTerminal:x.gateIn?.actualGateInAt?storageDaysBetween(x.gateIn.actualGateInAt,new Date()):0,
  }))];
  res.json({ success:true, message:'Stored containers loaded.', data:mapped });
});

function containerDto(c) {
  return {
    id: String(c._id), bookingReference: c.bookingReference, containerNumber: c.containerNumber,
    containerSize: c.containerSize, size: c.containerSize, containerType: c.containerType, type: c.containerType,
    loadStatus: c.loadStatus, transactionClassification: c.transactionClassification,
    shippingLine: c.shippingLine, company: c.company && typeof c.company === 'object' ? { id: String(c.company._id), companyName: c.company.companyName || '' } : c.company,
    client: c.company?.companyName || '', scheduledGateDateIn: c.scheduledGateDateIn, gateInDate: c.scheduledGateDateIn,
    scheduledGateTimeIn: c.scheduledGateTimeIn, gateInTime: c.scheduledGateTimeIn,
    truckPlateNumber: c.truckPlateNumber, truckPlate: c.truckPlateNumber, driverName: c.driverName, driver: c.driverName,
    hauler: c.hauler, weight: c.weight, cargoDescription: c.cargoDescription || '', remarks: c.remarks || '',
    status: c.status, workflowStage: c.workflowStage, workflowHistory: c.workflowHistory || [], gateIn: c.gateIn || {}, inventory: c.inventory || {}, storage: c.storage || {}, gateOut: c.gateOut || {},
    daysInTerminal: c.gateIn?.actualGateInAt
      ? (c.gateOut?.releasedAt && c.gateOut?.finalDaysInTerminal != null
          ? c.gateOut.finalDaysInTerminal : storageDaysBetween(c.gateIn.actualGateInAt, new Date()))
      : 0,
    createdAt: c.createdAt, updatedAt: c.updatedAt,
  };
}


export const assignContainer = asyncHandler(async(req,res) => {
  const session = await mongoose.startSession();
  let container, block, position, now;
  try {
    await session.withTransaction(async() => {
      block = await StorageBlock.findById(req.params.id).session(session);
      container = await PreAdvice.findById(req.body.containerId).session(session);
      if (!container) throw new AppError('Container record not found.',404);
      if (container.status !== 'GATED_IN' || container.gateOut?.releasedAt) throw new AppError('Only gated-in, unreleased containers can enter storage.',409);
      if (container.storage?.status === 'STORED') throw new AppError('This container already has an assigned storage slot.',409);
      position = await assignStorageClaim({ blockId:block?._id, position:req.body, containerSize:container.containerSize,
        source:'LIVE', containerId:container._id, session });
      now = new Date();
      container.storage = { status:'STORED',...position,storedAt:now,storedBy:adminId(req) };
      container.inventory.status = 'IN_STORAGE';
      ensureWorkflow(container);
      advanceWorkflow(container,'STORAGE',{ changedAt:now,note:`Stored in ${block.name}` });
      await container.save({session});
      await StorageMovement.create([{container:container._id,action:'ASSIGNED',to:position,performedBy:adminId(req),performedAt:now}],{session});
      await auditAdminAction({performedBy:req.admin._id,action:'STORAGE_ASSIGNED',changes:{module:'STORAGE_MONITORING',containerNumber:container.containerNumber,bookingReference:container.bookingReference,containerId:String(container._id),after:{storage:{blockName:block.name,bay:position.bay,row:position.row,tier:position.tier}}},session});
    });
  } finally { await session.endSession(); }
  await container.populate('company','companyName');
  await container.populate('storage.block','name');
  const data=containerDto(container);
  emitToAdminModule(MODULES.STORAGE_MONITORING,'storage:container-assigned',data);
  emitToAdminModule(MODULES.INVENTORY,'inventory:updated',data);
  getIO()?.to(`company:${container.company?._id || container.company}`).emit('pre-advice:workflow-updated',{
    id:String(container._id),workflowStage:container.workflowStage,workflowHistory:container.workflowHistory,storage:container.storage,updatedAt:container.updatedAt,
  });
  await emitBlockOccupancy(block._id);
  res.json({success:true,message:'Container assigned to storage.',data});
});

export const relocateContainer = asyncHandler(async(req,res) => {
  const session=await mongoose.startSession();
  let container,destination,old,position;
  try {
    await session.withTransaction(async() => {
      container=await PreAdvice.findById(req.params.containerId).session(session);
      if (!container || container.storage?.status !== 'STORED' || container.gateOut?.releasedAt) throw new AppError('Stored container not found.',404);
      destination=await StorageBlock.findById(req.body.blockId).session(session);
      old={block:container.storage.block,bay:container.storage.bay,row:container.storage.row,tier:container.storage.tier};
      const previousBlock=await StorageBlock.findById(old.block).select('name').session(session).lean();
      old.blockName=previousBlock?.name||'';
      position=await assignStorageClaim({blockId:destination?._id,position:req.body,containerSize:container.containerSize,
        source:'LIVE',containerId:container._id,session});
      container.storage={ status:'STORED',...position,storedAt:container.storage.storedAt||new Date(),storedBy:adminId(req) };
      await container.save({session});
      await StorageMovement.create([{container:container._id,action:'RELOCATED',from:old,to:position,performedBy:adminId(req)}],{session});
      await auditAdminAction({performedBy:req.admin._id,action:'STORAGE_UPDATED',changes:{module:'STORAGE_MONITORING',containerNumber:container.containerNumber,bookingReference:container.bookingReference,containerId:String(container._id),before:{storage:old},after:{storage:{...position,blockName:destination.name}}},session});
    });
  } finally { await session.endSession(); }
  await container.populate('company','companyName');
  await container.populate('storage.block','name');
  const data=containerDto(container);
  emitToAdminModule(MODULES.STORAGE_MONITORING,'storage:container-relocated',data);
  emitToAdminModule(MODULES.INVENTORY,'inventory:updated',data);
  await emitBlockOccupancy(old.block);await emitBlockOccupancy(destination._id);
  res.json({success:true,message:'Container relocated.',data});
});

// Staging is an operational flag, not physical release. Do not free the
// occupied position or create a removal movement until Release Container.
export const removeContainer = asyncHandler(async (req, res) => {
  const container = await PreAdvice.findById(req.params.containerId).populate('company', 'companyName');
  if (!container || container.storage?.status !== 'STORED') throw new AppError('Stored container not found.', 404);
  if (container.workflowStage !== 'READY_FOR_RELEASE' || !container.gateOut?.approvedAt) {
    throw new AppError('A verified and approved gate-out is required before release staging.', 409);
  }
  if (container.inventory.status !== 'RELEASE_PENDING') {
    container.inventory.status = 'RELEASE_PENDING';
    await container.save();
  }
  const data=containerDto(container);
  emitToAdminModule(MODULES.STORAGE_MONITORING, 'storage:container-staged', data);
  getIO()?.to(`company:${container.company?._id || container.company}`).emit('pre-advice:workflow-updated', {
    id:String(container._id),workflowStage:container.workflowStage,workflowHistory:container.workflowHistory,
    storage:container.storage,inventory:container.inventory,updatedAt:container.updatedAt,
  });
  res.json({ success:true,message:'Container flagged for release staging. Storage occupancy remains reserved until physical release.',data });
});

export const movementHistory = asyncHandler(async (req, res) => {
  const rows = await StorageMovement.find({ container: req.params.containerId }).sort({ performedAt: -1 }).limit(100);
  res.json({ success: true, message: 'Storage movement history loaded.', data: rows });
});
