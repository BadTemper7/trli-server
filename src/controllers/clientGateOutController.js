import mongoose from 'mongoose';
import fs from 'fs/promises';
import path from 'path';
import {renderFinancialPdf} from '../services/pdfDocuments.js';
import {renderServiceInvoicePdf} from '../services/printableDocuments.js';
import SiteSettings from '../models/SiteSettings.js';
import ClientCompany from '../models/ClientCompany.js';
import PreAdvice from '../models/PreAdvice.js';
import Invoice from '../models/Invoice.js';
import PaymentSubmission from '../models/PaymentSubmission.js';
import { getReceivingMethod, receivingAccountSnapshot } from '../services/paymentMethods.js';
import {reserveSlot,releaseSlot,validateSlot} from '../utils/bookingSlots.js';
import {AppError,asyncHandler} from '../utils/http.js';
import {advanceWorkflow} from '../utils/preAdviceWorkflow.js';
import {calculateInvoice,availableOptionalCharges,previewGateOutTransactions} from '../services/invoicingService.js';
import {parseOptionalRateIds} from '../utils/billingMath.js';
import {requireGateOutAfterGateIn} from '../utils/storageDuration.js';
import {nextReference} from '../utils/referenceNumbers.js';
import {uniqueReceiptNumber} from '../utils/uniqueReceipt.js';
import {paymentReviewFailure} from '../utils/financialReviewErrors.js';
import {parseGateOutReleaseCondition,parseGateOutReleaseRemarks} from '../utils/gateOutReleaseCondition.js';
import {auditAdminAction} from '../services/adminAuditService.js';
import {enqueueBookingMail} from '../services/transactionalMail.js';
import {createNotification} from '../services/notificationService.js';
import {validateUploadedProof,validatePaymentEvidence} from '../services/paymentProofValidation.js';
import {emitToAdminModule,getIO} from '../socket/index.js';
import {MODULES} from '../constants/permissions.js';
import { clearSummaryCache } from '../utils/summaryCache.js';

const stages=['GATE_OUT_REQUESTED','GATE_OUT_PAYMENT_SUBMITTED'];
function validateGateOutAfterArrival(booking, day, hour) {
  if (!booking.gateIn?.actualGateInAt) throw new AppError('Actual Gate-in time is required before scheduling Gate-out.', 409);
  try { requireGateOutAfterGateIn(booking.gateIn.actualGateInAt, day, hour); }
  catch (error) { throw new AppError(error.message, 400); }
}
/** Client-owned, read-only preview of configured Gate-out transactions. */
export const listClientGateOutTransactions=asyncHandler(async(req,res)=>{
 const booking=await PreAdvice.findOne({_id:req.params.id,company:req.user.company._id}).lean();
 if(!booking)throw new AppError('Booking not found.',404);
 if(booking.workflowStage!=='STORAGE'||booking.storage?.status!=='STORED'||booking.gateOut?.releasedAt)
   throw new AppError('Only stored and unreleased containers can review a new Gate-out quotation.',409);
 const transactions=await previewGateOutTransactions(booking);
 res.json({success:true,data:{transactions,classification:booking.transactionClassification,loadStatus:booking.loadStatus,containerSize:booking.containerSize,containerCategory:booking.containerType==='REEFER'?'REEFER':'STANDARD'}});
});

export const quoteClientGateOut=asyncHandler(async(req,res)=>{
 const b=await PreAdvice.findOne({_id:req.params.id,company:req.user.company._id}).lean();
 if(!b)throw new AppError('Booking not found.',404);
 if(b.workflowStage!=='STORAGE'||b.storage?.status!=='STORED')throw new AppError('Only stored containers can request gate-out.',409);
 const day=String(req.query.date||''),hour=String(req.query.time||'');
 if(!day||!hour)throw new AppError('Select a gate-out date and time.',400);
 validateGateOutAfterArrival(b,day,hour);
 await validateSlot(day,hour);
 const selected=parseOptionalRateIds(req.query.optionalRateIds);
 const quote=await calculateInvoice({...b,gateOut:{...b.gateOut,scheduledDate:day,scheduledTime:hour}},'GATE_OUT',{optionalRateIds:selected});
 const optionalCharges=await availableOptionalCharges(b,'GATE_OUT');
 res.json({success:true,data:{quote,optionalCharges,transport:{truckPlateNumber:b.truckPlateNumber,driverName:b.driverName,driverLicenceNumber:b.driverLicenceNumber,hauler:b.hauler},actualGateInAt:b.gateIn?.actualGateInAt,storage:b.storage}});
});
export const requestClientGateOut=asyncHandler(async(req,res)=>{
 const file=req.file;
 let committed=false;
 try{
  await validateUploadedProof(file);
  const day=String(req.body.scheduledDate||''),hour=String(req.body.scheduledTime||'');
  const method=String(req.body.method||'').toUpperCase(),reference=String(req.body.reference||'').trim();
  validatePaymentEvidence(reference,file);
  const receivingMethod = await getReceivingMethod(method);
  const booking=await PreAdvice.findOne({_id:req.params.id,company:req.user.company._id});
  if(!booking)throw new AppError('Booking not found.',404);
  validateGateOutAfterArrival(booking,day,hour);
  await validateSlot(day,hour);
  if(booking.workflowStage!=='STORAGE'||booking.storage?.status!=='STORED'||booking.gateOut?.approvedAt||booking.gateOut?.releasedAt)throw new AppError('Container is not eligible or already has an active request.',409);
  const raw=booking.toObject();const optionalRateIds=parseOptionalRateIds(req.body.optionalRateIds);
  const quote=await calculateInvoice({...raw,gateOut:{...raw.gateOut,scheduledDate:day,scheduledTime:hour}},'GATE_OUT',{optionalRateIds});
  const amount=Number(req.body.amount);
  if(!Number.isFinite(amount)||Math.abs(amount-quote.total)>0.001)throw new AppError('Payment amount must equal the server-calculated total.',400);
  if(reference && await PaymentSubmission.exists({method,reference,status:{$in:['VERIFIED','PENDING_VERIFICATION']}}))throw new AppError('Payment reference is already submitted.',409);
  const session=await mongoose.startSession();
  try{
   await session.withTransaction(async()=>{
    const fresh=await PreAdvice.findOne({_id:booking._id,company:req.user.company._id}).session(session);
    if(!fresh)throw new AppError('Booking not found.',404);
    if(fresh.workflowStage!=='STORAGE'||fresh.storage?.status!=='STORED')throw new AppError('Gate-out was already requested.',409);
    await reserveSlot(fresh._id,day,hour,session,'GATE_OUT');
    let invoice=await Invoice.findOne({booking:fresh._id,type:'GATE_OUT'}).session(session);
    if(invoice && !['UNPAID','VOID'].includes(invoice.status))throw new AppError('Existing gate-out payment or invoice cannot be replaced.',409);
    if(invoice){Object.assign(invoice,quote,{status:'PAYMENT_SUBMITTED',paidAmount:0,balance:quote.total});await invoice.save({session});}
    else invoice=(await Invoice.create([{...quote,number:await nextReference('INVOICE',new Date(),session),booking:fresh._id,company:fresh.company,type:'GATE_OUT',status:'PAYMENT_SUBMITTED'}],{session}))[0];
    await PaymentSubmission.create([{invoice:invoice._id,company:fresh.company,booking:fresh._id,method,reference,amount,receivingAccount:receivingAccountSnapshot(receivingMethod),proof:file?{storedName:file.filename,name:file.originalname,mimeType:file.mimetype,size:file.size}:undefined,submittedBy:req.user._id}],{session});
    fresh.gateOut.approvalStatus='PENDING_APPROVAL';fresh.gateOut.requestedAt=new Date();fresh.gateOut.requestedBy=String(req.user._id);fresh.gateOut.scheduledDate=day;fresh.gateOut.scheduledTime=hour;
    fresh.gateOut.truckPlateNumber=fresh.truckPlateNumber;fresh.gateOut.driverName=fresh.driverName;
    fresh.gateOut.remarks='';fresh.gateOut.conditionUponRelease=[];fresh.gateOut.conditionRemarks='';fresh.gateOut.conditionRecordedAt=null;fresh.gateOut.conditionRecordedBy=null;
    fresh.gateOut.payment.status='SUBMITTED';fresh.gateOut.payment.amountDue=quote.total;fresh.gateOut.payment.amountSubmitted=amount;fresh.gateOut.payment.method=method;fresh.gateOut.payment.referenceNumber=reference;fresh.gateOut.payment.submittedAt=new Date();
    advanceWorkflow(fresh,stages,{note:'Gate-out request and online payment proof submitted; pending admin approval'});
    await fresh.save({session});
   });
   committed=true;
  }finally{await session.endSession();}
  await createNotification({company:booking.company,audience:'ADMIN',type:'GATE_OUT_REQUESTED',title:'Gate-out request ready for review',message:`${booking.bookingReference} submitted a gate-out request and payment proof.`,data:{id:booking._id,bookingId:booking._id,bookingReference:booking.bookingReference}}).catch(console.error);
  clearSummaryCache();
  emitToAdminModule(MODULES.GATE_OUT,'gate-out:updated',{id:String(booking._id),bookingReference:booking.bookingReference});
  emitToAdminModule(MODULES.PAYMENT_HISTORY,'invoice:updated',{bookingId:String(booking._id)});
  getIO()?.to(`company:${booking.company}`).emit('pre-advice:workflow-updated',{id:String(booking._id),workflowStage:'GATE_OUT_PAYMENT_SUBMITTED'});
  getIO()?.to(`company:${booking.company}`).emit('invoice:updated',{bookingId:String(booking._id)});
  res.json({success:true,message:'Gate-out request and payment submitted for verification.',data:{bookingId:booking._id}});
 }catch(e){if(!committed&&file?.path)await fs.unlink(file.path).catch(()=>{});throw paymentReviewFailure(e,{reference:req.body?.reference});}
});
export const reviewClientGateOut=asyncHandler(async(req,res)=>{
 const decision=String(req.body?.decision||'').toUpperCase();
 const reason=String(req.body?.reason||'').trim().slice(0,800);
 if(!['APPROVE','REJECT'].includes(decision))throw new AppError('Decision must be APPROVE or REJECT.',400);
 if(decision==='REJECT'&&!reason)throw new AppError('Rejection reason is required.',400);
 if(!mongoose.isValidObjectId(req.params.id))throw new AppError('Invalid booking identifier.',400);
 let booking,invoice,payment,alreadyReviewed=false;
 let conditionUponRelease=[],conditionRemarks='';
 // Receipt numbers are allocated inside the same MongoDB transaction as the
 // payment, invoice, booking and audit. Retry only conflicting receipt counters.
 for(let attempt=0;attempt<4;attempt++){
  booking=null;invoice=null;payment=null;alreadyReviewed=false;
  const session=await mongoose.startSession();
  try{
   await session.withTransaction(async()=>{
    booking=await PreAdvice.findById(req.params.id).session(session);
    if(!booking)throw new AppError('Booking not found.',404);
    invoice=await Invoice.findOne({booking:booking._id,type:'GATE_OUT'}).session(session);
    if(!invoice)throw new AppError('Gate-out invoice not found for this booking.',409);

    // Safe to re-click after a response was lost. Never issue another receipt,
    // charge, audit entry, or workflow transition for a completed decision.
    if(booking.workflowStage!=='GATE_OUT_PAYMENT_SUBMITTED'||invoice.status!=='PAYMENT_SUBMITTED'){
     const expectedStatus=decision==='APPROVE'?'VERIFIED':'REJECTED';
     const existing=await PaymentSubmission.findOne({invoice:invoice._id,status:expectedStatus}).session(session);
     const consistent=decision==='APPROVE'
      ? invoice.status==='PAID'&&invoice.balance===0&&['APPROVED','RELEASED'].includes(booking.gateOut?.approvalStatus)
      : invoice.status==='UNPAID'&&booking.gateOut?.approvalStatus==='REJECTED';
     if(existing&&consistent){payment=existing;alreadyReviewed=true;return;}
     throw new AppError('This Gate-out request is no longer awaiting payment review. Refresh its details.',409);
    }
    payment=await PaymentSubmission.findOne({invoice:invoice._id,status:'PENDING_VERIFICATION'}).session(session);
    if(!payment)throw new AppError('No pending Gate-out payment to verify. Refresh the booking.',409);
    if(!booking.gateOut?.payment||!booking.inventory)throw new AppError('Booking Gate-out state is incomplete. Contact technical support.',409);

    if(decision==='APPROVE'){
     // The approving checker must explicitly record the outbound condition.
     // Never rely on a disabled frontend button or infer it from Gate-in.
     conditionUponRelease=parseGateOutReleaseCondition(req.body?.conditionUponRelease);
     conditionRemarks=parseGateOutReleaseRemarks(req.body?.remarks);
     if(!Number.isFinite(Number(payment.amount))||Math.abs(Number(payment.amount)-Number(invoice.balance))>0.001)
      throw new AppError('Submitted amount does not match the outstanding invoice.',409);
     payment.receiptNumber=await uniqueReceiptNumber(session);
     payment.status='VERIFIED';
     invoice.status='PAID';invoice.paidAmount=invoice.total;invoice.balance=0;invoice.paidAt=new Date();invoice.verifiedBy=req.admin._id;
     booking.gateOut.approvalStatus='APPROVED';booking.gateOut.payment.status='VERIFIED';
     booking.gateOut.approvedAt=new Date();booking.gateOut.approvedBy=String(req.admin._id);
     booking.gateOut.conditionUponRelease=conditionUponRelease;
     booking.gateOut.conditionRemarks=conditionRemarks;
     booking.gateOut.conditionRecordedAt=booking.gateOut.approvedAt;
     booking.gateOut.conditionRecordedBy=String(req.admin._id);
     booking.gateOut.readyForReleaseAt=new Date();booking.inventory.status='RELEASE_PENDING';
     advanceWorkflow(booking,['GATE_OUT_APPROVED','READY_FOR_RELEASE'],{note:'Payment verified and gate-out approved'});
    }else{
     payment.status='REJECTED';payment.rejectionReason=reason;
     invoice.status='UNPAID';
     await releaseSlot(booking._id,booking.gateOut.scheduledDate,booking.gateOut.scheduledTime,session,'GATE_OUT');
     booking.gateOut.approvalStatus='REJECTED';booking.gateOut.payment.status='REJECTED';booking.gateOut.remarks=reason;
     advanceWorkflow(booking,'STORAGE',{note:`Gate-out rejected: ${reason}`});
    }
    payment.verifiedAt=new Date();payment.verifiedBy=req.admin._id;
    await payment.save({session});await invoice.save({session});await booking.save({session});
    await auditAdminAction({performedBy:req.admin._id,action:`GATE_OUT_${decision}`,
     changes:{bookingReference:booking.bookingReference,bookingId:String(booking._id),invoice:invoice.number,paymentId:String(payment._id),reason,
      ...(decision==='APPROVE'?{conditionUponRelease,conditionRemarks}:{})},session});
   });
   break;
  }catch(error){
   const keys=Object.keys(error?.keyPattern||error?.keyValue||{});
   if(error?.code===11000&&attempt<3&&(keys.includes('receiptNumber')||(keys.includes('type')&&keys.includes('day')))){
    console.warn('[GATE_OUT_RECEIPT_SEQUENCE_RETRY]',{bookingId:req.params.id,attempt:attempt+1});
    continue;
   }
   const translated=paymentReviewFailure(error);
   if(translated===error&&!error?.status)console.error('[GATE_OUT_PAYMENT_REVIEW_FAILED]',{bookingId:req.params.id,name:error?.name,code:error?.code,message:error?.message});
   throw translated;
  }finally{await session.endSession();}
 }
 if(alreadyReviewed)return res.json({success:true,message:`Gate-out payment was already ${decision==='APPROVE'?'verified':'rejected'}. No duplicate transaction was created.`,data:{paymentId:String(payment._id)}});

 // Side effects after commit may fail without reversing an approved payment or
 // misreporting it as a 500. They can be safely retried independently.
 try{
  await enqueueBookingMail(booking,{event:decision==='APPROVE'?'GATE_OUT_APPROVED':'GATE_OUT_REJECTED',
   title:decision==='APPROVE'?'Gate-out payment verified and approved':'Gate-out request rejected',
   message:decision==='APPROVE'?'Your gate-out payment has been verified and your container is approved for physical release.':`Your gate-out request was rejected: ${reason}. Please submit corrected payment details.`,
   invoiceNumber:invoice.number,amount:payment.amount});
 }catch(error){console.error('[GATE_OUT_NOTIFICATION_RETRY_NEEDED]',{paymentId:String(payment._id),message:error?.message});}
 try{
  clearSummaryCache();
  emitToAdminModule(MODULES.GATE_OUT,decision==='APPROVE'?'gate-out:approved':'gate-out:updated',{id:String(booking._id),bookingReference:booking.bookingReference});
  if(decision==='APPROVE')emitToAdminModule(MODULES.RELEASE_CONTAINER,'release:queue-updated',{id:String(booking._id),bookingReference:booking.bookingReference});
  emitToAdminModule(MODULES.PAYMENT_HISTORY,'invoice:updated',{bookingId:String(booking._id)});
  getIO()?.to(`company:${booking.company}`).emit('pre-advice:workflow-updated',{id:String(booking._id),workflowStage:booking.workflowStage,workflowHistory:booking.workflowHistory,gateOut:booking.gateOut,updatedAt:booking.updatedAt});
 }catch(error){console.error('[GATE_OUT_SOCKET_ERROR]',{paymentId:String(payment._id),message:error?.message});}
 await createNotification({
  company:booking.company,audience:'CLIENT',
  type:decision==='APPROVE'?'GATE_OUT_APPROVED':'GATE_OUT_REJECTED',
  title:decision==='APPROVE'?'Gate-out approved':'Gate-out requires attention',
  message:decision==='APPROVE'?'Your Gate-out payment was verified. Your container is ready for physical release.':`Gate-out request rejected: ${reason}`,
  data:{id:booking._id,bookingId:booking._id,bookingReference:booking.bookingReference},
 }).catch(error=>console.error('[GATE_OUT_CLIENT_ALERT_FAILED]',{bookingId:String(booking._id),message:error.message}));
 if(decision==='APPROVE')await createNotification({
  company:booking.company,audience:'ADMIN',module:MODULES.RELEASE_CONTAINER,
  type:'RELEASE_READY',title:'Container ready for release',
  message:`${booking.bookingReference} is approved and ready for physical release.`,
  data:{id:booking._id,bookingId:booking._id,bookingReference:booking.bookingReference},
 }).catch(error=>console.error('[RELEASE_READY_ALERT_FAILED]',{bookingId:String(booking._id),message:error.message}));
 try{getIO()?.to(`company:${booking.company}`).emit('invoice:updated',{bookingId:String(booking._id)});}
 catch(error){console.error('[GATE_OUT_INVOICE_EVENT_FAILED]',{bookingId:String(booking._id),message:error.message});}
 res.json({success:true,message:decision==='APPROVE'?'Payment verified and container approved for release.':'Request rejected. Client may resubmit payment details.',data:{paymentId:String(payment._id)}});
});

export const detailAdminGateOut=asyncHandler(async(req,res)=>{
 const booking=await PreAdvice.findById(req.params.id).populate('company','companyName').lean();
 if(!booking)throw new AppError('Booking not found.',404);
 const invoice=await Invoice.findOne({booking:booking._id,type:'GATE_OUT'}).lean();
 const payments=invoice?await PaymentSubmission.find({invoice:invoice._id}).sort({createdAt:-1}).lean():[];
 res.json({success:true,data:{booking,invoice,payments}});
});
export const adminGateOutProof=asyncHandler(async(req,res)=>{
 const payment=await PaymentSubmission.findById(req.params.paymentId).lean();
 const invoice=payment&&await Invoice.findOne({_id:payment.invoice,type:'GATE_OUT'}).lean();
 if(!invoice||!payment.proof?.storedName)throw new AppError('Gate-out payment proof not found.',404);
 const file=path.resolve('uploads/payment-proofs',path.basename(payment.proof.storedName));
 try{await fs.access(file)}catch{throw new AppError('Proof is missing from server storage.',404)}
 res.set('Cache-Control','private,no-store').type(payment.proof.mimeType).set('Content-Disposition','inline; filename="gate-out-proof"').sendFile(file);
});
export const adminGateOutPdf=asyncHandler(async(req,res)=>{
 const booking=await PreAdvice.findById(req.params.id).lean();
 if(!booking)throw new AppError('Booking not found.',404);
 const invoice=await Invoice.findOne({booking:booking._id,type:'GATE_OUT'}).lean();
 if(!invoice)throw new AppError('Gate-out invoice not found.',404);
 const receipt=req.path.endsWith('/receipt');
 const payment=receipt?await PaymentSubmission.findOne({invoice:invoice._id,status:'VERIFIED'}).lean():null;
 if(receipt&&!payment?.receiptNumber)throw new AppError('Receipt not yet verified.',409);
 const company=await ClientCompany.findById(booking.company).select('companyName').lean();
 const settings=receipt?null:await SiteSettings.findOne({key:'COMPANY_CONTACT'}).lean();
 const pdf=receipt?renderFinancialPdf({booking,invoice,companyName:company?.companyName,payment}):renderServiceInvoicePdf({booking,invoice,companyName:company?.companyName,settings});
 res.type('application/pdf').set('Cache-Control','private,no-store').set('Content-Disposition',`attachment; filename="${receipt?payment.receiptNumber:invoice.number}-${receipt?'receipt':'invoice'}.pdf"`).send(pdf);
});
