import PreAdvice from '../models/PreAdvice.js';
import HistoricalContainer from '../models/HistoricalContainer.js';
import StorageBlock from '../models/StorageBlock.js';
import {asyncHandler} from '../utils/http.js';
import {reportRange,plusDays} from '../utils/businessRange.js';
import {revenueSummary,revenueByClient,revenueTimeSeries} from '../services/revenueService.js';

async function capacitySummary(){
 const [blocks,live,legacy]=await Promise.all([
  StorageBlock.aggregate([{$match:{status:{$in:['ACTIVE','FULL']}}},{$group:{_id:null,capacity:{$sum:'$capacityTeu'}}}]),
  PreAdvice.aggregate([{$match:{'inventory.status':{$in:['IN_YARD','IN_STORAGE','RELEASE_PENDING']}}},{$group:{_id:null,count20:{$sum:{$cond:[{$eq:['$containerSize','20FT']},1,0]}},count40:{$sum:{$cond:[{$eq:['$containerSize','40FT']},1,0]}}}}]),
  HistoricalContainer.aggregate([{$match:{deletedAt:null,status:{$in:['GATED_IN','STORED','GATE_OUT_APPROVED']}}},{$group:{_id:null,count20:{$sum:{$cond:[{$eq:['$containerSize','20FT']},1,0]}},count40:{$sum:{$cond:[{$eq:['$containerSize','40FT']},1,0]}}}}]),
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
export const reports=asyncHandler(async(req,res)=>{
 const range=reportRange(req.query,'monthly'),{from,to}=range;
 const releasePage=Math.max(1,parseInt(req.query.page)||1),releaseLimit=Math.min(50,Math.max(5,parseInt(req.query.limit)||20));
 const [breakdownRows,clients,releases,releaseTotal,releasesSummary,capacity,revenue,historyTotal]=await Promise.all([
  PreAdvice.aggregate([{$match:dateFilter('createdAt',from,to)},{$group:{_id:null,total:{$sum:1},empty:{$sum:{$cond:[{$eq:['$loadStatus','EMPTY']},1,0]}},loaded:{$sum:{$cond:[{$eq:['$loadStatus','LOADED']},1,0]}},local:{$sum:{$cond:[{$eq:['$transactionClassification','LOCAL']},1,0]}},international:{$sum:{$cond:[{$eq:['$transactionClassification','INTERNATIONAL']},1,0]}},size20:{$sum:{$cond:[{$eq:['$containerSize','20FT']},1,0]}},size40:{$sum:{$cond:[{$eq:['$containerSize','40FT']},1,0]}}}}]),
  revenueByClient(from,to,10),
  PreAdvice.find(dateFilter('gateOut.releasedAt',from,to)).select('bookingReference containerNumber containerSize loadStatus transactionClassification shippingLine gateOut.releasedAt gateOut.releasedBy company').populate('company','companyName').sort({'gateOut.releasedAt':-1}).skip((releasePage-1)*releaseLimit).limit(releaseLimit).lean(),
  PreAdvice.countDocuments(dateFilter('gateOut.releasedAt',from,to)),
  PreAdvice.aggregate([{$match:dateFilter('gateOut.releasedAt',from,to)},{$group:{_id:null,total:{$sum:1},size20:{$sum:{$cond:[{$eq:['$containerSize','20FT']},1,0]}},size40:{$sum:{$cond:[{$eq:['$containerSize','40FT']},1,0]}},local:{$sum:{$cond:[{$eq:['$transactionClassification','LOCAL']},1,0]}},international:{$sum:{$cond:[{$eq:['$transactionClassification','INTERNATIONAL']},1,0]}}}}]),
  capacitySummary(),revenueSummary(from,to),HistoricalContainer.countDocuments({deletedAt:null,$or:[dateFilter('originTransactionDate',from,to),dateFilter('createdAt',from,to)]}),
 ]);
 res.json({success:true,data:{range:{from:range.fromDay,to:range.toDay,period:range.mode,label:range.label,timezone:'Asia/Manila'},
  totalRevenue:revenue.total,revenueTransactions:revenue.transactions,historicalContainerCount:historyTotal,
  containerBreakdown:breakdownRows[0]||{total:0,empty:0,loaded:0,local:0,international:0,size20:0,size40:0},
  revenueByClient:clients,releaseSummary:releasesSummary[0]||{total:0,size20:0,size40:0,local:0,international:0},
  releasePagination:{page:releasePage,limit:releaseLimit,total:releaseTotal,totalPages:Math.max(1,Math.ceil(releaseTotal/releaseLimit))},
  releases:releases.map(x=>({id:String(x._id),bookingReference:x.bookingReference,containerNumber:x.containerNumber,containerSize:x.containerSize,loadStatus:x.loadStatus,classification:x.transactionClassification,shippingLine:x.shippingLine,client:x.company?.companyName||'Unknown Client',releasedAt:x.gateOut?.releasedAt,releasedBy:x.gateOut?.releasedBy||''})),capacityEquivalent:capacity,
 }});
});
