import mongoose from 'mongoose';
import PreAdvice from '../models/PreAdvice.js';
import StorageBlock from '../models/StorageBlock.js';
import StorageMovement from '../models/StorageMovement.js';
import { getIO, emitToAdminModule } from '../socket/index.js';
import { MODULES } from '../constants/permissions.js';
import { AppError, asyncHandler } from '../utils/http.js';
import { advanceWorkflow, ensureWorkflow } from '../utils/preAdviceWorkflow.js';

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

async function occupancyMap(blockIds = []) {
  const ids = blockIds.map((id) => new mongoose.Types.ObjectId(id));
  const rows = await PreAdvice.aggregate([
    { $match: { 'storage.status': 'STORED', 'storage.block': { $in: ids } } },
    { $group: { _id: '$storage.block', teu: { $sum: 1 }, count: { $sum: 1 } } },
  ]);
  return new Map(rows.map((row) => [String(row._id), { teu: row.teu, count: row.count }]));
}

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

async function emitBlockOccupancy(blockId) {
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
  const assigned = await PreAdvice.exists({ 'storage.block': block._id, 'storage.status': 'STORED' });
  if (assigned) throw new AppError('This block cannot be deleted while containers are assigned to it.', 409);
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

export const blockContainers = asyncHandler(async (req, res) => {
  const block = await StorageBlock.findById(req.params.id);
  if (!block) throw new AppError('Storage block not found.', 404);
  const containers = await PreAdvice.find({ 'storage.block': block._id, 'storage.status': 'STORED' })
    .populate('company', 'companyName').sort({ 'storage.bay': 1, 'storage.row': 1, 'storage.tier': 1 });
  res.json({ success: true, message: 'Stored containers loaded.', data: containers.map(containerDto) });
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
    createdAt: c.createdAt, updatedAt: c.updatedAt,
  };
}

async function validatePosition(block, container, position, ignoreContainerId = null) {
  if (!block) throw new AppError('Storage block not found.', 404);
  if (block.status !== 'ACTIVE') throw new AppError(`Block ${block.name} is ${block.status} and cannot receive containers.`, 409);
  if (container.containerSize !== block.containerSize) throw new AppError(`This block accepts ${block.containerSize} containers only.`, 409);
  const bay = Number(position.bay), row = Number(position.row), tier = Number(position.tier);
  if (![bay, row, tier].every(Number.isInteger)) throw new AppError('Bay, row and tier are required whole numbers.', 400);
  if (bay < 1 || bay > block.layout.bays || row < 1 || row > block.layout.rows || tier < 1 || tier > block.layout.tiers) throw new AppError('Selected storage position is outside the block layout.', 400);
  const conflictFilter = { 'storage.block': block._id, 'storage.bay': bay, 'storage.row': row, 'storage.tier': tier, 'storage.status': 'STORED' };
  if (ignoreContainerId) conflictFilter._id = { $ne: ignoreContainerId };
  if (await PreAdvice.exists(conflictFilter)) throw new AppError('That storage position is already occupied.', 409);
  const map = await occupancyMap([block._id]);
  const used = map.get(String(block._id))?.teu || 0;
  const incoming = 1;
  if (used + incoming > block.capacityTeu && String(container.storage?.block || '') !== String(block._id)) throw new AppError('The storage block does not have enough available capacity.', 409);
  return { bay, row, tier };
}

export const assignContainer = asyncHandler(async (req, res) => {
  const block = await StorageBlock.findById(req.params.id);
  const container = await PreAdvice.findById(req.body.containerId).populate('company', 'companyName');
  if (!container) throw new AppError('Container record not found.', 404);
  if (container.status !== 'GATED_IN') throw new AppError('Only gated-in containers can be assigned to storage.', 409);
  if (container.storage?.status === 'STORED') throw new AppError('Container is already assigned to storage.', 409);
  const position = await validatePosition(block, container, req.body);
  const now = new Date();
  container.storage = { status: 'STORED', block: block._id, ...position, storedAt: now, storedBy: adminId(req) };
  container.inventory.status = 'IN_STORAGE';
  ensureWorkflow(container);
  advanceWorkflow(container, 'STORAGE', { changedAt: now, note: `Stored in ${block.name}` });
  try { await container.save(); } catch (error) { if (error?.code === 11000) throw new AppError('That storage position was taken by another operator. Choose another position.', 409); throw error; }
  await container.populate('storage.block', 'name');
  await StorageMovement.create({ container: container._id, action: 'ASSIGNED', to: { block: block._id, ...position }, performedBy: adminId(req), performedAt: now });
  const data = containerDto(container);
  emitToAdminModule(MODULES.STORAGE_MONITORING, 'storage:container-assigned', data);
  emitToAdminModule(MODULES.GATE_OUT, 'gate-out:queue-invalidated', { id: String(container._id) });
  getIO()?.to(`company:${container.company?._id || container.company}`).emit('pre-advice:workflow-updated', {
    id: String(container._id), workflowStage: container.workflowStage, workflowHistory: container.workflowHistory, storage: container.storage, updatedAt: container.updatedAt,
  });
  await emitBlockOccupancy(block._id);
  res.json({ success: true, message: 'Container assigned to storage.', data });
});

export const relocateContainer = asyncHandler(async (req, res) => {
  const container = await PreAdvice.findById(req.params.containerId).populate('company', 'companyName');
  if (!container || container.storage?.status !== 'STORED') throw new AppError('Stored container not found.', 404);
  const destination = await StorageBlock.findById(req.body.blockId);
  const old = { block: container.storage.block, bay: container.storage.bay, row: container.storage.row, tier: container.storage.tier };
  const position = await validatePosition(destination, container, req.body, container._id);
  container.storage = { status: 'STORED', block: destination._id, ...position, storedAt: new Date(), storedBy: adminId(req) };
  try { await container.save(); } catch (error) { if (error?.code === 11000) throw new AppError('That destination position was taken by another operator.', 409); throw error; }
  await StorageMovement.create({ container: container._id, action: 'RELOCATED', from: old, to: { block: destination._id, ...position }, performedBy: adminId(req) });
  const data = containerDto(container);
  emitToAdminModule(MODULES.STORAGE_MONITORING, 'storage:container-relocated', data);
  await emitBlockOccupancy(old.block);
  await emitBlockOccupancy(destination._id);
  res.json({ success: true, message: 'Container relocated.', data });
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
