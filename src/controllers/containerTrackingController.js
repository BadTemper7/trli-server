import mongoose from 'mongoose';
import PreAdvice from '../models/PreAdvice.js';
import HistoricalContainer from '../models/HistoricalContainer.js';
import Invoice from '../models/Invoice.js';
import PaymentSubmission from '../models/PaymentSubmission.js';
import StorageMovement from '../models/StorageMovement.js';
import ClientCompany from '../models/ClientCompany.js';
import {AppError,asyncHandler} from '../utils/http.js';
import {validateHistoryChronology,HISTORIC_STATUSES} from '../utils/containerTracking.js';
import {canPrintHistorical,canPrintGateIn,canPrintGateOut} from '../utils/passAccess.js';
import {renderGatePassPdf} from '../services/printableDocuments.js';
import {calculateInvoice} from '../services/invoicingService.js';
import {auditAdminAction} from '../services/adminAuditService.js';
import {hasPermission} from '../middleware/requirePermission.js';
import {MODULES,ACTIONS} from '../constants/permissions.js';
const truthy=v=>v===true||v==='true';
const isValid=id=>mongoose.isValidObjectId(id);
const searchRx=v=>new RegExp(String(v).trim().replace(/[.*+?^${}()|[\]\\]/g,'\\$&').slice(0,90),'i');
const allowed=['company','containerNumber','containerSize','containerType','loadStatus','transactionClassification','shippingLine','truckPlateNumber','driverName','driverLicenceNumber','hauler','sealNumber','remarks','bookingReference','invoiceReferences','paymentReferences','status','gateIn','storage','gateOut','approvals','originTransactionDate'];
function cleanInput(body={}){
  const x={};for(const key of allowed)if(Object.prototype.hasOwnProperty.call(body,key))x[key]=body[key];
  for(const field of ['containerNumber','bookingReference','shippingLine','truckPlateNumber','driverName','driverLicenceNumber','hauler','remarks'])if(x[field]!==undefined)x[field]=String(x[field]||'').trim().slice(0,200);
  if(x.containerNumber)x.containerNumber=x.containerNumber.toUpperCase();
  if(x.status)x.status=String(x.status).toUpperCase();
  if(x.status&&!HISTORIC_STATUSES.includes(x.status))throw new AppError('Unsupported container status.',400);
  if(x.invoiceReferences&&!Array.isArray(x.invoiceReferences))throw new AppError('Invoice references must be a list.',400);
  if(x.paymentReferences&&!Array.isArray(x.paymentReferences))throw new AppError('Payment references must be a list.',400);
  for(const field of ['gateIn','gateOut','storage','approvals']) {
    if(x[field]!==undefined && (!x[field]||typeof x[field]!=='object'||Array.isArray(x[field])))throw new AppError(`${field} must be a structured object.`,400);
  }
  return x;
}
function dto(doc,source){
  return {...doc,id:String(doc._id),source,companyName:doc.company?.companyName||'',gateInAt:doc.gateIn?.actualGateInAt||null,storageAt:doc.storage?.storedAt||null,gateOutAt:doc.gateOut?.releasedAt||null,status:source==='HISTORICAL'?doc.status:(doc.gateOut?.releasedAt?'RELEASED':doc.storage?.status==='STORED'?'STORED':doc.gateOut?.approvedAt?'GATE_OUT_APPROVED':doc.gateIn?.actualGateInAt?'GATED_IN':doc.workflowStage||doc.status)};
}
async function load(source,id,company=null,allowArchived=false){
  if(!isValid(id))throw new AppError('Invalid container identifier.',400);
  const model=source==='historical'?HistoricalContainer:source==='live'?PreAdvice:null;
  if(!model)throw new AppError('Unknown container source.',400);
  const filter={_id:id};if(!allowArchived)filter.deletedAt=null;if(company)filter.company=company;
  const row=await model.findOne(filter).populate('company','companyName').lean();
  if(!row)throw new AppError('Container not found or unavailable.',404);
  return row;
}
async function ensureNoActiveDuplicate(number,exclude=null){
  const active={containerNumber:number, 'gateOut.releasedAt':null,'gateIn.actualGateInAt':{$ne:null}};
  const [live,legacy]=await Promise.all([
    PreAdvice.exists({...active,...(exclude?.source==='live'?{_id:{$ne:exclude.id}}:{})}),
    HistoricalContainer.exists({containerNumber:number,deletedAt:null,status:{$in:['GATED_IN','STORED','GATE_OUT_APPROVED']},...(exclude?.source==='historical'?{_id:{$ne:exclude.id}}:{})}),
  ]);
  if(live||legacy)throw new AppError('An active container with this number already exists. Record historical movement separately only after its previous release.',409);
}
function safeDayFilter(query){let from=null,to=null;for(const key of ['from','to'])if(query[key]&&!/^\d{4}-\d{2}-\d{2}$/.test(query[key]))throw new AppError('Invalid date filter.',400);
  if(query.from)from=new Date(`${query.from}T00:00:00+08:00`);
  if(query.to)to=new Date(new Date(`${query.to}T00:00:00+08:00`).getTime()+86400000);
  return {from,to};}
export const listContainers=asyncHandler(async(req,res)=>{
  const {from,to}=safeDayFilter(req.query);const filter={deletedAt:null};
  // Only administrators can inspect archived tracking records. Clients are
  // restricted to active records belonging to their verified company.
  if(!req.companyId && truthy(req.query.includeDeleted)) delete filter.deletedAt;
  if(req.query.company){if(!isValid(req.query.company))throw new AppError('Invalid company.',400);filter.company=req.query.company;}
  if(req.companyId)filter.company=req.companyId;
  if(req.query.search)filter.containerNumber=searchRx(req.query.search);
  const liveFilter={...filter},historicFilter={...filter};
  if(req.query.status){const st=String(req.query.status).toUpperCase();historicFilter.status=st;const stat={STORED:{'storage.status':'STORED'},RELEASED:{'gateOut.releasedAt':{$ne:null}},GATE_OUT_APPROVED:{'gateOut.approvedAt':{$ne:null},'gateOut.releasedAt':null},GATED_IN:{'gateIn.actualGateInAt':{$ne:null},'storage.status':{$ne:'STORED'},'gateOut.approvedAt':null},BOOKED:{'gateIn.actualGateInAt':null},CANCELLED:{status:'CANCELLED'}};Object.assign(liveFilter,stat[st]||{workflowStage:st});}
  if(from||to){const range={...(from?{$gte:from}:{}),...(to?{$lt:to}:{})};liveFilter.createdAt=range;historicFilter.$or=[{originTransactionDate:range},{createdAt:range}];}
  const page=Math.max(1,parseInt(req.query.page)||1),limit=Math.min(100,Math.max(5,parseInt(req.query.limit)||25));
  // Fetch the first page*limit of each ordered source, then merge them. This
  // paginates across both collections without an arbitrary 800-record ceiling.
  const [live,historical,liveTotal,historicalTotal]=await Promise.all([
    PreAdvice.find(liveFilter).select('bookingReference company containerNumber containerSize containerType loadStatus transactionClassification shippingLine status workflowStage gateIn storage gateOut createdAt').populate('company','companyName').sort({createdAt:-1}).limit(page*limit).lean(),
    HistoricalContainer.find(historicFilter).populate('company','companyName').sort({createdAt:-1}).limit(page*limit).lean(),
    PreAdvice.countDocuments(liveFilter),HistoricalContainer.countDocuments(historicFilter),
  ]);
  const rows=[...live.map(x=>dto(x,'LIVE')),...historical.map(x=>dto(x,'HISTORICAL'))]
    .sort((a,b)=>new Date(b.createdAt)-new Date(a.createdAt));
  return res.json({success:true,data:{items:rows.slice((page-1)*limit,page*limit),total:liveTotal+historicalTotal,page,limit}});
});
export const adminContainers=listContainers;
export const clientContainers=(req,res,next)=>{req.companyId=req.user.company._id;return listContainers(req,res,next);};
export const details=asyncHandler(async(req,res)=>{
  const source=req.params.source,doc=await load(source,req.params.id,req.companyId,req.allowArchived);
  const isLive=source==='live';
  const [invoices,movements]=isLive?await Promise.all([
    Invoice.find({booking:doc._id}).lean(),StorageMovement.find({container:doc._id}).sort({performedAt:1}).lean(),
  ]):[[],[]];
  const payments=invoices.length?await PaymentSubmission.find({invoice:{$in:invoices.map(i=>i._id)}}).select('invoice status reference amount method verifiedAt receiptNumber rejectionReason').lean():[];
  res.json({success:true,data:{container:dto(doc,isLive?'LIVE':'HISTORICAL'),invoices,payments,movements,history:doc.history||[],passAvailability:{gateIn:!doc.deletedAt&&(isLive?canPrintGateIn(doc):canPrintHistorical(doc,'GATE_IN')),gateOut:!doc.deletedAt&&(isLive?canPrintGateOut(doc):canPrintHistorical(doc,'GATE_OUT'))}}});
});
export const adminDetail=(req,res,next)=>{req.allowArchived=true;return details(req,res,next);};
export const clientDetail=(req,res,next)=>{req.companyId=req.user.company._id;return details(req,res,next);};
export const companies=asyncHandler(async(req,res)=>{
  const items=await ClientCompany.find({}).select('companyName').sort({companyName:1}).lean();res.json({success:true,data:{items}});
});
export const addHistorical=asyncHandler(async(req,res)=>{
  const data=cleanInput(req.body);
  if(!data.containerNumber||!isValid(data.company))throw new AppError('Container number and existing client company are required.',400);
  if(['GATED_IN','STORED','GATE_OUT_APPROVED'].includes(data.status))await ensureNoActiveDuplicate(data.containerNumber);
  const doc=new HistoricalContainer({...data,createdBy:req.admin._id,updatedBy:req.admin._id});
  validateHistoryChronology(doc.toObject());
  doc.history.push({action:'HISTORICAL_IMPORT',performedBy:req.admin._id,after:doc.toObject(),note:'Manually imported existing/historical container'});
  const session=await mongoose.startSession();
  try{await session.withTransaction(async()=>{
    await doc.save({session});
    await auditAdminAction({performedBy:req.admin._id,action:'HISTORICAL_CONTAINER_IMPORTED',changes:{id:String(doc._id),containerNumber:doc.containerNumber},session});
  });} finally {await session.endSession();}
  res.status(201).json({success:true,data:{item:dto(doc.toObject(),'HISTORICAL')}});
});
export const editContainer=asyncHandler(async(req,res)=>{
  const source=req.params.source,updates=cleanInput(req.body);
  const doc=await load(source,req.params.id);
  if(source==='live'){
    if(updates.status||updates.approvals||updates.company)throw new AppError('Active booking ownership, approval, and workflow status cannot be edited here.',409);
    const supported=['containerNumber','containerSize','containerType','loadStatus','transactionClassification','shippingLine','truckPlateNumber','driverName','driverLicenceNumber','hauler','remarks','gateIn','storage','gateOut'];
    for(const key of Object.keys(updates))if(!supported.includes(key))throw new AppError(`Direct changes to ${key} are not supported for live bookings.`,409);
    const invoice=await Invoice.findOne({booking:doc._id,type:'GATE_OUT'}).lean();
    const paidGateIn=await Invoice.exists({booking:doc._id,type:'GATE_IN',status:'PAID'});
    if(paidGateIn && ['containerSize','containerType','loadStatus','transactionClassification'].some(k=>updates[k]!==undefined && updates[k]!==doc[k])) throw new AppError('An approved Gate-in invoice is immutable. Request an audited billing adjustment before changing the charge classification.',409);
    if(invoice&&['PAID','PAYMENT_SUBMITTED'].includes(invoice.status)&&(['gateIn','storage','gateOut'].some(k=>k in updates)))throw new AppError('The Gate-out invoice is already submitted or paid. Request a traceable billing adjustment before correcting charge-affecting timestamps.',409);
    const before=structuredClone(doc);
    const next=structuredClone(doc);
    Object.assign(next,Object.fromEntries(Object.entries(updates).filter(([key])=>!['gateIn','gateOut','storage'].includes(key))));
    for(const key of ['gateIn','storage','gateOut'])if(updates[key]){
      const safeFields={gateIn:['actualGateInAt','remarks'],storage:['storedAt','remarks'],gateOut:['approvedAt','releasedAt','remarks']};
      const fields=Object.keys(updates[key]);if(fields.some(f=>!safeFields[key].includes(f)))throw new AppError(`Unsupported ${key} correction field.`,400);
      next[key]={...(next[key]||{}),...updates[key]};
    }
    validateHistoryChronology(next);
    if(next.gateOut?.releasedAt && !next.gateOut?.approvedAt) throw new AppError('A released live container must retain its Gate-out approval timestamp.',400);
    if(doc.gateIn?.actualGateInAt && !next.gateIn?.actualGateInAt)throw new AppError('Cannot clear a recorded physical Gate-in. Correct the date instead.',409);
    if(doc.gateOut?.approvedAt && !next.gateOut?.approvedAt)throw new AppError('Cannot clear an existing Gate-out approval timestamp.',409);
    if(doc.gateOut?.releasedAt && !next.gateOut?.releasedAt)throw new AppError('Cannot clear a recorded physical release.',409);
    if(updates.containerNumber && updates.containerNumber!==doc.containerNumber && doc.gateIn?.actualGateInAt && !doc.gateOut?.releasedAt) await ensureNoActiveDuplicate(updates.containerNumber,{source:'live',id:doc._id});
    const corrections=Object.fromEntries([
      ...Object.entries(updates).filter(([key])=>!['gateIn','gateOut','storage'].includes(key)),
      ...['gateIn','storage','gateOut'].flatMap(key=>Object.entries(updates[key]||{}).map(([field,value])=>[`${key}.${field}`,value])),
    ]);
    const repriceGateOut=invoice?.status==='UNPAID'&&['gateIn','storage','gateOut','containerSize','containerType','loadStatus','transactionClassification'].some(k=>Object.prototype.hasOwnProperty.call(updates,k));
    const adjustedInvoice=repriceGateOut?await calculateInvoice(next,'GATE_OUT',{optionalRateIds:invoice.optionalRateIds||[]}):null;
    const session=await mongoose.startSession();
    try{await session.withTransaction(async()=>{
      if(adjustedInvoice)await Invoice.updateOne({_id:invoice._id,status:'UNPAID'},{$set:{lines:adjustedInvoice.lines,optionalRateIds:adjustedInvoice.optionalRateIds,subtotal:adjustedInvoice.subtotal,vat:adjustedInvoice.vat,total:adjustedInvoice.total,balance:adjustedInvoice.total}},{session});
      await PreAdvice.updateOne({_id:doc._id},{$set:corrections,$push:{statusHistory:{status:'RECORD_CORRECTION',changedAt:new Date(),note:String(req.body.changeReason||'').slice(0,300)}}},{session});
      await auditAdminAction({performedBy:req.admin._id,action:'LIVE_CONTAINER_CORRECTED',changes:{containerId:String(doc._id),before:{containerNumber:before.containerNumber,gateIn:before.gateIn,storage:before.storage,gateOut:before.gateOut},updates},session});
    });}finally{await session.endSession();}
  } else {
    if(updates.containerNumber && updates.containerNumber!==doc.containerNumber && ['GATED_IN','STORED','GATE_OUT_APPROVED'].includes(updates.status||doc.status))await ensureNoActiveDuplicate(updates.containerNumber,{source:'historical',id:doc._id});
    const session=await mongoose.startSession();
    try{await session.withTransaction(async()=>{
      const historical=await HistoricalContainer.findOne({_id:doc._id,deletedAt:null}).session(session);
      if(!historical)throw new AppError('Historical container was updated or archived. Refresh before editing.',409);
      const before=historical.toObject();delete before.history;
      for(const [key,value]of Object.entries(updates)){
        if(['gateIn','storage','gateOut','approvals'].includes(key))historical[key]={...historical[key]?.toObject?.(),...value};
        else historical[key]=value;
      }
      validateHistoryChronology(historical.toObject());
      historical.updatedBy=req.admin._id;
      historical.history.push({action:'HISTORICAL_CORRECTION',performedBy:req.admin._id,before,after:updates,note:String(req.body.changeReason||'').slice(0,300)});
      await historical.save({session});
      await auditAdminAction({performedBy:req.admin._id,action:'HISTORICAL_CONTAINER_CORRECTED',changes:{id:String(doc._id),updates},session});
    });} finally {await session.endSession();}
  }
  res.json({success:true,message:'Container changes saved and audited.'});
});
export const deleteContainer=asyncHandler(async(req,res)=>{
  const {source,id}=req.params;const doc=await load(source,id);
  if(source==='live'){
    const invoiced=await Invoice.exists({booking:doc._id});
    if(invoiced||doc.gateIn?.actualGateInAt||!['CANCELLED','REJECTED'].includes(doc.status))throw new AppError('Container is linked to active operations or financial records. It cannot be deleted.',409);
  }
  const session=await mongoose.startSession();
  try{
    await session.withTransaction(async()=>{
      const timestamp=new Date();
      if(source==='live'){
        const result=await PreAdvice.updateOne({_id:id,deletedAt:null},{$set:{deletedAt:timestamp,deletedBy:req.admin._id}},{session});
        if(result.modifiedCount!==1)throw new AppError('Container has already been archived.',409);
      }else{
        const result=await HistoricalContainer.updateOne({_id:id,deletedAt:null},{$set:{deletedAt:timestamp,deletedBy:req.admin._id},$push:{history:{action:'SOFT_DELETED',performedBy:req.admin._id,before:{status:doc.status},note:'Retained for audit and recovery'}}},{session});
        if(result.modifiedCount!==1)throw new AppError('Container has already been archived.',409);
      }
      await auditAdminAction({performedBy:req.admin._id,action:'CONTAINER_SOFT_DELETED',changes:{source,id,containerNumber:doc.containerNumber},session});
    });
  } finally {await session.endSession();}
  res.json({success:true,message:'Container archived. Financial and audit history are retained.'});
});
export const printPass=asyncHandler(async(req,res)=>{
  const source=req.params.source,type=String(req.params.type||'').toUpperCase();
  if(!['GATE_IN','GATE_OUT'].includes(type))throw new AppError('Unknown pass type.',400);
  const doc=await load(source,req.params.id,req.companyId);
  const authorized=source==='live'?(type==='GATE_IN'?canPrintGateIn(doc):canPrintGateOut(doc)):canPrintHistorical(doc,type);
  if(!authorized)throw new AppError('This pass is unavailable until the applicable approval is recorded.',403);
  const booking=source==='live'?doc:{...doc,gateIn:{...doc.gateIn,inspection:doc.gateIn?.inspection||{status:'ACCEPTED'}},gateOut:{...doc.gateOut,approvalStatus:doc.approvals?.gateOut?'APPROVED':'NONE'}};
  const data=renderGatePassPdf({booking,type});
  res.type('application/pdf').set('Cache-Control','private,no-store').set('Content-Disposition',`${req.query.download==='1'?'attachment':'inline'}; filename="${String(doc.containerNumber).replace(/[^A-Z0-9-]/ig,'')}-${type.toLowerCase()}-pass.pdf"`).send(data);
});
export const clientPass=(req,res,next)=>{req.companyId=req.user.company._id;return printPass(req,res,next);};
