// Read-only benchmark: distinguish payload cost, count cost and cached cards.
// These are DB request timings, not an HTTP load test. Run against a safe
// staging dataset with representative volume (ideally 100k+ invoices).
import 'dotenv/config';
import mongoose from 'mongoose';
import Invoice from '../src/models/Invoice.js';
import { buildInvoiceFilter } from '../src/services/tableFilters.js';
import { invoiceSummary } from '../src/services/tableSummaries.js';
import { getCachedSummary, clearSummaryCache } from '../src/utils/summaryCache.js';

const uri = process.env.MONGODB_URI || process.env.MONGO_URI;
if (!uri) throw new Error('Set MONGODB_URI or MONGO_URI before benchmarking');
const company = process.env.BENCH_COMPANY_ID;
if (company && !/^[a-fA-F0-9]{24}$/.test(company)) throw new Error('BENCH_COMPANY_ID must be a valid ObjectId');
const filter = buildInvoiceFilter({}, { company: company ? new mongoose.Types.ObjectId(company) : null });
const SORT = { createdAt: -1, _id: -1 };
const SELECT = 'number booking company type status total paidAmount balance createdAt';
const samples = Number(process.env.BENCH_SAMPLES || 7);
if (!Number.isInteger(samples) || samples < 3 || samples > 100) throw new Error('BENCH_SAMPLES must be between 3 and 100');

const median = sorted => sorted[Math.floor(sorted.length / 2)];
const percentile = (sorted, fraction) => sorted[Math.ceil(sorted.length * fraction) - 1];
const bytes = value => Buffer.byteLength(JSON.stringify(value ?? null));
async function measure(label, fn) {
  await fn(); // warm-up this query shape; initial network handshake excluded
  const timings = [];
  let lastResult;
  for (let i = 0; i < samples; i++) {
    const started = performance.now();
    lastResult = await fn();
    timings.push(Math.round((performance.now() - started) * 100) / 100);
  }
  const sorted = [...timings].sort((a, b) => a - b);
  console.log(JSON.stringify({ label, medianMs: median(sorted), p95Ms: percentile(sorted, 0.95),
    samplesMs: timings, returnedRows: Array.isArray(lastResult) ? lastResult.length : null,
    resultBytes: bytes(lastResult) }));
}

try {
  await mongoose.connect(uri, { autoIndex: false, serverSelectionTimeoutMS: 10_000 });
  const total = await Invoice.countDocuments(filter);
  console.log(JSON.stringify({ filterScope: company ? 'company' : 'all invoices', matchedInvoices: total, samples,
    interpretation: total < 1000 ? 'Small sample: network round trips and count overhead dominate. Do not infer large-table speedups.' :
      'Compare like-for-like queries and p95 on a production-sized staging dataset.' }));
  await measure('database ping (round trip baseline)', () => mongoose.connection.db.command({ ping: 1 }));
  await measure('20 unprojected rows, without count', () => Invoice.find(filter)
    .sort(SORT).limit(20).lean());
  await measure('20 projected rows, without count (like-for-like)', () => Invoice.find(filter)
    .select(SELECT).sort(SORT).limit(20).lean());
  await measure('20 projected rows plus count (offset API)', () => Promise.all([
    Invoice.find(filter).select(SELECT).sort(SORT).limit(20).lean(), Invoice.countDocuments(filter),
  ]));
  await measure('21 projected rows, without count (cursor API)', () => Invoice.find(filter)
    .select(SELECT).sort(SORT).limit(21).lean());
  await measure('countDocuments only (cost of numbered pages)', () => Invoice.countDocuments(filter));
  await measure('300 unprojected rows, without count (legacy payload)', () => Invoice.find(filter)
    .sort(SORT).limit(300).lean());
  await measure('summary aggregation, uncached', () => invoiceSummary(filter));
  clearSummaryCache();
  const cacheKey = `benchmark:invoice:${company || 'all'}`;
  await measure('summary cards, warm 45s cache', () => getCachedSummary(cacheKey, () => invoiceSummary(filter)));
  console.log('[BENCHMARK] Do not compare legacy 300-row latency directly to a 20-row list PLUS count. The operations differ.');
} finally {
  await mongoose.disconnect();
}
