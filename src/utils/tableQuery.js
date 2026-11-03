import { createHash } from 'node:crypto';
import { AppError } from './http.js';

// All table query input passes through these explicit, bounded parsers. Never
// pass req.query directly to Mongoose, including as a sort or projection.
export function scalar(query, key) {
  const value = query?.[key];
  if (value === undefined || value === null || value === '') return '';
  if (typeof value !== 'string' && typeof value !== 'number') throw new AppError(`Invalid ${key} parameter.`, 400);
  return String(value).trim();
}
export function enumParam(query, key, allowed, fallback = '') {
  const value = scalar(query, key).toUpperCase();
  if (!value) return fallback;
  if (!allowed.includes(value)) throw new AppError(`Invalid ${key} parameter.`, 400);
  return value;
}
export function booleanParam(query, key) {
  const value = scalar(query, key);
  if (!value || value === 'false' || value === '0') return false;
  if (value === 'true' || value === '1') return true;
  throw new AppError(`Invalid ${key} parameter.`, 400);
}
export function objectIdParam(query, key) {
  const value = scalar(query, key);
  if (value && !/^[a-fA-F0-9]{24}$/.test(value)) throw new AppError(`Invalid ${key} identifier.`, 400);
  return value;
}
export function prefixSearch(query, key = 'search', maxLength = 64) {
  const value = scalar(query, key);
  if (value.length > maxLength) throw new AppError(`${key} is limited to ${maxLength} characters.`, 400);
  return value ? { $regex: `^${value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, $options: 'i' } : null;
}
export function dateRange(query, { fromKey = 'from', toKey = 'to', timezone = '+08:00' } = {}) {
  const parse = (key) => {
    const text = scalar(query, key);
    if (!text) return null;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) throw new AppError(`Invalid ${key} date. Use YYYY-MM-DD.`, 400);
    const date = new Date(`${text}T00:00:00${timezone}`);
    if (!Number.isFinite(date.getTime()) || new Date(date.getTime() + 8 * 3600000).toISOString().slice(0, 10) !== text) {
      throw new AppError(`Invalid ${key} date.`, 400);
    }
    return date;
  };
  const from = parse(fromKey), end = parse(toKey);
  if (from && end && end < from) throw new AppError('The end date cannot precede the start date.', 400);
  return from || end ? { ...(from ? { $gte: from } : {}), ...(end ? { $lt: new Date(end.getTime() + 86400000) } : {}) } : null;
}
export function pageOptions(query, { defaultLimit = 20, maxLimit = 100, sorts = ['createdAt'], defaultSort = 'createdAt', defaultOrder = 'desc' } = {}) {
  const pageText = scalar(query, 'page'), limitText = scalar(query, 'limit');
  if (pageText && !/^-?\d+$/.test(pageText)) throw new AppError('page must be an integer.', 400);
  if (limitText && !/^\d+$/.test(limitText)) throw new AppError('limit must be a positive integer.', 400);
  const page = pageText ? Math.max(1, Number(pageText)) : 1;
  const limit = limitText ? Math.min(maxLimit, Number(limitText)) : defaultLimit;
  if (!Number.isSafeInteger(page) || !Number.isSafeInteger(limit) || limit < 1) throw new AppError('Invalid page or limit.', 400);
  const sort = scalar(query, 'sort') || defaultSort;
  if (!sorts.includes(sort)) throw new AppError('Unsupported sort field.', 400);
  const order = scalar(query, 'order').toLowerCase() || defaultOrder;
  if (!['asc', 'desc'].includes(order)) throw new AppError('order must be asc or desc.', 400);
  const direction = order === 'asc' ? 1 : -1;
  const sortSpec = sort === '_id' ? { _id: direction } : { [sort]: direction, _id: direction };
  const cursorToken = scalar(query, 'cursor');
  const paginationMode = scalar(query, 'pagination') || (cursorToken ? 'cursor' : 'offset');
  if (!['offset', 'cursor'].includes(paginationMode) || (paginationMode === 'offset' && cursorToken)) {
    throw new AppError('Invalid pagination mode or cursor combination.', 400);
  }
  return { page, limit, sort, order, sortSpec, direction, paginationMode };
}
export function pageInfo(page, limit, total) {
  return { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)), pages: Math.ceil(total / limit) };
}

// Keyset mode scales to deep pages without an ever-growing MongoDB skip().
// Cursors encode the last sort tuple and filter hash, not a raw Mongo query.
const fingerprint = (filter) => createHash('sha256').update(JSON.stringify(filter)).digest('hex').slice(0, 24);
export function cursorCondition(query, filter, options) {
  if (options.paginationMode !== 'cursor') return filter;
  const cursor = scalar(query, 'cursor');
  if (!cursor) return filter;
  if (cursor.length > 1024 || !/^[A-Za-z0-9_-]+$/.test(cursor)) throw new AppError('Invalid cursor.', 400);
  let parsed;
  try { parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')); }
  catch { throw new AppError('Invalid cursor.', 400); }
  if (parsed?.v !== 1 || parsed.sort !== options.sort || parsed.order !== options.order || parsed.filter !== fingerprint(filter) || !/^[a-fA-F0-9]{24}$/.test(parsed.id)) {
    throw new AppError('Cursor does not match the requested filter and sort.', 400);
  }
  const op = options.direction === 1 ? '$gt' : '$lt';
  if (options.sort === '_id') return { $and: [filter, { _id: { [op]: parsed.id } }] };
  const value = ['createdAt', 'updatedAt'].includes(options.sort) ? new Date(parsed.value) : parsed.value;
  const acceptable = value instanceof Date ? Number.isFinite(value.getTime()) :
    typeof value === 'string' ? value.length <= 512 : typeof value === 'number' && Number.isFinite(value);
  if (!acceptable) {
    throw new AppError('Invalid cursor value.', 400);
  }
  return { $and: [filter, { $or: [
    { [options.sort]: { [op]: value } },
    { [options.sort]: value, _id: { [op]: parsed.id } },
  ] }] };
}
export function nextCursor(items, baseFilter, options) {
  const last = items.at(-1);
  if (!last) return null;
  const value = last[options.sort];
  return Buffer.from(JSON.stringify({ v: 1, sort: options.sort, order: options.order, filter: fingerprint(baseFilter), id: String(last._id), value: value instanceof Date ? value.toISOString() : value ?? null })).toString('base64url');
}

export async function listDocuments(model, filter, query, { select, populate, ...options } = {}) {
  const paging = pageOptions(query, options);
  const cursorMode = paging.paginationMode === 'cursor';
  const effectiveFilter = cursorCondition(query, filter, paging);
  let dbQuery = model.find(effectiveFilter).select(select).sort(paging.sortSpec).lean();
  if (populate) dbQuery = dbQuery.populate(populate);
  if (cursorMode) {
    const docs = await dbQuery.limit(paging.limit + 1);
    const hasMore = docs.length > paging.limit;
    const items = docs.slice(0, paging.limit);
    return { items, pagination: { page: 1, limit: paging.limit, nextCursor: hasMore ? nextCursor(items, filter, paging) : null, hasMore }, cursor: true };
  }
  const [items, total] = await Promise.all([
    dbQuery.skip((paging.page - 1) * paging.limit).limit(paging.limit),
    model.countDocuments(filter),
  ]);
  return { items, pagination: pageInfo(paging.page, paging.limit, total), cursor: false };
}
