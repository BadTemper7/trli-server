import PreAdvice from '../models/PreAdvice.js';
import StorageBlock from '../models/StorageBlock.js';
import { asyncHandler } from '../utils/http.js';

const startOfDay = (date = new Date()) => new Date(date.getFullYear(), date.getMonth(), date.getDate());
const addDays = (date, days) => new Date(date.getTime() + days * 86400000);
const startOfMonth = (date = new Date()) => new Date(date.getFullYear(), date.getMonth(), 1);
const startOfPreviousMonth = (date = new Date()) => new Date(date.getFullYear(), date.getMonth() - 1, 1);
const percentChange = (current, previous) => previous > 0 ? ((current - previous) / previous) * 100 : current > 0 ? 100 : 0;
const moneyExpr = {
  $add: [
    { $cond: [{ $eq: ['$gateIn.payment.status', 'SUBMITTED'] }, { $ifNull: ['$gateIn.payment.amountSubmitted', 0] }, 0] },
    { $cond: [{ $eq: ['$gateOut.payment.status', 'SUBMITTED'] }, { $ifNull: ['$gateOut.payment.amountSubmitted', 0] }, 0] },
  ],
};

function parseRange(query = {}) {
  const now = new Date();
  const from = query.from ? new Date(`${query.from}T00:00:00`) : startOfMonth(now);
  const to = query.to ? new Date(`${query.to}T23:59:59.999`) : now;
  return {
    from: Number.isNaN(from.getTime()) ? startOfMonth(now) : from,
    to: Number.isNaN(to.getTime()) ? now : to,
  };
}

async function revenueBetween(from, to) {
  const rows = await PreAdvice.aggregate([
    { $match: { $or: [
      { 'gateIn.payment.submittedAt': { $gte: from, $lte: to } },
      { 'gateOut.payment.submittedAt': { $gte: from, $lte: to } },
    ] } },
    { $project: {
      value: {
        $add: [
          { $cond: [{ $and: [{ $eq: ['$gateIn.payment.status', 'SUBMITTED'] }, { $gte: ['$gateIn.payment.submittedAt', from] }, { $lte: ['$gateIn.payment.submittedAt', to] }] }, { $ifNull: ['$gateIn.payment.amountSubmitted', 0] }, 0] },
          { $cond: [{ $and: [{ $eq: ['$gateOut.payment.status', 'SUBMITTED'] }, { $gte: ['$gateOut.payment.submittedAt', from] }, { $lte: ['$gateOut.payment.submittedAt', to] }] }, { $ifNull: ['$gateOut.payment.amountSubmitted', 0] }, 0] },
        ],
      },
    } },
    { $group: { _id: null, total: { $sum: '$value' } } },
  ]);
  return rows[0]?.total || 0;
}

async function capacitySummary() {
  const [blocks, current] = await Promise.all([
    StorageBlock.aggregate([{ $match: { status: { $in: ['ACTIVE', 'FULL'] } } }, { $group: { _id: null, capacity: { $sum: '$capacityTeu' } } }]),
    PreAdvice.aggregate([
      { $match: { 'inventory.status': { $in: ['IN_YARD', 'IN_STORAGE', 'RELEASE_PENDING'] } } },
      { $group: {
        _id: null,
        count20: { $sum: { $cond: [{ $eq: ['$containerSize', '20FT'] }, 1, 0] } },
        count40: { $sum: { $cond: [{ $eq: ['$containerSize', '40FT'] }, 1, 0] } },
      } },
    ]),
  ]);
  const count20 = current[0]?.count20 || 0;
  const count40 = current[0]?.count40 || 0;
  const occupiedTeu = count20 + count40 * 2;
  const capacityTeu = blocks[0]?.capacity || 0;
  return {
    count20, count40,
    teu20: count20,
    teu40: count40 * 2,
    occupiedTeu,
    capacityTeu,
    availableTeu: Math.max(0, capacityTeu - occupiedTeu),
    occupancyRate: capacityTeu ? (occupiedTeu / capacityTeu) * 100 : 0,
  };
}

export const dashboard = asyncHandler(async (req, res) => {
  const now = new Date();
  const today = startOfDay(now);
  const tomorrow = addDays(today, 1);
  const yesterday = addDays(today, -1);
  const month = startOfMonth(now);
  const prevMonth = startOfPreviousMonth(now);
  const elapsedPreviousMonthEnd = new Date(prevMonth.getFullYear(), prevMonth.getMonth(), Math.min(now.getDate(), new Date(prevMonth.getFullYear(), prevMonth.getMonth() + 1, 0).getDate()), 23, 59, 59, 999);
  const sevenDaysAgo = addDays(today, -6);
  const thirtyDaysAgo = addDays(today, -29);
  const overstayCutoff = addDays(now, -7);

  const [receivedToday, receivedYesterday, releasedToday, releasedYesterday, inventoryCount, overstaying, capacity, revenueToday, revenueYesterday, revenueMTD, revenuePrevComparable] = await Promise.all([
    PreAdvice.countDocuments({ 'gateIn.actualGateInAt': { $gte: today, $lt: tomorrow } }),
    PreAdvice.countDocuments({ 'gateIn.actualGateInAt': { $gte: yesterday, $lt: today } }),
    PreAdvice.countDocuments({ 'gateOut.releasedAt': { $gte: today, $lt: tomorrow } }),
    PreAdvice.countDocuments({ 'gateOut.releasedAt': { $gte: yesterday, $lt: today } }),
    PreAdvice.countDocuments({ 'inventory.status': { $in: ['IN_YARD', 'IN_STORAGE', 'RELEASE_PENDING'] } }),
    PreAdvice.countDocuments({ 'storage.status': 'STORED', 'storage.storedAt': { $lte: overstayCutoff } }),
    capacitySummary(),
    revenueBetween(today, tomorrow),
    revenueBetween(yesterday, today),
    revenueBetween(month, now),
    revenueBetween(prevMonth, elapsedPreviousMonthEnd),
  ]);

  const [movementRows, topClients, shippingLines, revenueRows] = await Promise.all([
    PreAdvice.aggregate([
      { $match: { $or: [{ 'gateIn.actualGateInAt': { $gte: sevenDaysAgo } }, { 'gateOut.releasedAt': { $gte: sevenDaysAgo } }] } },
      { $project: { events: [
        { date: '$gateIn.actualGateInAt', type: 'received' },
        { date: '$gateOut.releasedAt', type: 'released' },
      ] } },
      { $unwind: '$events' },
      { $match: { 'events.date': { $gte: sevenDaysAgo } } },
      { $group: { _id: { day: { $dateToString: { format: '%Y-%m-%d', date: '$events.date' } }, type: '$events.type' }, count: { $sum: 1 } } },
    ]),
    PreAdvice.aggregate([
      { $match: { $or: [{ 'gateIn.payment.status': 'SUBMITTED' }, { 'gateOut.payment.status': 'SUBMITTED' }] } },
      { $lookup: { from: 'clientcompanies', localField: 'company', foreignField: '_id', as: 'companyDoc' } },
      { $unwind: { path: '$companyDoc', preserveNullAndEmptyArrays: true } },
      { $group: { _id: '$company', name: { $first: '$companyDoc.companyName' }, containers: { $sum: 1 }, revenue: { $sum: moneyExpr } } },
      { $sort: { revenue: -1 } }, { $limit: 5 },
    ]),
    PreAdvice.aggregate([
      { $match: { $or: [{ 'gateIn.actualGateInAt': { $gte: thirtyDaysAgo } }, { 'gateOut.releasedAt': { $gte: thirtyDaysAgo } }] } },
      { $group: {
        _id: '$shippingLine',
        inbound: { $sum: { $cond: [{ $gte: ['$gateIn.actualGateInAt', thirtyDaysAgo] }, 1, 0] } },
        outbound: { $sum: { $cond: [{ $gte: ['$gateOut.releasedAt', thirtyDaysAgo] }, 1, 0] } },
      } },
      { $project: { _id: 0, name: { $ifNull: ['$_id', 'Unknown'] }, inbound: 1, outbound: 1, total: { $add: ['$inbound', '$outbound'] } } },
      { $sort: { total: -1 } }, { $limit: 5 },
    ]),
    PreAdvice.aggregate([
      { $project: { payments: [
        { date: '$gateIn.payment.submittedAt', amount: { $cond: [{ $eq: ['$gateIn.payment.status', 'SUBMITTED'] }, '$gateIn.payment.amountSubmitted', 0] } },
        { date: '$gateOut.payment.submittedAt', amount: { $cond: [{ $eq: ['$gateOut.payment.status', 'SUBMITTED'] }, '$gateOut.payment.amountSubmitted', 0] } },
      ] } },
      { $unwind: '$payments' }, { $match: { 'payments.date': { $gte: sevenDaysAgo }, 'payments.amount': { $gt: 0 } } },
      { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$payments.date' } }, revenue: { $sum: '$payments.amount' } } },
      { $sort: { _id: 1 } },
    ]),
  ]);

  const movementMap = new Map(movementRows.map((row) => [`${row._id.day}:${row._id.type}`, row.count]));
  const revenueMap = new Map(revenueRows.map((row) => [row._id, row.revenue]));
  const containerMovement = [];
  const revenueTrend = [];
  for (let i = 0; i < 7; i += 1) {
    const date = addDays(sevenDaysAgo, i);
    const key = date.toISOString().slice(0, 10);
    const day = date.toLocaleDateString('en-PH', { month: 'short', day: 'numeric' });
    containerMovement.push({ day, received: movementMap.get(`${key}:received`) || 0, released: movementMap.get(`${key}:released`) || 0 });
    revenueTrend.push({ day, revenue: revenueMap.get(key) || 0 });
  }

  res.json({ success: true, data: {
    meta: { dateLabel: now.toLocaleDateString('en-PH', { year: 'numeric', month: 'long', day: 'numeric' }), lastUpdated: now.toISOString() },
    stats: {
      receivedToday, receivedChange: percentChange(receivedToday, receivedYesterday),
      releasedToday, releasedChange: percentChange(releasedToday, releasedYesterday),
      currentInventory: inventoryCount,
      totalCapacity: capacity.capacityTeu, availableCapacity: capacity.availableTeu, occupancyRate: capacity.occupancyRate,
      revenueToday, revenueTodayChange: percentChange(revenueToday, revenueYesterday),
      revenueMonthToDate: revenueMTD, revenueMonthChange: percentChange(revenueMTD, revenuePrevComparable),
      overstayingContainers: overstaying, criticalOverstaying: overstaying,
    },
    revenueTrend,
    containerMovement,
    topCustomers: topClients.map((row) => ({ name: row.name || 'Unknown Client', containers: row.containers, revenue: row.revenue })),
    shippingLineActivity: shippingLines,
  } });
});

export const reports = asyncHandler(async (req, res) => {
  const { from, to } = parseRange(req.query);
  const releasePage = Math.max(1, Number.parseInt(req.query.page || '1', 10));
  const releaseLimit = Math.min(50, Math.max(5, Number.parseInt(req.query.limit || '20', 10)));
  const rangeMatch = { createdAt: { $gte: from, $lte: to }, status: { $ne: 'CANCELLED' } };
  const releaseMatch = { 'gateOut.releasedAt': { $gte: from, $lte: to } };

  const [breakdownRows, revenueClients, releaseRows, releaseTotal, releaseSummaryRows, capacity] = await Promise.all([
    PreAdvice.aggregate([
      { $match: rangeMatch },
      { $group: { _id: null,
        total: { $sum: 1 },
        empty: { $sum: { $cond: [{ $eq: ['$loadStatus', 'EMPTY'] }, 1, 0] } },
        loaded: { $sum: { $cond: [{ $eq: ['$loadStatus', 'LOADED'] }, 1, 0] } },
        local: { $sum: { $cond: [{ $eq: ['$transactionClassification', 'LOCAL'] }, 1, 0] } },
        international: { $sum: { $cond: [{ $eq: ['$transactionClassification', 'INTERNATIONAL'] }, 1, 0] } },
        size20: { $sum: { $cond: [{ $eq: ['$containerSize', '20FT'] }, 1, 0] } },
        size40: { $sum: { $cond: [{ $eq: ['$containerSize', '40FT'] }, 1, 0] } },
      } },
    ]),
    PreAdvice.aggregate([
      { $match: { $or: [
        { 'gateIn.payment.submittedAt': { $gte: from, $lte: to }, 'gateIn.payment.status': 'SUBMITTED' },
        { 'gateOut.payment.submittedAt': { $gte: from, $lte: to }, 'gateOut.payment.status': 'SUBMITTED' },
      ] } },
      { $lookup: { from: 'clientcompanies', localField: 'company', foreignField: '_id', as: 'companyDoc' } },
      { $unwind: { path: '$companyDoc', preserveNullAndEmptyArrays: true } },
      { $project: {
        company: 1, name: '$companyDoc.companyName',
        revenue: { $add: [
          { $cond: [{ $and: [{ $eq: ['$gateIn.payment.status', 'SUBMITTED'] }, { $gte: ['$gateIn.payment.submittedAt', from] }, { $lte: ['$gateIn.payment.submittedAt', to] }] }, { $ifNull: ['$gateIn.payment.amountSubmitted', 0] }, 0] },
          { $cond: [{ $and: [{ $eq: ['$gateOut.payment.status', 'SUBMITTED'] }, { $gte: ['$gateOut.payment.submittedAt', from] }, { $lte: ['$gateOut.payment.submittedAt', to] }] }, { $ifNull: ['$gateOut.payment.amountSubmitted', 0] }, 0] },
        ] },
      } },
      { $group: { _id: '$company', name: { $first: '$name' }, revenue: { $sum: '$revenue' }, transactions: { $sum: { $cond: [{ $gt: ['$revenue', 0] }, 1, 0] } } } },
      { $sort: { revenue: -1 } }, { $limit: 10 },
    ]),
    PreAdvice.find(releaseMatch).select('bookingReference containerNumber containerSize loadStatus transactionClassification shippingLine gateOut.releasedAt gateOut.releasedBy company').populate('company', 'companyName').sort({ 'gateOut.releasedAt': -1 }).skip((releasePage - 1) * releaseLimit).limit(releaseLimit).lean(),
    PreAdvice.countDocuments(releaseMatch),
    PreAdvice.aggregate([{ $match: releaseMatch }, { $group: { _id: null,
      total: { $sum: 1 },
      size20: { $sum: { $cond: [{ $eq: ['$containerSize', '20FT'] }, 1, 0] } },
      size40: { $sum: { $cond: [{ $eq: ['$containerSize', '40FT'] }, 1, 0] } },
      local: { $sum: { $cond: [{ $eq: ['$transactionClassification', 'LOCAL'] }, 1, 0] } },
      international: { $sum: { $cond: [{ $eq: ['$transactionClassification', 'INTERNATIONAL'] }, 1, 0] } },
    } }]),
    capacitySummary(),
  ]);

  res.json({ success: true, data: {
    range: { from: from.toISOString(), to: to.toISOString() },
    containerBreakdown: breakdownRows[0] || { total: 0, empty: 0, loaded: 0, local: 0, international: 0, size20: 0, size40: 0 },
    revenueByClient: revenueClients.map((row) => ({ client: row.name || 'Unknown Client', revenue: row.revenue, transactions: row.transactions })),
    releaseSummary: releaseSummaryRows[0] || { total: 0, size20: 0, size40: 0, local: 0, international: 0 },
    releasePagination: { page: releasePage, limit: releaseLimit, total: releaseTotal, totalPages: Math.max(1, Math.ceil(releaseTotal / releaseLimit)) },
    releases: releaseRows.map((row) => ({
      id: String(row._id), bookingReference: row.bookingReference, containerNumber: row.containerNumber, containerSize: row.containerSize,
      loadStatus: row.loadStatus, classification: row.transactionClassification, shippingLine: row.shippingLine,
      client: row.company?.companyName || 'Unknown Client', releasedAt: row.gateOut?.releasedAt, releasedBy: row.gateOut?.releasedBy || '',
    })),
    capacityEquivalent: capacity,
  } });
});
