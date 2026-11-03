// Read-only query planner diagnostics. Set BENCH_COMPANY_ID for realistic
// company-scoped queries. Aggregate explains use the MongoDB `explain` command
// because aggregate.explain() can inherit a writeConcern and fail on Node 24.
import 'dotenv/config';
import mongoose from 'mongoose';
import PreAdvice from '../src/models/PreAdvice.js';
import Invoice from '../src/models/Invoice.js';
import HistoricalContainer from '../src/models/HistoricalContainer.js';
import AdminAuditLog from '../src/models/AdminAuditLog.js';

const uri = process.env.MONGODB_URI || process.env.MONGO_URI;
if (!uri) throw new Error('MONGODB_URI or MONGO_URI must be set');
const company = process.env.BENCH_COMPANY_ID;
if (company && !/^[a-fA-F0-9]{24}$/.test(company)) throw new Error('BENCH_COMPANY_ID must be a 24-character ObjectId');
const scope = company ? { company: new mongoose.Types.ObjectId(company) } : {};

const findExplain = (query) => query.explain('executionStats');
// IMPORTANT: Do not pass writeConcern in either command level. This command
// reads the query plan and does not run a write operation.
const aggregateExplain = (model, pipeline) => mongoose.connection.db.command({
  explain: { aggregate: model.collection.collectionName, pipeline, cursor: {} },
  verbosity: 'executionStats',
});

function unpackExplain(explain) {
  const cursor = explain.stages?.find(stage => stage.$cursor)?.$cursor;
  const stats = explain.executionStats || cursor?.executionStats || {};
  const planner = explain.queryPlanner || cursor?.queryPlanner || {};
  const plan = planner.winningPlan || {};
  const stages = new Set();
  const indexNames = new Set();
  const walk = (value) => {
    if (!value || typeof value !== 'object') return;
    if (typeof value.stage === 'string') stages.add(value.stage);
    if (typeof value.indexName === 'string') indexNames.add(value.indexName);
    for (const child of Object.values(value)) if (child && typeof child === 'object') {
      if (Array.isArray(child)) child.forEach(walk);
      else walk(child);
    }
  };
  walk(plan);
  // Modern MongoDB may put SBE query details in executionStats rather than
  // the classic winning plan. Preserve both shapes in the result.
  if (stages.size === 0) walk(stats.executionStages);
  return {
    nReturned: stats.nReturned ?? null,
    executionTimeMillis: stats.executionTimeMillis ?? null,
    totalDocsExamined: stats.totalDocsExamined ?? null,
    totalKeysExamined: stats.totalKeysExamined ?? null,
    planStages: [...stages],
    indexNames: [...indexNames],
    winningPlan: plan,
  };
}

try {
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 10_000, autoIndex: false });
  const tests = [
    {
      label: company ? 'bookings by company + creation' : 'all bookings + creation (global scope)',
      run: () => findExplain(PreAdvice.find(scope)
        .select('bookingReference containerNumber status createdAt')
        .sort({ createdAt: -1, _id: -1 }).limit(20)),
    },
    {
      label: company ? 'bookings by company + creation (forced index diagnostic)' : 'all bookings + creation (forced index diagnostic)',
      run: () => findExplain(PreAdvice.find(scope)
        .select('bookingReference containerNumber status createdAt')
        .sort({ createdAt: -1, _id: -1 }).limit(20)
        .hint(company ? 'idx_booking_company_created' : 'idx_booking_created')),
    },
    { label: 'pending admin gate-in', run: () => findExplain(PreAdvice.find({ workflowStage: 'READY_FOR_GATE_IN' })
      .select('bookingReference workflowStage updatedAt').sort({ updatedAt: -1, _id: -1 }).limit(20)) },
    { label: 'invoice status + creation', run: () => findExplain(Invoice.find({ ...scope, status: 'UNPAID' })
      .select('number total status createdAt').sort({ createdAt: -1, _id: -1 }).limit(20)) },
    { label: 'historical containers', run: () => findExplain(HistoricalContainer.find({ ...scope, deletedAt: null })
      .select('containerNumber status createdAt').sort({ createdAt: -1, _id: -1 }).limit(20)) },
    { label: 'audit log cursor', run: () => findExplain(AdminAuditLog.find({ action: 'RECORD_DELETED' })
      .sort({ createdAt: -1, _id: -1 }).limit(25)) },
    { label: 'booking status summary', run: () => aggregateExplain(PreAdvice, [
      { $match: { ...scope, status: 'SUBMITTED' } }, { $group: { _id: null, total: { $sum: 1 } } },
    ]) },
    { label: 'invoice status summary', run: () => aggregateExplain(Invoice, [
      { $match: { ...scope, status: 'UNPAID' } },
      { $group: { _id: null, total: { $sum: 1 }, amount: { $sum: '$total' } } },
    ]) },
  ];
  if (!company) console.warn('[EXPLAIN] BENCH_COMPANY_ID not set. Global bookings and invoices are tested; company-specific indexes require a company ID.');
  for (const { label, run } of tests) {
    const report = unpackExplain(await run());
    if (report.nReturned === 0 && report.totalDocsExamined === 0) {
      report.note = 'No matching records. Index selection can be checked, but latency conclusions are inconclusive.';
    } else if (report.planStages.includes('COLLSCAN')) {
      report.note = 'Natural planner chose a collection scan. On a very small collection this may be cheaper than an index; compare the forced-index diagnostic and larger staging data.';
    }
    console.log(JSON.stringify({ label, ...report }, null, 2));
  }
} finally {
  await mongoose.disconnect();
}
