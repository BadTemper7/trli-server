import mongoose from 'mongoose';
import PreAdvice from '../models/PreAdvice.js';
import HistoricalContainer from '../models/HistoricalContainer.js';
import Invoice from '../models/Invoice.js';
import { ACTIVE_HISTORICAL } from './storageAssignmentService.js';
import { storageDaysBetween } from '../utils/storageDuration.js';
import { AppError } from '../utils/http.js';
import { pageOptions, prefixSearch, scalar, objectIdParam, enumParam } from '../utils/tableQuery.js';

const ACTIVE_LIVE = { deletedAt:null, 'gateIn.actualGateInAt': { $ne:null }, 'gateOut.releasedAt':null };
const ACTIVE_IMPORT = { deletedAt:null, status: { $in: ACTIVE_HISTORICAL }, 'gateIn.actualGateInAt': { $ne:null }, 'gateOut.releasedAt':null };
const LIVE_FIELDS = 'bookingReference company containerNumber containerSize containerType loadStatus transactionClassification gateIn storage gateOut inventory status workflowStage createdAt updatedAt';
const HIST_FIELDS = 'bookingReference company containerNumber containerSize containerType loadStatus transactionClassification gateIn storage gateOut status invoiceReferences createdAt updatedAt';
const selectFields = [ {path:'company',select:'companyName'}, {path:'storage.block',select:'name'} ];
const matchSource = value => value === '' || ['LIVE','HISTORICAL'].includes(value);
const SORT_FIELDS = ['createdAt','updatedAt','containerNumber','containerSize','containerType','gateInDate'];
const sortPath = value => value === 'gateInDate' ? 'gateIn.actualGateInAt' : value;
const orderValue = (doc, column) => column === 'gateInDate' ? doc.gateIn?.actualGateInAt : doc[column];
const compareValue = (a,b,sort) => {
  if (sort === 'createdAt' || sort === 'updatedAt' || sort === 'gateInDate') return normalizeDate(a)-normalizeDate(b);
  return String(a ?? '').localeCompare(String(b ?? ''), 'en', {sensitivity:'base'});
};
function normalizeDate(value){const date=new Date(value);return Number.isFinite(date.getTime())?date.getTime():0;}
export function buildInventoryFilters(query={}) {
  const source=scalar(query,'source').toUpperCase();
  if (!matchSource(source)) throw new AppError('source must be LIVE or HISTORICAL.',400);
  const storage=scalar(query,'storage').toUpperCase();
  if (!['','STORED','WAITING'].includes(storage)) throw new AppError('storage must be STORED or WAITING.',400);
  const company=objectIdParam(query,'company');
  const size=enumParam(query,'size',['20FT','40FT']);
  const type=enumParam(query,'type',['DRY CONTAINER','REEFER','TANK CONTAINER','OPEN TOP','FLAT RACK']);
  const search=prefixSearch(query);
  const live={...ACTIVE_LIVE},historical={...ACTIVE_IMPORT};
  for (const filter of [live,historical]) {
    if (company) filter.company=new mongoose.Types.ObjectId(company);
    if (size) filter.containerSize=size;
    if (type) filter.containerType=type;
    // Container numbers are normalized uppercase at write time. Case-sensitive
    // anchored prefixes can use the existing containerNumber B-tree index.
    if (search) filter.containerNumber={$regex:search.$regex.toUpperCase()};
  }
  if (storage==='STORED') {
    live['storage.status']='STORED';historical['storage.block']={$ne:null};
  } else if (storage==='WAITING') {
    live['storage.status']={$ne:'STORED'};historical['storage.block']=null;
  }
  if (source==='HISTORICAL') live._id={$in:[]};
  if (source==='LIVE') historical._id={$in:[]};
  return {live,historical};
}
export function inventoryItemView(doc,source,records=[]) {
  const stored=source==='HISTORICAL'?Boolean(doc.storage?.block):doc.storage?.status==='STORED';
  const gateIn=doc.gateIn?.actualGateInAt||null;
  const paid=records.reduce((sum,invoice)=>sum+Number(invoice.paidAmount||0),0);
  const outstanding=records.reduce((sum,invoice)=>sum+Number(invoice.balance||0),0);
  return {...doc,id:String(doc._id),source,
    companyName:doc.company?.companyName||'',
    bookingReference:doc.bookingReference||`HIST-${String(doc._id).slice(-8).toUpperCase()}`,
    workflowStage:source==='HISTORICAL'?(stored?'STORAGE':'INVENTORY'):doc.workflowStage,
    inventory:source==='HISTORICAL'?{...doc.inventory,status:stored?'IN_STORAGE':'IN_YARD',receivedAt:gateIn,sealNumber:doc.inventory?.sealNumber||doc.sealNumber||''}:doc.inventory,
    storage:doc.storage||{},
    gateInAt:gateIn,
    daysInTerminal:gateIn?storageDaysBetween(gateIn,new Date()):0,
    billingStatus:source==='HISTORICAL'?(doc.invoiceReferences?.length?'EXTERNAL_RECORD':'NOT_BILLED'):
      !records.length?'NOT_BILLED':outstanding>0?(paid>0?'PARTIALLY_PAID':'UNPAID'):'PAID',
    amountPaid:paid,outstandingBalance:outstanding,
    currentStatus:stored?'IN_STORAGE':'GATED_IN',
  };
}
export async function listActiveInventory(query={}) {
  const {live,historical}=buildInventoryFilters(query);
  const paging=pageOptions(query,{defaultLimit:20,maxLimit:100,sorts:SORT_FIELDS,defaultSort:'createdAt'});
  const cap=paging.page*paging.limit;
  const sort={ [sortPath(paging.sort)]:paging.direction, _id:paging.direction };
  // Two bounded indexed reads; avoid loading the entire yard into Node memory.
  const [liveRows,historicalRows,liveCount,historicalCount]=await Promise.all([
    PreAdvice.find(live).select(LIVE_FIELDS).populate(selectFields).sort(sort).limit(cap).lean(),
    HistoricalContainer.find(historical).select(HIST_FIELDS).populate(selectFields).sort(sort).limit(cap).lean(),
    PreAdvice.countDocuments(live),HistoricalContainer.countDocuments(historical),
  ]);
  const compare=(a,b)=>{
    const diff=compareValue(orderValue(a,paging.sort),orderValue(b,paging.sort),paging.sort);
    if(diff) return paging.order==='asc'?diff:-diff;
    return String(a._id).localeCompare(String(b._id))*(paging.order==='asc'?1:-1);
  };
  // For now the inventory API preserves numbered-page pagination. Combined
  // cursor mode can be introduced if yard size reaches high six figures.
  const merged=[...liveRows.map(row=>({...row,source:'LIVE'})),...historicalRows.map(row=>({...row,source:'HISTORICAL'}))].sort(compare);
  const page=merged.slice((paging.page-1)*paging.limit,paging.page*paging.limit);
  const ids=page.filter(item=>item.source==='LIVE').map(item=>item._id);
  const invoices=ids.length?await Invoice.find({booking:{$in:ids},status:{$nin:['VOID','CANCELLED']}}).select('booking paidAmount balance status').lean():[];
  const byBooking=new Map();
  for(const invoice of invoices){const id=String(invoice.booking);if(!byBooking.has(id))byBooking.set(id,[]);byBooking.get(id).push(invoice);}
  const items=page.map(row=>inventoryItemView(row,row.source,byBooking.get(String(row._id))||[]));
  return {items,pagination:{page:paging.page,limit:paging.limit,total:liveCount+historicalCount,totalPages:Math.ceil((liveCount+historicalCount)/paging.limit),pages:Math.ceil((liveCount+historicalCount)/paging.limit)}};
}
export async function inventoryTotals(query={}) {
  const {live,historical}=buildInventoryFilters(query);
  const [[a],[b]]=await Promise.all([
    PreAdvice.aggregate([{$match:live},{$group:{_id:null,all:{$sum:1},stored:{$sum:{$cond:[{$eq:['$storage.status','STORED']},1,0]}},waitingStorage:{$sum:{$cond:[{$ne:['$storage.status','STORED']},1,0]}}}}]),
    HistoricalContainer.aggregate([{$match:historical},{$group:{_id:null,all:{$sum:1},stored:{$sum:{$cond:[{$ne:[{$ifNull:['$storage.block',null]},null]},1,0]}},waitingStorage:{$sum:{$cond:[{$eq:[{$ifNull:['$storage.block',null]},null]},1,0]}}}}]),
  ]);
  return {all:(a?.all||0)+(b?.all||0),total:(a?.all||0)+(b?.all||0),stored:(a?.stored||0)+(b?.stored||0),waitingStorage:(a?.waitingStorage||0)+(b?.waitingStorage||0)};
}
