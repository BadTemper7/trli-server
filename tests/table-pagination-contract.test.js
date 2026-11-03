import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { pageOptions, dateRange, prefixSearch, enumParam, cursorCondition, nextCursor,
  listDocuments } from '../src/utils/tableQuery.js';
import { buildBookingFilter, buildOperationFilter, buildInvoiceFilter, buildContainerFilters } from '../src/services/tableFilters.js';

const read = path => fs.readFileSync(new URL(path, import.meta.url), 'utf8');
const client = '690000000000000000000001';
const other = '690000000000000000000002';
const id = '690000000000000000000003';
test('bounded pagination defaults, clamping, deterministic tie breaker', () => {
  assert.deepEqual(pageOptions({}).sortSpec, { createdAt:-1, _id:-1 });
  assert.equal(pageOptions({page:'-50',limit:'1000'}).page,1);
  assert.equal(pageOptions({page:'-50',limit:'1000'}).limit,100);
  assert.deepEqual(pageOptions({sort:'status',order:'asc'},{sorts:['status','createdAt']}).sortSpec,{status:1,_id:1});
  for(const q of [{page:'abc'},{page:'2.2'},{limit:'0'},{limit:'twenty'},{sort:'__proto__'},{order:'sideways'},{pagination:'unsupported'}]) {
    assert.throws(()=>pageOptions(q),e=>e.status===400);
  }
});
test('search is escaped, prefix anchored, and safely bounded', () => {
  assert.deepEqual(prefixSearch({search:'A.*+('}),{$regex:'^A\\.\\*\\+\\(',$options:'i'});
  assert.throws(()=>prefixSearch({search:'x'.repeat(65)}),e=>e.status===400);
  assert.throws(()=>prefixSearch({search:['x','y']}),e=>e.status===400);
  assert.throws(()=>enumParam({status:'bad'},'status',['PAID','UNPAID']),e=>e.status===400);
});
test('date range respects inclusive Manila calendar day and validates values', () => {
  const r=dateRange({from:'2026-11-01',to:'2026-11-02'});
  assert.equal(r.$gte.toISOString(),'2026-10-31T16:00:00.000Z');
  assert.equal(r.$lt.toISOString(),'2026-11-02T16:00:00.000Z');
  assert.throws(()=>dateRange({from:'2026-02-30'}),e=>e.status===400);
  assert.throws(()=>dateRange({from:'2026-11-03',to:'2026-11-01'}),e=>e.status===400);
});
test('booking summary/list builder always owns the company and uses same filtered fields', async () => {
  const f=await buildBookingFilter({status:'SUBMITTED',search:'AB.1',category:'ALL'},client);
  assert.equal(f.company,client);
  assert.equal(f.status,'SUBMITTED');
  assert.equal(f.$or[0].bookingReference.$regex,'^AB\\.1');
  const global=await buildBookingFilter({status:'REJECTED',search:'xyz'},client,{global:true});
  assert.deepEqual(global,{company:client});
});
test('operation queues use one consistent filter function including approval restrictions',()=>{
  const pending=buildOperationFilter({approval:'PENDING',search:'TRM'},'pre-advice');
  assert.equal(pending.$and.length,3);
  assert.equal(pending.$and[2].status,'SUBMITTED');
  assert.equal(buildOperationFilter({},'release').workflowStage.$in[0],'READY_FOR_RELEASE');
  assert.throws(()=>buildOperationFilter({approval:'MAYBE'},'pre-advice'),e=>e.status===400);
});
test('Gate-in payment queues are server-side and reject unsupported queue names',()=>{
  const ready=buildOperationFilter({queue:'READY',search:'TRM'},'gate-in');
  assert.equal(ready['gateIn.payment.status'],'VERIFIED');
  assert.ok(ready.$or?.length);
  const pending=buildOperationFilter({queue:'PAYMENT'},'gate-in');
  assert.deepEqual(pending['gateIn.payment.status'],{$ne:'VERIFIED'});
  assert.equal(buildOperationFilter({queue:'REJECTED'},'gate-in')['gateIn.inspection.status'],'REJECTED');
  assert.throws(()=>buildOperationFilter({queue:'HIDDEN'},'gate-in'),error=>error.status===400);
});
test('operation summaries aggregate page-independent Gate-in and inventory counts',()=>{
  const source=read('../src/services/tableSummaries.js');
  assert.match(source,/waitingStorage:\s*countIf/);
  assert.match(source,/payment:\s*countIf/);
  assert.match(source,/ready:\s*countIf/);
  assert.match(source,/PreAdvice\.aggregate\(\[\{ \$match: filter \}, \{ \$group: group \}\]\)/);
});
test('invoice & container company scope cannot be widened by query',()=>{
  const bill=buildInvoiceFilter({company:other,status:'PAID'}, {company:client});
  assert.equal(bill.company,client);
  assert.equal(bill.status,'PAID');
  const {live,historical}=buildContainerFilters({company:other,includeDeleted:'true'}, {company:client,isAdmin:false});
  assert.equal(live.company,client);
  assert.equal(historical.company,client);
  assert.equal(live.deletedAt,null);
  assert.deepEqual(buildContainerFilters({includeDeleted:'true'},{isAdmin:true}).live,{});
});
test('stored tracking excludes released and approved containers from filtered cards and rows',()=>{
  const {live,historical}=buildContainerFilters({status:'STORED'},{company:client});
  assert.equal(live['storage.status'],'STORED');
  assert.equal(live['gateOut.approvedAt'],null);
  assert.equal(live['gateOut.releasedAt'],null);
  assert.equal(historical.status,'STORED');
  const text=read('../src/services/tableSummaries.js');
  assert.ok(text.includes("$ifNull: ['$gateOut.releasedAt', null]"));
});
test('cursor is scoped to its filters and immutable sort tuple',()=>{
  const filter={company:client,status:'SUBMITTED'};
  const paging=pageOptions({pagination:'cursor'});
  const token=nextCursor([{_id:id,createdAt:new Date('2026-11-02T00:00:00Z')}],filter,paging);
  const condition=cursorCondition({cursor:token},filter,paging);
  assert.equal(condition.$and[0],filter);
  assert.equal(condition.$and[1].$or[1]._id.$lt,id);
  assert.throws(()=>cursorCondition({cursor:token},{company:other},paging),e=>e.status===400);
  assert.throws(()=>cursorCondition({cursor:'BAD'},filter,paging),e=>e.status===400);
});
test('list helper projects lean rows, fetches offset rows/count concurrently, cursor skips count',async()=>{
  const calls=[];
  const rows=[{_id:id,createdAt:new Date('2026-11-02T00:00:00Z')}];
  const fake={
    find:filter=>{calls.push(['find',filter]);return{
      select:v=>{calls.push(['select',v]);return{
        sort:v=>{calls.push(['sort',v]);return{
          lean:()=>({
            skip:n=>({limit:async n2=>{calls.push(['skip/limit',n,n2]);return rows}}),
            limit:async n2=>{calls.push(['cursor-limit',n2]);return rows},
          }),
        }},
      }},
    }},
    countDocuments:async filter=>{calls.push(['count',filter]);return 123},
  };
  const offset=await listDocuments(fake,{company:client},{page:'2',limit:'5'},{select:'name createdAt'});
  assert.equal(offset.pagination.total,123);
  assert.equal(offset.pagination.page,2);
  assert.ok(calls.some(x=>x[0]==='select'&&x[1]==='name createdAt'));
  assert.ok(calls.some(x=>x[0]==='skip/limit'&&x[1]===5));
  calls.length=0;
  const cursor=await listDocuments(fake,{company:client},{pagination:'cursor',limit:'5'},{select:'name createdAt'});
  assert.equal(cursor.pagination.hasMore,false);
  assert.equal(cursor.pagination.nextCursor,null);
  assert.equal(calls.some(x=>x[0]==='count'),false);
});
test('numeric invoice cursor sorts by amount and rejects mixed pagination modes',()=>{
  const filter={company:client};
  const paging=pageOptions({pagination:'cursor',sort:'total',order:'asc'}, {sorts:['createdAt','total']});
  const cursor=nextCursor([{_id:id,total:1120}],filter,paging);
  const where=cursorCondition({cursor},filter,paging);
  assert.equal(where.$and[1].$or[0].total.$gt,1120);
  assert.throws(()=>pageOptions({pagination:'offset',cursor}),e=>e.status===400);
});
test('query validation errors return 400 and a safe public message',async()=>{
  const {errorHandler}=await import('../src/middleware/error.js');
  let status,response;
  const res={status(code){status=code;return this},json(value){response=value;return this}};
  errorHandler(Object.assign(new Error('Mongo collection internal details'),{name:'CastError'}),{originalUrl:'/api/invoices'},res,()=>{});
  assert.equal(status,400);
  assert.equal(response.message,'Invalid request parameters or data.');
  assert.equal(response.errorId,undefined);
});
test('summary routes use indexed $match before $group, not rows.length',()=>{
  const summaries=read('../src/services/tableSummaries.js');
  assert.match(summaries,/\{ \$match: filter \}, \{ \$group:/);
  assert.match(summaries,/getCachedSummary/);
  assert.doesNotMatch(summaries,/items\.length/);
  const booking=read('../src/controllers/preAdviceController.js');
  assert.match(booking,/buildBookingFilter\(req\.query/);
  assert.match(booking,/getBookingSummary\(req\.query/);
});
test('additive indexes and source routes have summary before document routes',()=>{
  const migration=read('../scripts/setupTableIndexes.js');
  assert.match(migration,/createIndexes\(\)/);
  assert.doesNotMatch(migration,/dropIndex|syncIndexes/);
  const routes=read('../src/routes/invoiceRoutes.js');
  assert.ok(routes.indexOf("clientInvoices.get('/summary'") < routes.indexOf("clientInvoices.get('/:id'"));
});
