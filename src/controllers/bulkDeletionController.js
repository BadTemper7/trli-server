import fs from 'node:fs/promises';
import path from 'node:path';
import mongoose from 'mongoose';
import PreAdvice from '../models/PreAdvice.js';
import HistoricalContainer from '../models/HistoricalContainer.js';
import ForwardingContainer from '../models/ForwardingContainer.js';
import Invoice from '../models/Invoice.js';
import PaymentSubmission from '../models/PaymentSubmission.js';
import BookingSlot from '../models/BookingSlot.js';
import StorageMovement from '../models/StorageMovement.js';
import StorageBlock from '../models/StorageBlock.js';
import Rate from '../models/Rate.js';
import PaymentType from '../models/PaymentType.js';
import AdminUser from '../models/AdminUser.js';
import ClientCompany from '../models/ClientCompany.js';
import ClientUser from '../models/ClientUser.js';
import Notification from '../models/Notification.js';
import VerificationHistory from '../models/VerificationHistory.js';
import EmailOutbox from '../models/EmailOutbox.js';
import EmailOtp from '../models/EmailOtp.js';
import AdminAuditLog from '../models/AdminAuditLog.js';
import { MODULES, ACTIONS } from '../constants/permissions.js';
import {hasPermission} from '../middleware/requirePermission.js';
import {auditAdminAction} from '../services/adminAuditService.js';
import {AppError,asyncHandler} from '../utils/http.js';
import {includesIssuedFinancialRecords,acknowledgedFinancialDeletion} from '../utils/financialDeletionPolicy.js';

// Gate-in, Gate-out, Inventory, Release, and Pre-advice are views of the SAME
// PreAdvice document. All of their Delete actions must use the same cascade.
const BOOKING_MODULES = new Set(['PRE_ADVICE','GATE_IN','INVENTORY','GATE_OUT','RELEASE_CONTAINER']);
const DIRECT_MODULES = new Set(['CONTAINER_TRACKING','FORWARDING','RATE_SETUP','PAYMENT_TYPES','STORAGE_MONITORING','PAYMENT_HISTORY','USER_MANAGEMENT','CLIENT_VERIFICATION']);
const MAX_BATCH = 100;
const objects = values => values.map(id => new mongoose.Types.ObjectId(id));
const distinct = list => [...new Set(list)];

export function parseDeletionRequest(body = {}) {
  const module = String(body.module || '').toUpperCase().trim();
  const target = String(body.target || '').toUpperCase().trim();
  if (!BOOKING_MODULES.has(module) && !DIRECT_MODULES.has(module)) throw new AppError('This module does not support record deletion.',400);
  if (!Array.isArray(body.ids) || !body.ids.length || body.ids.length > MAX_BATCH) throw new AppError(`Select between 1 and ${MAX_BATCH} records.`,400);
  const ids = distinct(body.ids.map(x => String(x).trim()));
  if (ids.length !== body.ids.length) throw new AppError('The selection contains duplicate records.',400);
  const parsed = ids.map(value => {
    const sep = value.indexOf(':');
    let source = '', id = value;
    if (module === 'CONTAINER_TRACKING' && sep > 0) { source = value.slice(0,sep).toLowerCase(); id = value.slice(sep+1); }
    if (module === 'CONTAINER_TRACKING' && !source) source = target === 'HISTORICAL' ? 'historical' : 'live';
    if (source && !['live','historical'].includes(source)) throw new AppError('Invalid container source.',400);
    if (!mongoose.isValidObjectId(id) || !/^[a-f\d]{24}$/i.test(id)) throw new AppError('Invalid record identifier.',400);
    return {id,source};
  });
  if (module === 'STORAGE_MONITORING' && !['BOOKING','STORAGE_BLOCK'].includes(target)) throw new AppError('Specify the storage record type.',400);
  const reason = String(body.reason||'').trim().slice(0,500);
  return {module,target,ids:parsed,reason};
}

function deleteScope(req, parsed) {
  if (!hasPermission(req.admin,parsed.module,ACTIONS.DELETE)) throw new AppError('You do not have Delete access to this module.',403);
}
// A financial purge is an explicitly confirmed, permission-controlled operation,
// not a bypass based on NODE_ENV. Both the deletion and its audit record are
// committed in the same MongoDB transaction.
function requireFinancialAcknowledgement(req, financial) {
  if (financial && !acknowledgedFinancialDeletion(req.body)) {
    throw new AppError('This selection includes paid invoices or verified payments. Tick the permanent financial deletion acknowledgement and confirm again.', 409);
  }
}
const escapeRegex = s => String(s).replace(/[.*+?^${}()|[\]\\]/g,'\\$&');

async function preflightBookings(ids,req,session) {
  const [bookings,invoices] = await Promise.all([
    PreAdvice.find({_id:{$in:ids}}).select('_id bookingReference containerNumber status company documents').session(session).lean(),
    Invoice.find({booking:{$in:ids}}).select('_id number status total paidAmount booking').session(session).lean(),
  ]);
  if (bookings.length!==ids.length) throw new AppError('Some selected bookings no longer exist. Refresh your list.',409);
  const invoiceIds = invoices.map(x=>x._id);
  const payments = await PaymentSubmission.find({$or:[
    {booking:{$in:ids}}, ...(invoiceIds.length ? [{invoice:{$in:invoiceIds}}] : [])
  ]}).select('_id status booking invoice receiptNumber method reference amount verifiedAt proof').session(session).lean();
  const financial = includesIssuedFinancialRecords(invoices,payments);
  requireFinancialAcknowledgement(req,financial);
  return {bookings,invoices,payments,financial};
}
async function purgeBookings(ids,req,session,files) {
  if (!ids.length) return {count:0,financial:0};
  const plan=await preflightBookings(ids,req,session);
  const invoiceIds=plan.invoices.map(x=>x._id);
  await PaymentSubmission.deleteMany({$or:[{booking:{$in:ids}}, ...(invoiceIds.length?[{invoice:{$in:invoiceIds}}]:[])]},{session});
  await Invoice.deleteMany({booking:{$in:ids}},{session});
  await StorageMovement.deleteMany({container:{$in:ids}},{session});
  await BookingSlot.updateMany({bookings:{$in:ids}},{$pull:{bookings:{$in:ids}}},{session});
  // Leave the hourly reservation rows in place: their unique day/hour index is
  // reusable, and the empty booking list no longer consumes capacity.
  const references=plan.bookings.map(x=>x.bookingReference).filter(Boolean);
  const bookingKeys=[...ids,...ids.map(String)];
  await Notification.deleteMany({$or:[{'data.bookingId':{$in:bookingKeys}},{'data.booking':{$in:bookingKeys}},{'data.bookingReference':{$in:references}}]},{session});
  for(const b of plan.bookings){
    const refs=[b.bookingReference,String(b._id),...plan.invoices.filter(i=>String(i.booking)===String(b._id)).map(i=>i.number)].filter(Boolean);
    for(const ref of refs) await EmailOutbox.deleteMany({status:{$in:['PENDING','FAILED']},eventKey:{$regex:escapeRegex(ref)}},{session});
    for(const doc of b.documents||[])if(doc.storedName)files.push(['pre-advice',doc.storedName]);
  }
  for(const p of plan.payments)if(p.proof?.storedName)files.push(['payment-proofs',p.proof.storedName]);
  const result=await PreAdvice.deleteMany({_id:{$in:ids}},{session});
  if(result.deletedCount!==ids.length)throw new AppError('Concurrent booking deletion detected; no records were deleted.',409);
  return {count:ids.length,financial:plan.payments.filter(p=>p.status==='VERIFIED').length,
    removedInvoices:plan.invoices.map(x=>({number:x.number,total:x.total,paidAmount:x.paidAmount,status:x.status})),
    removedPayments:plan.payments.map(p=>({invoice:String(p.invoice||''),status:p.status,receiptNumber:p.receiptNumber,method:p.method,reference:p.reference,amount:p.amount,verifiedAt:p.verifiedAt})),
    bookings:plan.bookings.map(x=>({reference:x.bookingReference,container:x.containerNumber}))};
}

async function executeDelete(req,parsed,session,files) {
  const {module,target}=parsed;
  const ids=objects(parsed.ids.map(x=>x.id));
  if (BOOKING_MODULES.has(module) || (module==='STORAGE_MONITORING'&&target==='BOOKING'))return purgeBookings(ids,req,session,files);
  if(module==='CONTAINER_TRACKING') {
    const live=objects(parsed.ids.filter(x=>x.source==='live').map(x=>x.id));
    const historical=objects(parsed.ids.filter(x=>x.source==='historical').map(x=>x.id));
    let summary={count:0,financial:0};
    if(live.length){const result=await purgeBookings(live,req,session,files);summary={...result,count:result.count};}
    if(historical.length){const docs=await HistoricalContainer.find({_id:{$in:historical}}).select('_id containerNumber status').session(session).lean();if(docs.length!==historical.length)throw new AppError('Some selected historical records no longer exist.',409);const deleted=await HistoricalContainer.deleteMany({_id:{$in:historical}},{session});summary.count+=deleted.deletedCount;summary.historical=docs.map(x=>({id:String(x._id),container:x.containerNumber,status:x.status}));}
    return summary;
  }
  if(module==='CLIENT_VERIFICATION') {
    const companies=await ClientCompany.find({_id:{$in:ids}}).session(session).lean();
    if(companies.length!==ids.length)throw new AppError('Some companies no longer exist.',409);
    const bookings=await PreAdvice.find({company:{$in:ids}}).select('_id').session(session).lean();
    const bResult=await purgeBookings(bookings.map(x=>x._id),req,session,files);
    const clients=await ClientUser.find({company:{$in:ids}}).select('_id email').session(session).lean();
    await HistoricalContainer.deleteMany({company:{$in:ids}},{session});
    await VerificationHistory.deleteMany({company:{$in:ids}},{session});
    await Notification.deleteMany({$or:[{company:{$in:ids}},{user:{$in:clients.map(x=>x._id)}}]},{session});
    await EmailOtp.deleteMany({email:{$in:clients.map(c=>c.email).filter(Boolean)}},{session});
    await ClientUser.deleteMany({company:{$in:ids}},{session});
    await ClientCompany.deleteMany({_id:{$in:ids}},{session});
    for(const c of companies)for(const d of c.documents||[])if(d.storedName)files.push(['client-verification',d.storedName]);
    return {count:ids.length,removedBookings:bResult.count,removedUsers:clients.length,companies:companies.map(x=>x.companyName)};
  }
  if(module==='FORWARDING') {
    const docs=await ForwardingContainer.find({_id:{$in:ids}}).select('_id containerNumber status').session(session).lean();if(docs.length!==ids.length)throw new AppError('Some forwarding records no longer exist.',409);
    const r=await ForwardingContainer.deleteMany({_id:{$in:ids}},{session});return {count:r.deletedCount,containers:docs.map(x=>({number:x.containerNumber,status:x.status}))};
  }
  if(module==='STORAGE_MONITORING') {
    const used=await PreAdvice.exists({'storage.block':{$in:ids},deletedAt:null}).session(session);
    if(used)throw new AppError('Delete or relocate the containers assigned to these blocks before deleting storage blocks.',409);
    const docs=await StorageBlock.find({_id:{$in:ids}}).session(session).lean();if(docs.length!==ids.length)throw new AppError('Some storage blocks no longer exist.',409);
    await StorageBlock.deleteMany({_id:{$in:ids}},{session});return {count:ids.length,blocks:docs.map(x=>x.name)};
  }
  if(module==='RATE_SETUP') {
    const used=await Invoice.exists({'lines.rateId':{$in:ids}}).session(session);
    if(used)throw new AppError('One or more rates are referenced by an invoice. Deactivate these rates instead to preserve historical billing.',409);
    const docs=await Rate.find({_id:{$in:ids}}).select('name amount collectionPoint').session(session).lean();if(docs.length!==ids.length)throw new AppError('Some rates no longer exist.',409);
    await Rate.deleteMany({_id:{$in:ids}},{session});return {count:ids.length,rates:docs};
  }
  if(module==='PAYMENT_TYPES') {
    const docs=await PaymentType.find({_id:{$in:ids}}).session(session).lean();if(docs.length!==ids.length)throw new AppError('Some payment types no longer exist.',409);
    const pending=await PaymentSubmission.exists({method:{$in:docs.map(x=>x.code)},status:'PENDING_VERIFICATION'}).session(session);
    if(pending)throw new AppError('A payment type has pending client submissions. Verify or reject them before deleting this method.',409);
    await PaymentType.deleteMany({_id:{$in:ids}},{session});return {count:ids.length,methods:docs.map(x=>({code:x.code,name:x.name}))};
  }
  if(module==='USER_MANAGEMENT') {
    const docs=await AdminUser.find({_id:{$in:ids}}).session(session).lean();if(docs.length!==ids.length)throw new AppError('Some administrator accounts no longer exist.',409);
    if(docs.some(x=>x.isSystemProtected || (process.env.SUPER_ADMIN_EMAIL&&x.email===process.env.SUPER_ADMIN_EMAIL.toLowerCase())||String(x._id)===String(req.admin._id)))throw new AppError('The protected Super Admin or your own account cannot be deleted.',403);
    if(docs.some(x=>x.status!=='INACTIVE'))throw new AppError('Deactivate each administrator before deletion.',409);
    if(docs.some(x=>x.role==='SUPER_ADMIN') && req.admin.role!=='SUPER_ADMIN')throw new AppError('Only Super Admins can delete other Super Admin accounts.',403);
    await AdminUser.deleteMany({_id:{$in:ids}},{session});return {count:ids.length,users:docs.map(x=>({email:x.email,role:x.role}))};
  }
  if(module==='PAYMENT_HISTORY') {
    const docs=await Invoice.find({_id:{$in:ids}}).session(session).lean();
    if(docs.length!==ids.length)throw new AppError('Some invoices no longer exist. Refresh the list.',409);
    const payments=await PaymentSubmission.find({invoice:{$in:ids}}).session(session).lean();
    requireFinancialAcknowledgement(req,includesIssuedFinancialRecords(docs,payments));
    // Deleting a paid invoice in isolation would leave the booking marked as
    // paid while removing its financial proof. Cascade the COMPLETE linked
    // booking instead, and require explicit container Delete authorization.
    const bookingIds=distinct(docs.map(x=>String(x.booking||'')).filter(x=>mongoose.isValidObjectId(x)));
    const linked=await PreAdvice.find({_id:{$in:bookingIds}}).select('_id').session(session).lean();
    if(linked.length && !hasPermission(req.admin,MODULES.CONTAINER_TRACKING,ACTIONS.DELETE)
      && !hasPermission(req.admin,MODULES.PRE_ADVICE,ACTIONS.DELETE)) {
      throw new AppError('Deleting an invoice also removes its linked container. You need Container Tracking or Pre-advice Delete permission to continue.',403);
    }
    const linkedIds=linked.map(x=>x._id);
    let bookingCascade={count:0};
    if(linkedIds.length)bookingCascade=await purgeBookings(linkedIds,req,session,files);
    const orphanIds=ids.filter(x=>!linked.some(b=>docs.some(i=>String(i._id)===String(x)&&String(i.booking)===String(b._id))));
    let orphanPayments=[];
    if(orphanIds.length){
      orphanPayments=await PaymentSubmission.find({invoice:{$in:orphanIds}}).session(session).lean();
      await PaymentSubmission.deleteMany({invoice:{$in:orphanIds}},{session});
      await Invoice.deleteMany({_id:{$in:orphanIds}},{session});
      for(const p of orphanPayments)if(p.proof?.storedName)files.push(['payment-proofs',p.proof.storedName]);
    }
    return {count:ids.length,removedBookings:bookingCascade.count,
      removedInvoices:[...(bookingCascade.removedInvoices||[]),...docs.filter(x=>orphanIds.some(id=>String(id)===String(x._id))).map(x=>({number:x.number,total:x.total,status:x.status}))],
      removedPayments:[...(bookingCascade.removedPayments||[]),...orphanPayments.map(p=>({receiptNumber:p.receiptNumber,status:p.status,amount:p.amount}))]};
  }
  throw new AppError('Unknown deletion target.',400);
}

async function cleanupFiles(files) {
  const failures=[];
  for(const [folder,name] of files){
    if(!/^[a-f0-9-]{30,}\.(pdf|png|jpe?g)$/i.test(String(name)))continue;
    try{await fs.unlink(path.resolve('uploads',folder,path.basename(name)));}catch(e){if(e.code!=='ENOENT')failures.push(name);}
  }
  return failures;
}

export const deleteRecords=asyncHandler(async(req,res)=>{
  const parsed=parseDeletionRequest(req.body);
  try{deleteScope(req,parsed);}catch(error){try{await auditAdminAction({performedBy:req.admin._id,action:'DELETE_DENIED',changes:{module:parsed.module,target:parsed.target,ids:parsed.ids.map(x=>x.id),message:String(error.message)}});}catch{}throw error;}
  if(String(req.body.confirmation||'')!==`DELETE ${parsed.ids.length}` || parsed.reason.length<8){
    try{await auditAdminAction({performedBy:req.admin._id,action:'DELETE_DENIED',changes:{module:parsed.module,target:parsed.target,ids:parsed.ids.map(x=>x.id),message:'Missing confirmation or audit reason'}});}catch{}
    throw new AppError(`Type DELETE ${parsed.ids.length} and provide an audit reason of at least 8 characters.`,400);
  }
  let result;const files=[];
  const session=await mongoose.startSession();
  try {
    await session.withTransaction(async()=>{
      result=await executeDelete(req,parsed,session,files);
      await auditAdminAction({performedBy:req.admin._id,action:parsed.ids.length>1?'RECORDS_BULK_DELETED':'RECORD_DELETED',changes:{module:parsed.module,target:parsed.target,ids:parsed.ids.map(x=>x.source?`${x.source}:${x.id}`:x.id),reason:parsed.reason,result},session});
    },{readConcern:{level:'snapshot'},writeConcern:{w:'majority'}});
  } catch(error) {
    // A denial cannot be logged in the failed transaction; best-effort attempt
    // separately, without masking the original database or access error.
    try{await auditAdminAction({performedBy:req.admin._id,action:'DELETE_FAILED',changes:{module:parsed.module,target:parsed.target,ids:parsed.ids.map(x=>x.id),reason:parsed.reason,message:String(error.message).slice(0,300)}});}catch{/* retain original failure */}
    throw error;
  } finally{await session.endSession();}
  const fileFailures=await cleanupFiles(files);
  if(fileFailures.length){try{await auditAdminAction({performedBy:req.admin._id,action:'DELETE_FILE_CLEANUP_FAILED',changes:{module:parsed.module,files:fileFailures}});}catch{}}
  res.json({success:true,message:`${result.count} record(s) deleted and logged.`,data:{...result,fileCleanupWarnings:fileFailures.length}});
});

export const auditLogs=asyncHandler(async(req,res)=>{
  const page=Math.max(1,Math.floor(Number(req.query.page)||1)),limit=Math.min(100,Math.max(1,Math.floor(Number(req.query.limit)||25)));
  const filter={};
  if(req.query.action)filter.action=String(req.query.action).trim().slice(0,90);
  if(req.query.from||req.query.to){filter.createdAt={};if(req.query.from){if(!/^\d{4}-\d{2}-\d{2}$/.test(req.query.from))throw new AppError('Invalid start date.',400);filter.createdAt.$gte=new Date(`${req.query.from}T00:00:00+08:00`);}if(req.query.to){if(!/^\d{4}-\d{2}-\d{2}$/.test(req.query.to))throw new AppError('Invalid end date.',400);filter.createdAt.$lt=new Date(new Date(`${req.query.to}T00:00:00+08:00`).getTime()+86400000);}}
  const [rows,total]=await Promise.all([AdminAuditLog.find(filter).populate('performedBy','firstName lastName email').sort({createdAt:-1}).skip((page-1)*limit).limit(limit).lean(),AdminAuditLog.countDocuments(filter)]);
  res.json({success:true,data:{items:rows,total,page,limit}});
});
