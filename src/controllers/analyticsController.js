import mongoose from 'mongoose';
import { once } from 'node:events';
import PreAdvice from '../models/PreAdvice.js';
import ClientCompany from '../models/ClientCompany.js';
import Invoice from '../models/Invoice.js';
import PaymentSubmission from '../models/PaymentSubmission.js';
import HistoricalContainer from '../models/HistoricalContainer.js';
import StorageBlock from '../models/StorageBlock.js';
import {AppError,asyncHandler} from '../utils/http.js';
import {reportRange,plusDays} from '../utils/businessRange.js';
import {revenueSummary,revenueByClient,revenueTimeSeries,revenuePipeline} from '../services/revenueService.js';

async function capacitySummary(company = null){
 const [blocks,live,legacy]=await Promise.all([
  StorageBlock.aggregate([{$match:{status:{$in:['ACTIVE','FULL']}}},{$group:{_id:null,capacity:{$sum:'$capacityTeu'}}}]),
  PreAdvice.aggregate([{$match:{'inventory.status':{$in:['IN_YARD','IN_STORAGE','RELEASE_PENDING']},'gateOut.releasedAt':null,deletedAt:null,...(company?{company}:{})}},{$group:{_id:null,count20:{$sum:{$cond:[{$eq:['$containerSize','20FT']},1,0]}},count40:{$sum:{$cond:[{$eq:['$containerSize','40FT']},1,0]}}}}]),
  HistoricalContainer.aggregate([{$match:{deletedAt:null,status:{$in:['GATED_IN','STORED','GATE_OUT_APPROVED']},'gateOut.releasedAt':null,...(company?{company}:{})}},{$group:{_id:null,count20:{$sum:{$cond:[{$eq:['$containerSize','20FT']},1,0]}},count40:{$sum:{$cond:[{$eq:['$containerSize','40FT']},1,0]}}}}]),
 ]);
 const count20=(live[0]?.count20||0)+(legacy[0]?.count20||0),count40=(live[0]?.count40||0)+(legacy[0]?.count40||0);
 const occupiedTeu=count20+count40*2,capacityTeu=blocks[0]?.capacity||0;
 return {count20,count40,teu20:count20,teu40:count40*2,occupiedTeu,capacityTeu,availableTeu:Math.max(0,capacityTeu-occupiedTeu),occupancyRate:capacityTeu?100*occupiedTeu/capacityTeu:0};
}
const dateFilter=(field,from,to)=>({[field]:{$gte:from,$lt:to}});
const round=n=>Math.round(Number(n||0)*100)/100;
function chartFormat(range){return range.mode==='daily'?'%H':range.mode==='yearly'||(range.to-range.from>36*86400000)?'%Y-%m':'%Y-%m-%d';}
async function movementSeries(from,to,format){
 return PreAdvice.aggregate([
  {$project:{events:[{when:'$gateIn.actualGateInAt',type:'received'},{when:'$gateOut.releasedAt',type:'released'}]}},
  {$unwind:'$events'},{$match:{'events.when':{$gte:from,$lt:to}}},
  {$group:{_id:{label:{$dateToString:{format,date:'$events.when',timezone:'Asia/Manila'}},type:'$events.type'},count:{$sum:1}}},
 ]);
}
export const dashboard=asyncHandler(async(req,res)=>{
 const range=reportRange(req.query);
 const {from,to}=range,span=to-from;
 const previousFrom=new Date(from.getTime()-span);
 const format=chartFormat(range);
 const [received,released,prevReceived,prevReleased,currentLive,currentLegacy,pending,overstaying,capacity,revenue,revenuePrevious,trendRows,movementRows,topClients,shippingLines,totalLive,totalHistory]=await Promise.all([
  PreAdvice.countDocuments(dateFilter('gateIn.actualGateInAt',from,to)),
  PreAdvice.countDocuments(dateFilter('gateOut.releasedAt',from,to)),
  PreAdvice.countDocuments(dateFilter('gateIn.actualGateInAt',previousFrom,from)),
  PreAdvice.countDocuments(dateFilter('gateOut.releasedAt',previousFrom,from)),
  PreAdvice.countDocuments({'inventory.status':{$in:['IN_YARD','IN_STORAGE','RELEASE_PENDING']}}),
  HistoricalContainer.countDocuments({deletedAt:null,status:{$in:['GATED_IN','STORED','GATE_OUT_APPROVED']}}),
  PreAdvice.countDocuments({...dateFilter('createdAt',from,to),'preAdviceReview.decision':'PENDING'}),
  PreAdvice.countDocuments({'storage.status':'STORED','storage.storedAt':{$lt:new Date(Date.now()-7*86400000)}}),
  capacitySummary(),revenueSummary(from,to),revenueSummary(previousFrom,from),
  revenueTimeSeries(from,to,format),movementSeries(from,to,format),revenueByClient(from,to,5),
  PreAdvice.aggregate([{$match:{$or:[dateFilter('gateIn.actualGateInAt',from,to),dateFilter('gateOut.releasedAt',from,to)]}},{$group:{_id:'$shippingLine',total:{$sum:1}}},{$sort:{total:-1}},{$limit:5}]),
  PreAdvice.countDocuments(dateFilter('createdAt',from,to)),
  HistoricalContainer.countDocuments({deletedAt:null,$or:[dateFilter('originTransactionDate',from,to),dateFilter('createdAt',from,to)]}),
 ]);
 const movementMap=new Map(movementRows.map(x=>[`${x._id.label}:${x._id.type}`,x.count]));
 const revenueMap=new Map(trendRows.map(x=>[x._id,round(x.revenue)]));
 const labels=[...new Set([...trendRows.map(x=>x._id),...movementRows.map(x=>x._id.label)])].sort();
 const containerMovement=labels.map(day=>({day,received:movementMap.get(`${day}:received`)||0,released:movementMap.get(`${day}:released`)||0}));
 const revenueTrend=labels.map(day=>({day,revenue:revenueMap.get(day)||0}));
 const percent=(v,prev)=>prev?100*(v-prev)/prev:0;
 res.json({success:true,data:{
  meta:{dateLabel:range.label,lastUpdated:new Date().toISOString(),range:{period:range.mode,from:range.fromDay,to:range.toDay},timezone:'Asia/Manila'},
  stats:{receivedToday:received,receivedChange:percent(received,prevReceived),releasedToday:released,releasedChange:percent(released,prevReleased),
   currentInventory:currentLive+currentLegacy,totalContainers:totalLive+totalHistory,pendingApprovals:pending,overstayingContainers:overstaying,criticalOverstaying:overstaying,
   ...capacity,revenueToday:revenue.total,totalRevenue:revenue.total,verifiedPayments:revenue.transactions,revenueTodayChange:percent(revenue.total,revenuePrevious.total),revenueMonthToDate:revenue.total,revenueMonthChange:percent(revenue.total,revenuePrevious.total)},
  revenueTrend,containerMovement,topCustomers:topClients.map(x=>({name:x.client,containers:x.transactions,revenue:x.revenue})),
  shippingLineActivity:shippingLines.map(x=>({name:x._id||'Unknown',total:x.total,inbound:x.total,outbound:0})),
 }});
});

// Reports use the same typed company selector in counts, lists, and export.
// Never pass raw HTTP query values to MongoDB match expressions.
export function reportScope(query = {}) {
  const value = query.client ?? '';
  if (typeof value !== 'string' || (value && !/^[a-f\d]{24}$/i.test(value))) {
    throw new AppError('Select a valid registered client.', 400);
  }
  const pageValue = query.page ?? '1', limitValue = query.limit ?? '20';
  if (!/^\d+$/.test(String(pageValue)) || !/^\d+$/.test(String(limitValue))) throw new AppError('Invalid report page or limit.', 400);
  const order=query.order??'desc';
  if(!['desc','asc'].includes(order))throw new AppError('Report order must be asc or desc.',400);
  const pageNumber=Number(pageValue), limitNumber=Number(limitValue);
  if(!Number.isSafeInteger(pageNumber)||!Number.isSafeInteger(limitNumber)||pageNumber>100000||limitNumber>1000){
    throw new AppError('Report page or limit is out of range.',400);
  }
  return { company: value ? new mongoose.Types.ObjectId(value) : null, order,
    page: Math.max(1,pageNumber), limit: Math.min(50,Math.max(5,limitNumber)) };
}
const scopeMatch = (base, company) => ({ ...base, ...(company ? { company } : {}) });
const activeLive = company => scopeMatch({deletedAt:null,'gateIn.actualGateInAt':{$ne:null},'gateOut.releasedAt':null},company);
const activeHistorical = company => scopeMatch({deletedAt:null,status:{$in:['GATED_IN','STORED','GATE_OUT_APPROVED']},'gateIn.actualGateInAt':{$ne:null},'gateOut.releasedAt':null},company);
const historicRange = (from,to,company) => scopeMatch({deletedAt:null,$or:[dateFilter('originTransactionDate',from,to),dateFilter('createdAt',from,to)]},company);
const invoiceRange = (from,to,company) => scopeMatch({status:{$nin:['CANCELLED','VOID']},...dateFilter('createdAt',from,to)},company);
const verifiedPaymentRange = (from,to,company) => scopeMatch({status:{$in:['VERIFIED','REFUNDED','REVERSED','VOIDED']},...dateFilter('verifiedAt',from,to)},company);
const emptyBreakdown = () => ({total:0,empty:0,loaded:0,local:0,international:0,size20:0,size40:0});
const emptyRelease = () => ({total:0,size20:0,size40:0,local:0,international:0});
const safeInt = n => Number.isFinite(n) ? n : 0;
const releaseCountExpr = { _id:null,total:{$sum:1},size20:{$sum:{$cond:[{$eq:['$containerSize','20FT']},1,0]}},size40:{$sum:{$cond:[{$eq:['$containerSize','40FT']},1,0]}},local:{$sum:{$cond:[{$eq:['$transactionClassification','LOCAL']},1,0]}},international:{$sum:{$cond:[{$eq:['$transactionClassification','INTERNATIONAL']},1,0]}} };
const releaseView = (row,source) => ({
  id:String(row._id),source,bookingReference:row.bookingReference||'—',containerNumber:row.containerNumber,
  containerSize:row.containerSize,containerType:row.containerType,loadStatus:row.loadStatus,
  classification:row.transactionClassification,shippingLine:row.shippingLine||'',
  client:row.company?.companyName||'Unregistered Client',releasedAt:row.gateOut?.releasedAt,
  releasedBy:row.gateOut?.releasedBy||'',
});
const reportContainerFields='company bookingReference containerNumber containerSize containerType loadStatus transactionClassification shippingLine gateIn storage gateOut status createdAt';
export const reportClients = asyncHandler(async(req,res) => {
  const search=req.query.search??'';
  if(typeof search!=='string' || search.length>80)throw new AppError('Client search must be at most 80 characters.',400);
  const limit=req.query.limit==null?30:Number(req.query.limit);
  if(!Number.isInteger(limit)||limit<1||limit>100)throw new AppError('Client search limit must be between 1 and 100.',400);
  const name=search.trim().replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
  const items=await ClientCompany.find(name?{companyName:{$regex:`^${name}`,$options:'i'}}:{})
    .select('_id companyName verificationStatus').sort({companyName:1,_id:1}).limit(limit).lean();
  res.json({success:true,data:{items}});
});
async function resolveReportScope(query){
  const options=reportScope(query);
  const range=reportRange(query,'monthly');
  let client=null;
  if(options.company){
    client=await ClientCompany.findById(options.company).select('companyName verificationStatus').lean();
    if(!client)throw new AppError('Selected client was not found.',404);
  }
  return {...options,range,client};
}
async function loadReportData({company,range,page,limit,client,order='desc'}){
  const {from,to}=range;
  const created=scopeMatch({deletedAt:null,...dateFilter('createdAt',from,to)},company);
  const released=scopeMatch({deletedAt:null,...dateFilter('gateOut.releasedAt',from,to)},company);
  const historicReleased=scopeMatch({deletedAt:null,...dateFilter('gateOut.releasedAt',from,to)},company);
  const gateIns=scopeMatch({deletedAt:null,...dateFilter('gateIn.actualGateInAt',from,to)},company);
  const historicalGateIns=scopeMatch({deletedAt:null,...dateFilter('gateIn.actualGateInAt',from,to)},company);
  const cap=page*limit;
  const direction=order==='asc'?1:-1;
  const [breakdownRows,clients,releaseLive,releaseHistoric,releaseLiveTotal,releaseHistoricTotal,
    releaseLiveSummary,releaseHistoricSummary,capacity,revenue,historyTotal,
    activeLiveTotal,activeHistoricTotal,storedLiveTotal,storedHistoricTotal,
    gateInLiveTotal,gateInHistoricTotal,billingRows,billingRecent,paymentRecent,gateInRecent,inventoryRecent,gateInHistoricalRecent,inventoryHistoricalRecent,facilityCapacity] = await Promise.all([
    PreAdvice.aggregate([{$match:created},{$group:{_id:null,total:{$sum:1},empty:{$sum:{$cond:[{$eq:['$loadStatus','EMPTY']},1,0]}},loaded:{$sum:{$cond:[{$eq:['$loadStatus','LOADED']},1,0]}},local:{$sum:{$cond:[{$eq:['$transactionClassification','LOCAL']},1,0]}},international:{$sum:{$cond:[{$eq:['$transactionClassification','INTERNATIONAL']},1,0]}},size20:{$sum:{$cond:[{$eq:['$containerSize','20FT']},1,0]}},size40:{$sum:{$cond:[{$eq:['$containerSize','40FT']},1,0]}}}}]),
    revenueByClient(from,to,10,company),
    PreAdvice.find(released).select(reportContainerFields).populate('company','companyName').sort({'gateOut.releasedAt':direction,_id:direction}).limit(cap).lean(),
    HistoricalContainer.find(historicReleased).select(reportContainerFields).populate('company','companyName').sort({'gateOut.releasedAt':direction,_id:direction}).limit(cap).lean(),
    PreAdvice.countDocuments(released),HistoricalContainer.countDocuments(historicReleased),
    PreAdvice.aggregate([{$match:released},{$group:releaseCountExpr}]),
    HistoricalContainer.aggregate([{$match:historicReleased},{$group:releaseCountExpr}]),
    capacitySummary(company),revenueSummary(from,to,company),HistoricalContainer.countDocuments(historicRange(from,to,company)),
    PreAdvice.countDocuments(activeLive(company)),HistoricalContainer.countDocuments(activeHistorical(company)),
    PreAdvice.countDocuments(scopeMatch({...activeLive(null),'storage.status':'STORED'},company)),
    HistoricalContainer.countDocuments(scopeMatch({...activeHistorical(null),'storage.block':{$ne:null}},company)),
    PreAdvice.countDocuments(gateIns),HistoricalContainer.countDocuments(historicalGateIns),
    Invoice.aggregate([{$match:invoiceRange(from,to,company)},{$group:{_id:null,count:{$sum:1},subtotal:{$sum:'$subtotal'},vat:{$sum:'$vat'},total:{$sum:'$total'},paidAmount:{$sum:'$paidAmount'},balance:{$sum:'$balance'}}}]),
    Invoice.find(invoiceRange(from,to,company)).select('number company booking type status subtotal vat total paidAmount balance createdAt').populate('company','companyName').sort({createdAt:-1,_id:-1}).limit(20).lean(),
    PaymentSubmission.aggregate(revenuePipeline(from,to,[
      {$sort:{'events.when':-1,_id:-1}},{$limit:20},
      {$lookup:{from:'clientcompanies',localField:'company',foreignField:'_id',as:'clientInfo'}},
      {$project:{_id:1,clientName:{$ifNull:[{$first:'$clientInfo.companyName'},'Unregistered Client']},
        method:1,status:1,receiptNumber:1,invoice:1,amount:'$events.amount',verifiedAt:'$events.when',
        eventType:{$cond:[{$eq:['$events.refundOnly',true]},'REVERSAL','RECEIPT']}}},
    ],company)),
    PreAdvice.find(gateIns).select(reportContainerFields).populate('company','companyName').sort({'gateIn.actualGateInAt':-1,_id:-1}).limit(20).lean(),
    PreAdvice.find(activeLive(company)).select(reportContainerFields).populate('company','companyName').populate('storage.block','name').sort({'gateIn.actualGateInAt':-1,_id:-1}).limit(20).lean(),
    HistoricalContainer.find(historicalGateIns).select(reportContainerFields).populate('company','companyName').sort({'gateIn.actualGateInAt':-1,_id:-1}).limit(20).lean(),
    HistoricalContainer.find(activeHistorical(company)).select(reportContainerFields).populate('company','companyName').populate('storage.block','name').sort({'gateIn.actualGateInAt':-1,_id:-1}).limit(20).lean(),
    company?capacitySummary():Promise.resolve(null),
  ]);
  const summaryKeys=['total','size20','size40','local','international'];
  const releaseSummary={...emptyRelease()};
  for(const key of summaryKeys)releaseSummary[key]=(releaseLiveSummary[0]?.[key]||0)+(releaseHistoricSummary[0]?.[key]||0);
  const total=releaseLiveTotal+releaseHistoricTotal;
  const releases=[...releaseLive.map(row=>releaseView(row,'LIVE')),...releaseHistoric.map(row=>releaseView(row,'HISTORICAL'))]
    .sort((a,b)=>direction*(new Date(a.releasedAt)-new Date(b.releasedAt)||a.id.localeCompare(b.id))).slice((page-1)*limit,page*limit);
  const bills=billingRows[0]||{count:0,subtotal:0,vat:0,total:0,paidAmount:0,balance:0};
  const currentInventory=activeLiveTotal+activeHistoricTotal;
  return {range:{from:range.fromDay,to:range.toDay,period:range.mode,label:range.label,timezone:'Asia/Manila'},releaseSort:order,
    selectedClient:client?{id:String(client._id),name:client.companyName}:null,
    totalRevenue:revenue.total,revenueTransactions:revenue.transactions,historicalContainerCount:historyTotal,
    containerBreakdown:breakdownRows[0]||emptyBreakdown(),revenueByClient:clients,
    releaseSummary,releasePagination:{page,limit,total,totalPages:Math.max(1,Math.ceil(total/limit))},releases,
    capacityEquivalent:{...capacity,availableTeu:facilityCapacity?.availableTeu??capacity.availableTeu,scope:company?'CLIENT_FOOTPRINT':'FACILITY'},
    reportOverview:{totalContainers:(breakdownRows[0]?.total||0)+historyTotal,activeContainers:currentInventory,
      releasedContainers:releaseSummary.total,gateIns:gateInLiveTotal+gateInHistoricTotal,
      storedContainers:storedLiveTotal+storedHistoricTotal,
      totalBilling:round(bills.total),subtotal:round(bills.subtotal),vat:round(bills.vat),
      totalPayments:round(revenue.total),paidAgainstBilledInvoices:round(bills.paidAmount),
      outstandingBalance:round(bills.balance),invoiceCount:bills.count||0},
    // Records are intentionally bounded; complete filtered CSV export is streamed by the server.
    gateInRecords:[...gateInRecent.map(row=>({...releaseView(row,'LIVE'),gateInAt:row.gateIn?.actualGateInAt})),
      ...gateInHistoricalRecent.map(row=>({...releaseView(row,'HISTORICAL'),gateInAt:row.gateIn?.actualGateInAt}))]
      .sort((a,b)=>new Date(b.gateInAt)-new Date(a.gateInAt)).slice(0,20),
    inventoryRecords:[...inventoryRecent.map(row=>({...releaseView(row,'LIVE'),gateInAt:row.gateIn?.actualGateInAt,
      block:row.storage?.block?.name||'',slot:row.storage?.bay?`${row.storage.bay}-${row.storage.row}-${row.storage.tier}`:''})),
      ...inventoryHistoricalRecent.map(row=>({...releaseView(row,'HISTORICAL'),gateInAt:row.gateIn?.actualGateInAt,
        block:row.storage?.block?.name||'',slot:row.storage?.bay?`${row.storage.bay}-${row.storage.row}-${row.storage.tier}`:''}))]
      .sort((a,b)=>new Date(b.gateInAt)-new Date(a.gateInAt)).slice(0,20),
    invoiceRecords:billingRecent.map(row=>({id:String(row._id),number:row.number,client:row.company?.companyName||'Unregistered Client',type:row.type,
      status:row.status,subtotal:row.subtotal,vat:row.vat,total:row.total,paidAmount:row.paidAmount,balance:row.balance,createdAt:row.createdAt})),
    paymentRecords:paymentRecent.map(row=>({id:String(row._id),client:row.clientName||'Unregistered Client',method:row.method,status:row.status,eventType:row.eventType,
      amount:row.amount,verifiedAt:row.verifiedAt,receiptNumber:row.receiptNumber||'',invoiceId:String(row.invoice||'')})),
  };
}
export const reports=asyncHandler(async(req,res)=>{
  const scope=await resolveReportScope(req.query);
  const data=await loadReportData(scope);
  res.json({success:true,data});
});
const escapeCsv=value=>{
  const text=String(value??'');
  // Spreadsheet applications interpret leading operators as formulas.
  const safe=(/^[\s]*[=+@]/.test(text) || /^[\s]*-(?!\d+(?:\.\d+)?$)/.test(text))?`'${text}`:text;
  return `"${safe.replaceAll('"','""')}"`;
};
async function streamRows(res,cells){
  if(res.destroyed)throw new Error('Report download disconnected.');
  if(!res.write(`${cells.map(escapeCsv).join(',')}\r\n`))await once(res,'drain');
}
/** CSV export uses the same validated, client-scoped predicates as the screen.
 * Mongo cursors keep exports bounded in memory even for large collections. */
export const exportReports=asyncHandler(async(req,res)=>{
  const scope=await resolveReportScope(req.query);
  const data=await loadReportData({...scope,page:1,limit:20});
  const {company,range,client}=scope,{from,to}=range;
  const direction=scope.order==='asc'?1:-1;
  const safeName=client?.companyName?.replace(/[^a-z\d-]/ig,'-').slice(0,40)||'all-clients';
  res.status(200).set({'Content-Type':'text/csv; charset=utf-8',
    'Content-Disposition':`attachment; filename="roadway-report-${safeName}-${range.fromDay}-${range.toDay}.csv"`,
    'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff'});
  try {
  await streamRows(res,['Trans Roadway - Operational and Financial Report']);
  await streamRows(res,['Client',client?.companyName||'All Clients']);
  await streamRows(res,['Period',range.label]);
  const overview=data.reportOverview;
  for(const [key,value] of Object.entries(overview))await streamRows(res,[key,value]);
  await streamRows(res,[]);
  async function streamSection(title,headers,model,filter,sort,fields,mapper,{populateStorage=false}={}){
    await streamRows(res,[title]);await streamRows(res,headers);
    let query=model.find(filter).select(fields).sort(sort).populate('company','companyName');
    if(populateStorage)query=query.populate('storage.block','name');
    const cursor=query.lean().cursor({batchSize:100});
    try {for await(const doc of cursor)await streamRows(res,mapper(doc));}
    finally {await cursor.close();}
    await streamRows(res,[]);
  }
  await streamSection('Container Registrations',['Client','Container','Size','Type','Status','Created At'],PreAdvice,
    scopeMatch({deletedAt:null,...dateFilter('createdAt',from,to)},company),{createdAt:-1,_id:-1},'company containerNumber containerSize containerType status createdAt',
    x=>[x.company?.companyName,x.containerNumber,x.containerSize,x.containerType,x.status,x.createdAt?.toISOString()]);
  await streamSection('Historical Containers',['Client','Container','Size','Type','Status','Gate In','Released'],HistoricalContainer,
    historicRange(from,to,company),{createdAt:-1,_id:-1},'company containerNumber containerSize containerType status gateIn gateOut',
    x=>[x.company?.companyName,x.containerNumber,x.containerSize,x.containerType,x.status,x.gateIn?.actualGateInAt?.toISOString(),x.gateOut?.releasedAt?.toISOString()]);
  await streamSection('Gate-In',['Client','Container','Size','Type','Gate-In Date'],PreAdvice,
    scopeMatch({deletedAt:null,...dateFilter('gateIn.actualGateInAt',from,to)},company),{'gateIn.actualGateInAt':-1,_id:-1},'company containerNumber containerSize containerType gateIn',
    x=>[x.company?.companyName,x.containerNumber,x.containerSize,x.containerType,x.gateIn?.actualGateInAt?.toISOString()]);
  await streamSection('Gate-Out',['Client','Container','Size','Type','Release Date'],PreAdvice,
    scopeMatch({deletedAt:null,...dateFilter('gateOut.releasedAt',from,to)},company),{'gateOut.releasedAt':direction,_id:direction},'company containerNumber containerSize containerType gateOut',
    x=>[x.company?.companyName,x.containerNumber,x.containerSize,x.containerType,x.gateOut?.releasedAt?.toISOString()]);
  await streamSection('Historical Gate-Out',['Client','Container','Size','Type','Release Date'],HistoricalContainer,
    scopeMatch({deletedAt:null,...dateFilter('gateOut.releasedAt',from,to)},company),{'gateOut.releasedAt':direction,_id:direction},'company containerNumber containerSize containerType gateOut',
    x=>[x.company?.companyName,x.containerNumber,x.containerSize,x.containerType,x.gateOut?.releasedAt?.toISOString()]);
  await streamSection('Active Inventory',['Client','Container','Size','Type','Gate-In Date','Storage Block','Slot'],PreAdvice,
    activeLive(company),{'gateIn.actualGateInAt':-1,_id:-1},'company containerNumber containerSize containerType gateIn storage',
    x=>[x.company?.companyName,x.containerNumber,x.containerSize,x.containerType,x.gateIn?.actualGateInAt?.toISOString(),x.storage?.block?.name||'',x.storage?.bay?`B${x.storage.bay}-R${x.storage.row}-T${x.storage.tier}`:''],{populateStorage:true});
  await streamSection('Historical Active Inventory',['Client','Container','Size','Type','Gate-In Date','Storage Block','Slot'],HistoricalContainer,
    activeHistorical(company),{'gateIn.actualGateInAt':-1,_id:-1},'company containerNumber containerSize containerType gateIn storage',
    x=>[x.company?.companyName,x.containerNumber,x.containerSize,x.containerType,x.gateIn?.actualGateInAt?.toISOString(),x.storage?.block?.name||'',x.storage?.bay?`B${x.storage.bay}-R${x.storage.row}-T${x.storage.tier}`:''],{populateStorage:true});
  await streamSection('Invoices',['Client','Invoice','Stage','Status','Subtotal','VAT','Total','Paid','Balance','Created At'],Invoice,
    invoiceRange(from,to,company),{createdAt:-1,_id:-1},'company number type status subtotal vat total paidAmount balance createdAt',
    x=>[x.company?.companyName,x.number,x.type,x.status,x.subtotal,x.vat,x.total,x.paidAmount,x.balance,x.createdAt?.toISOString()]);
  await streamRows(res,['Payment Ledger Events (net of reversals)']);
  await streamRows(res,['Client','Type','Method','Status','Signed Amount','Receipt','Event Date']);
  const paymentCursor=PaymentSubmission.aggregate(revenuePipeline(from,to,[
    {$sort:{'events.when':-1,_id:-1}},
    {$lookup:{from:'clientcompanies',localField:'company',foreignField:'_id',as:'clientInfo'}},
    {$project:{clientName:{$ifNull:[{$first:'$clientInfo.companyName'},'Unregistered Client']},
      eventType:{$cond:[{$eq:['$events.refundOnly',true]},'REVERSAL','RECEIPT']},
      method:1,status:1,amount:'$events.amount',receiptNumber:1,when:'$events.when'}},
  ],company)).cursor({batchSize:100});
  try { for await(const event of paymentCursor) await streamRows(res,[event.clientName,event.eventType,event.method,event.status,
    event.amount,event.receiptNumber,event.when?.toISOString()]); }
  finally {await paymentCursor.close();}
  await streamRows(res,[]);
  res.end();
  } catch(error) {
    // Headers have already been sent as CSV. Never append a JSON error page.
    if(res.headersSent){res.destroy(error);return;}
    throw error;
  }
});
