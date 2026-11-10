import PreAdvice from '../models/PreAdvice.js';
import Invoice from '../models/Invoice.js';
import HistoricalContainer from '../models/HistoricalContainer.js';
import { inventoryTotals } from './inventoryService.js';
import { getCachedSummary } from '../utils/summaryCache.js';
import { buildBookingFilter, buildInvoiceFilter, buildOperationFilter, buildContainerFilters, summaryScope } from './tableFilters.js';

const countIf = (expression) => ({ $sum: { $cond: [expression, 1, 0] } });
const blankBooking = () => ({ all: 0, total: 0, pending: 0, yard: 0, complete: 0, active: 0, cancelled: 0 });
const bookingGroup = { _id: null, all: { $sum: 1 },
  pending: countIf({ $in: ['$status', ['DRAFT', 'SUBMITTED']] }),
  yard: countIf({ $or: [{ $in: ['$status', ['READY_FOR_GATE_IN', 'GATED_IN']] },
    { $in: ['$workflowStage', ['GATE_IN_PAYMENT_SUBMITTED', 'GATE_IN', 'INVENTORY', 'STORAGE']] }] }),
  complete: countIf({ $or: [{ $eq: ['$status', 'COMPLETED'] }, { $eq: ['$workflowStage', 'CONTAINER_RELEASED'] }] }),
  active: countIf({ $not: [{ $in: ['$status', ['CANCELLED', 'REJECTED', 'COMPLETED']] }] }),
  cancelled: countIf({ $eq: ['$status', 'CANCELLED'] }),
};
export async function bookingSummary(filter) {
  const [data] = await PreAdvice.aggregate([{ $match: filter }, { $group: bookingGroup }]);
  return { ...blankBooking(), ...data, _id: undefined, all: data?.all || 0, total: data?.all || 0 };
}
export async function getBookingSummary(query, company, defaultScope = 'filtered') {
  const scope = summaryScope(query, defaultScope);
  const filter = await buildBookingFilter(query, company, { global: scope === 'global' });
  const loader = () => bookingSummary(filter);
  return { scope, summary: scope === 'global' ? await getCachedSummary(`booking:${company}`, loader) : await loader() };
}
const blankInvoice = () => ({ total: 0, unpaid: 0, partiallyPaid: 0, pending: 0, gateInPending: 0, paid: 0, cancelled: 0, void: 0,
  totalAmount: 0, vatAmount: 0, vatableSales: 0, nonVatableSales: 0, amountPaid: 0, outstandingBalance: 0 });
export async function invoiceSummary(filter) {
  const [data] = await Invoice.aggregate([{ $match: filter }, { $group: { _id: null,
    total: { $sum: 1 }, unpaid: countIf({ $in: ['$status', ['UNPAID','PARTIALLY_PAID']] }),
    partiallyPaid: countIf({ $eq: ['$status','PARTIALLY_PAID'] }),
    pending: countIf({ $eq: ['$status', 'PAYMENT_SUBMITTED'] }),
    gateInPending: countIf({ $and: [{ $eq: ['$status', 'PAYMENT_SUBMITTED'] }, { $eq: ['$type', 'GATE_IN'] }] }),
    paid: countIf({ $eq: ['$status', 'PAID'] }),
    cancelled: countIf({ $eq: ['$status', 'CANCELLED'] }), void: countIf({ $eq: ['$status', 'VOID'] }),
    totalAmount: { $sum: '$total' }, vatAmount: { $sum: '$vat' },
    vatableSales: { $sum: '$vatableSales' }, nonVatableSales: { $sum: '$nonVatableSales' },
    amountPaid: { $sum: '$paidAmount' }, outstandingBalance: { $sum: '$balance' },
  } }]);
  return { ...blankInvoice(), ...data, _id: undefined };
}
export async function getInvoiceSummary(query, company = null, defaultScope = 'filtered') {
  const scope = summaryScope(query, defaultScope);
  const filter = buildInvoiceFilter(query, { company, global: scope === 'global' });
  const loader = () => invoiceSummary(filter);
  return { scope, summary: scope === 'global' ? await getCachedSummary(`invoice:${company || 'admin'}`, loader) : await loader() };
}
const blankGateIn = () => ({ all: 0, total: 0, payment: 0, ready: 0, rejected: 0 });
const blankInventory = () => ({ all: 0, total: 0, stored: 0, waitingStorage: 0 });
export async function operationSummary(filter, kind) {
  if (kind !== 'gate-in' && kind !== 'inventory') return bookingSummary(filter);
  const rejected = { $eq: ['$gateIn.inspection.status', 'REJECTED'] };
  const invoiceVerified = { $eq: ['$gateIn.payment.status', 'VERIFIED'] };
  const group = kind === 'gate-in' ? { _id: null, all: { $sum: 1 },
    payment: countIf({ $and: [{ $not: [rejected] }, { $not: [invoiceVerified] }] }),
    ready: countIf({ $and: [{ $not: [rejected] }, invoiceVerified] }),
    rejected: countIf(rejected),
  } : { _id: null, all: { $sum: 1 },
    stored: countIf({ $eq: ['$storage.status', 'STORED'] }),
    waitingStorage: countIf({ $or: [
      { $eq: ['$storage.status', 'WAITING_STORAGE'] },
      { $eq: [{ $ifNull: ['$storage.status', null] }, null] },
    ] }),
  };
  const [data] = await PreAdvice.aggregate([{ $match: filter }, { $group: group }]);
  const blank = kind === 'gate-in' ? blankGateIn() : blankInventory();
  return { ...blank, ...data, _id: undefined, total: data?.all || 0 };
}
export async function getOperationSummary(query, kind) {
  const scope = summaryScope(query);
  // Queue tabs are status breakdowns: show all statuses matching search even
  // when one queue is selected, so their card counts stay comparable.
  const filters = scope === 'global' ? {} : { ...query, queue: undefined };
  const filter = kind === 'inventory' ? null : buildOperationFilter(filters,kind);
  const loader = () => kind === 'inventory' ? inventoryTotals(filters) : operationSummary(filter,kind);
  return { scope, summary: scope === 'global' ? await getCachedSummary(`operations:${kind}`, loader) : await loader() };
}
export async function getContainerSummary(query, company, isAdmin) {
  const scope = summaryScope(query);
  const { live, historical } = buildContainerFilters(query, { company, isAdmin, global: scope === 'global' });
  const loader = async () => {
    const [[a], [b]] = await Promise.all([
      PreAdvice.aggregate([{ $match: live }, { $group: { _id: null, total: { $sum: 1 },
        gatedIn: countIf({ $ne: [{ $ifNull: ['$gateIn.actualGateInAt', null] }, null] }),
        stored: countIf({ $and: [{ $eq: ['$storage.status', 'STORED'] },
          { $eq: [{ $ifNull: ['$gateOut.approvedAt', null] }, null] },
          { $eq: [{ $ifNull: ['$gateOut.releasedAt', null] }, null] }] }),
        released: countIf({ $ne: [{ $ifNull: ['$gateOut.releasedAt', null] }, null] }) } }]),
      HistoricalContainer.aggregate([{ $match: historical }, { $group: { _id: null, total: { $sum: 1 },
        gatedIn: countIf({ $in: ['$status', ['GATED_IN', 'STORED', 'GATE_OUT_APPROVED']] }),
        stored: countIf({ $eq: ['$status', 'STORED'] }), released: countIf({ $eq: ['$status', 'RELEASED'] }) } }]),
    ]);
    return Object.fromEntries(['total', 'gatedIn', 'stored', 'released'].map(key => [key, (a?.[key] || 0) + (b?.[key] || 0)]));
  };
  return { scope, summary: scope === 'global' ? await getCachedSummary(`containers:${company || 'admin'}`, loader) : await loader() };
}
