import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = (path) => fs.readFileSync(new URL(path, import.meta.url), 'utf8');

test('table index migration verifies actual MongoDB indexes without dropping indexes or data', () => {
  const source = read('../scripts/setupTableIndexes.js');
  assert.match(source, /model\.createIndexes\(\)/);
  assert.match(source, /model\.collection\.listIndexes\(\)\.toArray\(\)/);
  assert.match(source, /missing\.length/);
  assert.match(source, /NamespaceNotFound/);
  assert.doesNotMatch(source, /\.dropIndex\s*\(|\.syncIndexes\s*\(|\.deleteMany\s*\(/);
});

test('global booking chronology has a matching stable-sort index', () => {
  const source = read('../src/models/PreAdvice.js');
  assert.match(source, /schema\.index\(\{\s*createdAt:\s*-1,\s*_id:\s*-1\s*\},\s*\{name:'idx_booking_created'\}\)/);
  assert.match(source, /idx_booking_company_created/);
});

test('aggregation explain runs through a read-only command and omits writeConcern', () => {
  const source = read('../scripts/explainTableQueries.js');
  assert.match(source, /mongoose\.connection\.db\.command/);
  assert.match(source, /explain:\s*\{\s*aggregate:/);
  assert.match(source, /verbosity:\s*'executionStats'/);
  assert.doesNotMatch(source, /\.aggregate\([^\n]*\.explain\(/);
  assert.doesNotMatch(source, /writeConcern\s*:/);
  assert.match(source, /idx_booking_created/);
});

test('benchmarks explicitly measure equivalent projections and independent count overhead', () => {
  const source = read('../scripts/benchmarkTableQueries.js');
  assert.match(source, /20 unprojected rows, without count/);
  assert.match(source, /20 projected rows, without count/);
  assert.match(source, /countDocuments only/);
  assert.match(source, /summary cards, warm 45s cache/);
  assert.match(source, /matchedInvoices/);
  assert.match(source, /p95Ms/);
  assert.doesNotMatch(source, /insertMany\s*\(|deleteMany\s*\(/);
});
