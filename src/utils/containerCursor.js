import mongoose from 'mongoose';
import { createHash } from 'node:crypto';
import { AppError } from './http.js';
import { scalar } from './tableQuery.js';

const hash = (filters) => createHash('sha256').update(JSON.stringify(filters)).digest('hex').slice(0, 24);
export function parseContainerCursor(query, filters) {
  const input = scalar(query, 'cursor');
  if (!input) return null;
  if (input.length > 1024 || !/^[A-Za-z0-9_-]+$/.test(input)) throw new AppError('Invalid container cursor.', 400);
  let token;
  try { token = JSON.parse(Buffer.from(input, 'base64url').toString('utf8')); }
  catch { throw new AppError('Invalid container cursor.', 400); }
  if (token?.v !== 1 || token?.hash !== hash(filters) || !['LIVE', 'HISTORICAL'].includes(token.source) ||
      !mongoose.isValidObjectId(token.id) || !Number.isFinite(Date.parse(token.createdAt))) {
    throw new AppError('Container cursor does not match the current filters.', 400);
  }
  return { source: token.source, id: new mongoose.Types.ObjectId(token.id), createdAt: new Date(token.createdAt) };
}
export function sourceAfterCursor(base, cursor, source) {
  if (!cursor) return base;
  const date = cursor.createdAt;
  if (source !== cursor.source) {
    const comparison = source === 'LIVE' ? { $lt: date } : { $lte: date };
    return { $and: [base, { createdAt: comparison }] };
  }
  return { $and: [base, { $or: [{ createdAt: { $lt: date } }, { createdAt: date, _id: { $lt: cursor.id } }] }] };
}
export function serializeContainerCursor(item, filters) {
  if (!item) return null;
  return Buffer.from(JSON.stringify({ v: 1, hash: hash(filters), source: item.source,
    id: String(item._id), createdAt: new Date(item.createdAt).toISOString() })).toString('base64url');
}
export function compareContainers(a, b) {
  const dates = new Date(b.createdAt) - new Date(a.createdAt);
  if (dates) return dates;
  if (a.source !== b.source) return a.source === 'LIVE' ? -1 : 1;
  return String(a._id) > String(b._id) ? -1 : String(a._id) < String(b._id) ? 1 : 0;
}
