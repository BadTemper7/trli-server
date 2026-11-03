import { AppError } from '../utils/http.js';
import { booleanParam, dateRange, enumParam, objectIdParam, prefixSearch, scalar } from '../utils/tableQuery.js';

export const BOOKING_STATUSES = ['DRAFT', 'SUBMITTED', 'REJECTED', 'SCHEDULED', 'READY_FOR_GATE_IN', 'GATED_IN', 'COMPLETED', 'CANCELLED'];
export const WORKFLOW_STAGES = ['BOOKING_SUBMITTED', 'BOOKING_APPROVED', 'READY_FOR_GATE_IN', 'GATE_IN_PAYMENT_SUBMITTED', 'GATE_IN', 'INVENTORY', 'STORAGE', 'GATE_OUT_REQUESTED', 'GATE_OUT_PAYMENT_PENDING', 'GATE_OUT_PAYMENT_SUBMITTED', 'GATE_OUT_APPROVED', 'READY_FOR_RELEASE', 'CONTAINER_RELEASED'];
export const INVOICE_STATUSES = ['UNPAID', 'PAYMENT_SUBMITTED', 'PAID', 'CANCELLED', 'VOID'];
const BOOKING_CATEGORIES = ['ALL', 'GATE_IN_PAYMENT', 'REQUESTABLE_GATE_OUT', 'GATE_OUT_PAYMENT'];
const TRACKING_STATUSES = ['UNKNOWN', 'BOOKED', 'GATED_IN', 'STORED', 'GATE_OUT_APPROVED', 'RELEASED', 'CANCELLED'];

function attachSearch(filter, search, keys) {
  if (search) filter.$or = keys.map(key => ({ [key]: search }));
}

// Shared by GET /pre-advice AND /pre-advice/summary. Company ownership cannot
// be overridden from the query string.
export async function buildBookingFilter(query, company, { global = false } = {}) {
  const filter = { company };
  if (global) return filter;
  const status = enumParam(query, 'status', BOOKING_STATUSES);
  if (status) filter.status = status;
  const workflowStage = enumParam(query, 'stage', WORKFLOW_STAGES);
  if (workflowStage) filter.workflowStage = workflowStage;
  attachSearch(filter, prefixSearch(query), ['bookingReference', 'containerNumber', 'shippingLine']);
  const range = dateRange(query);
  if (range) filter.createdAt = range;
  const category = enumParam(query, 'category', BOOKING_CATEGORIES, 'ALL');
  if (category === 'REQUESTABLE_GATE_OUT') {
    Object.assign(filter, { workflowStage: 'STORAGE', 'storage.status': 'STORED', 'gateOut.approvedAt': null,
      'gateOut.releasedAt': null, 'gateOut.payment.status': { $nin: ['SUBMITTED', 'VERIFIED'] } });
  } else if (category === 'GATE_IN_PAYMENT' || category === 'GATE_OUT_PAYMENT') {
    // Existing semantics depend on invoices actually issued; do not guess from
    // workflowStage and incorrectly include unpaid/unissued charges.
    const Invoice = (await import('../models/Invoice.js')).default;
    filter._id = { $in: await Invoice.distinct('booking', { company, type: category === 'GATE_IN_PAYMENT' ? 'GATE_IN' : 'GATE_OUT' }) };
  }
  return filter;
}

// Shared by the corresponding admin queue list and summary endpoints.
export function buildOperationFilter(query, kind) {
  const filter = {};
  const status = enumParam(query, 'status', BOOKING_STATUSES);
  const stage = enumParam(query, 'stage', WORKFLOW_STAGES);
  if (status) filter.status = status;
  if (stage) filter.workflowStage = stage;
  attachSearch(filter, prefixSearch(query), ['bookingReference', 'containerNumber', 'shippingLine']);
  const range = dateRange(query);
  if (range) filter.createdAt = range;
  if (kind === 'pre-advice') {
    filter.$and = [{ status: { $in: ['SUBMITTED', 'READY_FOR_GATE_IN', 'REJECTED'] } },
      { $or: [{ workflowStage: 'BOOKING_SUBMITTED' }, { workflowStage: 'READY_FOR_GATE_IN' }] }];
    const approval = enumParam(query, 'approval', ['PENDING', 'APPROVED', 'REJECTED']);
    if (approval === 'PENDING') filter.$and.push({ status: 'SUBMITTED', workflowStage: 'BOOKING_SUBMITTED' });
    if (approval === 'APPROVED') filter.$and.push({ status: 'READY_FOR_GATE_IN' });
    if (approval === 'REJECTED') filter.$and.push({ status: 'REJECTED' });
  } else if (kind === 'gate-in' || kind === 'gate-out' || kind === 'release') {
    const stages = kind === 'gate-in' ? ['READY_FOR_GATE_IN', 'GATE_IN_PAYMENT_SUBMITTED']
      : kind === 'gate-out' ? ['GATE_OUT_PAYMENT_SUBMITTED'] : ['READY_FOR_RELEASE'];
    filter.workflowStage = stage ? (stages.includes(stage) ? stage : { $in: [] }) : { $in: stages };
    if (kind === 'gate-in') {
      const queue = enumParam(query, 'queue', ['ALL', 'PAYMENT', 'READY', 'REJECTED'], 'ALL');
      if (queue === 'REJECTED') filter['gateIn.inspection.status'] = 'REJECTED';
      else if (queue !== 'ALL') {
        filter['gateIn.inspection.status'] = { $ne: 'REJECTED' };
        filter['gateIn.payment.status'] = queue === 'READY' ? 'VERIFIED' : { $ne: 'VERIFIED' };
      }
    }
  } else if (kind === 'inventory') {
    filter.status = { $in: ['GATED_IN', 'COMPLETED'] };
    if (!booleanParam(query, 'includeReleased')) filter.workflowStage = { $ne: 'CONTAINER_RELEASED' };
  } else throw new AppError('Unknown operation resource.', 400);
  return filter;
}

export function buildInvoiceFilter(query, { company = null, global = false } = {}) {
  const filter = company ? { company } : {};
  if (global) return filter;
  const status = enumParam(query, 'status', INVOICE_STATUSES);
  const type = enumParam(query, 'type', ['GATE_IN', 'GATE_OUT']);
  if (status) filter.status = status;
  if (type) filter.type = type;
  const requestedCompany = objectIdParam(query, 'company');
  if (!company && requestedCompany) filter.company = requestedCompany;
  const booking = objectIdParam(query, 'booking');
  if (booking) filter.booking = booking;
  const search = prefixSearch(query);
  if (search) filter.number = search;
  const range = dateRange(query);
  if (range) filter.createdAt = range;
  return filter;
}

// Matching logical filters for live + historical container collections.
export function buildContainerFilters(query, { company = null, isAdmin = false, global = false } = {}) {
  const base = { deletedAt: null };
  if (isAdmin && !global && booleanParam(query, 'includeDeleted')) delete base.deletedAt;
  const selected = objectIdParam(query, 'company');
  if (company) base.company = company;
  else if (isAdmin && !global && selected) base.company = selected;
  const live = { ...base }, historical = { ...base };
  if (global) return { live, historical };
  const search = prefixSearch(query);
  if (search) { live.containerNumber = search; historical.containerNumber = search; }
  const status = enumParam(query, 'status', TRACKING_STATUSES);
  if (status) {
    historical.status = status;
    const mapping = {
      STORED: { 'storage.status': 'STORED', 'gateOut.approvedAt': null, 'gateOut.releasedAt': null },
      RELEASED: { 'gateOut.releasedAt': { $ne: null } },
      GATE_OUT_APPROVED: { 'gateOut.approvedAt': { $ne: null }, 'gateOut.releasedAt': null },
      GATED_IN: { 'gateIn.actualGateInAt': { $ne: null }, 'storage.status': { $ne: 'STORED' }, 'gateOut.approvedAt': null },
      BOOKED: { 'gateIn.actualGateInAt': null }, CANCELLED: { status: 'CANCELLED' },
    };
    Object.assign(live, mapping[status] || { workflowStage: status });
  }
  const range = dateRange(query);
  if (range) { live.createdAt = range; historical.$or = [{ originTransactionDate: range }, { createdAt: range }]; }
  return { live, historical };
}

export function summaryScope(query, defaultScope = 'filtered') {
  const value = scalar(query, 'scope').toLowerCase() || defaultScope;
  if (value !== 'global' && value !== 'filtered') throw new AppError('scope must be global or filtered.', 400);
  return value;
}
