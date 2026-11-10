import mongoose from 'mongoose';
import PreAdvice from '../models/PreAdvice.js';
import HistoricalContainer from '../models/HistoricalContainer.js';
import StorageBlock from '../models/StorageBlock.js';
import StorageSlotClaim from '../models/StorageSlotClaim.js';
import { AppError } from '../utils/http.js';

export const ACTIVE_HISTORICAL = ['GATED_IN', 'STORED', 'GATE_OUT_APPROVED'];
export const liveStorageFilter = block => ({ 'storage.block': block, 'storage.status': 'STORED', deletedAt: null, 'gateOut.releasedAt': null });
export const historicalStorageFilter = block => ({ 'storage.block': block, status: { $in: ACTIVE_HISTORICAL }, deletedAt: null, 'gateOut.releasedAt': null });
const options = session => session ? { session } : {};
const str = value => String(value ?? '');

export function positionKey(position) {
  return `${str(position.block)}:${position.bay}:${position.row}:${position.tier}`;
}
export function parsePosition(block, input) {
  if (!block) throw new AppError('Storage block does not exist.', 404);
  const position = Object.fromEntries(['bay', 'row', 'tier'].map(key => [key, Number(input?.[key])]));
  if (!Object.values(position).every(Number.isInteger)) throw new AppError('Choose a valid bay, row and tier.', 400);
  if (position.bay < 1 || position.bay > block.layout.bays || position.row < 1 || position.row > block.layout.rows || position.tier < 1 || position.tier > block.layout.tiers) {
    throw new AppError('Slot is outside the selected storage block.', 400);
  }
  return { block: block._id, ...position };
}
export function slotIsSame(a, b) {
  return a && b && positionKey(a) === positionKey(b);
}
export async function getStoredOccupancy(blockIds, session = null) {
  const ids = blockIds.map(id => new mongoose.Types.ObjectId(str(id)));
  if (!ids.length) return new Map();
  const queries = [
    () => PreAdvice.aggregate([{ $match: { 'storage.block': { $in: ids }, 'storage.status': 'STORED', deletedAt: null, 'gateOut.releasedAt': null } }, { $group: { _id: '$storage.block', count: { $sum: 1 } } }]).session(session),
    () => HistoricalContainer.aggregate([{ $match: { 'storage.block': { $in: ids }, status: { $in: ACTIVE_HISTORICAL }, deletedAt: null, 'gateOut.releasedAt': null } }, { $group: { _id: '$storage.block', count: { $sum: 1 } } }]).session(session),
  ];
  // MongoDB does not support parallel operations using the same transaction session.
  const [live, history] = session
    ? [await queries[0](), await queries[1]()]
    : await Promise.all(queries.map(query => query()));
  const counts = new Map();
  for (const group of [...live, ...history]) {
    const id = str(group._id);
    const count = (counts.get(id)?.count || 0) + group.count;
    counts.set(id, { teu: count, count });
  }
  return counts;
}
export async function occupiedPositions(blockId, session = null) {
  const queries = [
    () => PreAdvice.find(liveStorageFilter(blockId)).select('containerNumber storage').session(session).lean(),
    () => HistoricalContainer.find(historicalStorageFilter(blockId)).select('containerNumber storage').session(session).lean(),
  ];
  const [live, history] = session
    ? [await queries[0](), await queries[1]()]
    : await Promise.all(queries.map(query => query()));
  return [...live.map(doc => ({ ...doc, source: 'LIVE' })), ...history.map(doc => ({ ...doc, source: 'HISTORICAL' }))];
}
export async function availableStorageSlots(blockId) {
  const block = await StorageBlock.findById(blockId).lean();
  if (!block) throw new AppError('Storage block not found.', 404);
  const occupied = await occupiedPositions(block._id);
  const used = new Map(occupied.map(doc => [positionKey(doc.storage), doc]));
  const slots = [];
  for (let bay = 1; bay <= block.layout.bays; bay++) for (let row = 1; row <= block.layout.rows; row++) for (let tier = 1; tier <= block.layout.tiers; tier++) {
    const position = { block: block._id, bay, row, tier };
    const existing = used.get(positionKey(position));
    slots.push({ bay, row, tier, label: `Bay ${bay} / Row ${row} / Tier ${tier}`, available: !existing && block.status === 'ACTIVE' && occupied.length < block.capacityTeu, occupied: Boolean(existing) });
  }
  return { block: { id: str(block._id), name: block.name, containerSize: block.containerSize, status: block.status, capacityTeu: block.capacityTeu }, occupied: occupied.length, available: Math.max(0, block.capacityTeu - occupied.length), slots };
}
/** Validate physical occupancy against BOTH collections inside the transaction. */
export async function validateStorageAssignment({ block, position, containerSize, source, containerId, session }) {
  if (!block || block.status !== 'ACTIVE') throw new AppError('Only active blocks accept container assignments.', 409);
  if (block.containerSize !== containerSize) throw new AppError(`This block accepts ${block.containerSize} containers only.`, 409);
  const parsed = parsePosition(block, position);
  const occupied = await occupiedPositions(block._id, session);
  if (occupied.some(doc => str(doc._id) !== str(containerId) || doc.source !== source ? slotIsSame(doc.storage, parsed) : false)) {
    throw new AppError('The selected storage slot is already occupied.', 409);
  }
  if (occupied.filter(doc => str(doc._id) !== str(containerId) || doc.source !== source).length >= block.capacityTeu) {
    throw new AppError('The selected block is at capacity.', 409);
  }
  return parsed;
}
/** Must run in a MongoDB transaction. Serializing assignments on StorageBlock
 * makes capacity checks safe when two users select different last available slots. */
export async function assignStorageClaim({ blockId, position, containerSize, source, containerId, session }) {
  if (!session) throw new Error('Storage assignment requires a database transaction.');
  const block = await StorageBlock.findOneAndUpdate({ _id: blockId }, { $inc: { occupancyRevision: 1 } }, { session, new: true });
  const parsed = await validateStorageAssignment({ block, position, containerSize, source, containerId, session });
  await StorageSlotClaim.deleteOne({ source, container: containerId }, options(session));
  try {
    await StorageSlotClaim.create([{ ...parsed, source, container: containerId }], options(session));
  } catch (error) {
    if (error?.code === 11000) throw new AppError('That slot or container has already been assigned. Refresh storage availability.', 409);
    throw error;
  }
  return parsed;
}
export async function clearStorageClaim({ source, containerId, session }) {
  await StorageSlotClaim.deleteOne({ source, container: containerId }, options(session));
}
export async function verifyStorageClaims() {
  const [live, history] = await Promise.all([
    PreAdvice.find({ 'storage.status': 'STORED', 'storage.block': { $ne: null }, deletedAt: null, 'gateOut.releasedAt': null }).select('_id storage containerSize').lean(),
    HistoricalContainer.find({ status: { $in: ACTIVE_HISTORICAL }, 'storage.block': { $ne: null }, deletedAt: null, 'gateOut.releasedAt': null }).select('_id storage containerSize').lean(),
  ]);
  const entries = [...live.map(doc => ({ doc, source: 'LIVE' })), ...history.map(doc => ({ doc, source: 'HISTORICAL' }))];
  const seen = new Set();
  for (const { doc, source } of entries) {
    const key = positionKey(doc.storage);
    if (seen.has(key)) throw new AppError(`Existing physical storage conflict at ${key}. Resolve before migration.`, 409);
    seen.add(key);
    if (!['bay', 'row', 'tier'].every(field => Number.isInteger(doc.storage[field]))) throw new AppError(`Invalid legacy storage position for ${source} ${doc._id}.`, 409);
  }
  return entries;
}
