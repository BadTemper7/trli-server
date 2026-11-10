import PaymentSubmission from '../models/PaymentSubmission.js';

// Each verified payment is one financial event, including partial payments on
// the same invoice. Grouping by invoice would silently discard later receipts.
// A refunded/reversed payment contributes its original receipt and an offset
// when the reversal falls inside the selected reporting period.
export function revenuePipeline(from, to, extra = [], company = null) {
  return [
    { $match: {
      verifiedAt: { $type: 'date' },
      status: { $in: ['VERIFIED', 'REFUNDED', 'REVERSED', 'VOIDED'] },
      ...(company ? { company } : {}),
    } },
    { $project: { company: 1, invoice: 1, status: 1, method: 1, reference: 1, receiptNumber: 1, events: [
      { when: '$verifiedAt', amount: '$amount' },
      { when: { $ifNull: ['$refundedAt', { $ifNull: ['$reversedAt', '$voidedAt'] }] },
        amount: { $multiply: [-1, { $ifNull: ['$refundedAmount', '$amount'] }] }, refundOnly: true },
    ] } },
    { $unwind: '$events' },
    { $match: { $expr: { $and: [
      { $gte: ['$events.when', from] }, { $lt: ['$events.when', to] },
      { $or: [ { $ne: ['$events.refundOnly', true] },
        { $in: ['$status', ['REFUNDED', 'REVERSED', 'VOIDED']] } ] },
    ] } } },
    ...extra,
  ];
}
export async function revenueSummary(from, to, company = null) {
  const rows = await PaymentSubmission.aggregate(revenuePipeline(from, to, [
    { $group: { _id: null, total: { $sum: '$events.amount' },
      transactions: { $sum: { $cond: [{ $gte: ['$events.amount', 0] }, 1, 0] } } } },
  ], company));
  return { total: Math.round(Number(rows[0]?.total || 0) * 100) / 100,
    transactions: rows[0]?.transactions || 0 };
}
export async function revenueByClient(from, to, limit = 10, company = null) {
  return PaymentSubmission.aggregate(revenuePipeline(from, to, [
    { $group: { _id: '$company', revenue: { $sum: '$events.amount' },
      transactions: { $sum: { $cond: [{ $gte: ['$events.amount', 0] }, 1, 0] } } } },
    { $sort: { revenue: -1 } }, { $limit: limit },
    { $lookup: { from: 'clientcompanies', localField: '_id', foreignField: '_id', as: 'company' } },
    { $project: { client: { $ifNull: [{ $first: '$company.companyName' }, 'Unregistered Client'] },
      revenue: 1, transactions: 1 } },
  ], company));
}
export async function revenueTimeSeries(from, to, groupFormat = '%Y-%m-%d') {
  return PaymentSubmission.aggregate(revenuePipeline(from, to, [
    { $group: { _id: { $dateToString: { format: groupFormat, date: '$events.when', timezone: 'Asia/Manila' } },
      revenue: { $sum: '$events.amount' } } },
    { $sort: { _id: 1 } },
  ]));
}
