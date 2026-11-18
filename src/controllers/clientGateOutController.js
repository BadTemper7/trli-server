import {sendStoredDocument} from '../utils/storedDocuments.js';
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
import { getPaymentChoice, receivingAccountSnapshot } from '../services/paymentMethods.js';
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
  const methodId=String(req.body.method||'').trim(),reference=String(req.body.reference||'').trim();
  const receivingMethod = await getPaymentChoice(methodId,{allowCash:true});
  const method=receivingMethod.code;
  const cash=method==='CASH';
  if(cash) {
    if(reference||file)throw new AppError('Cash is paid in person; do not attach online transfer evidence.',400);
  } else validatePaymentEvidence(reference,file);
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
    const invoiceStatus=cash?'UNPAID':'PAYMENT_SUBMITTED';
    if(invoice){Object.assign(invoice,quote,{status:invoiceStatus,paidAmount:0,balance:quote.total});await invoice.save({session});}
    else invoice=(await Invoice.create([{...quote,number:await nextReference('INVOICE',new Date(),session),booking:fresh._id,company:fresh.company,type:'GATE_OUT',status:invoiceStatus}],{session}))[0];
    if(!cash)await PaymentSubmission.create([{invoice:invoice._id,company:fresh.company,booking:fresh._id,method,paymentType:receivingMethod._id,reference,amount,receivingAccount:receivingAccountSnapshot(receivingMethod),proof:file?{storedName:file.filename,name:file.originalname,mimeType:file.mimetype,size:file.size}:undefined,submittedBy:req.user._id}],{session});
    fresh.gateOut.approvalStatus='PENDING_APPROVAL';fresh.gateOut.requestedAt=new Date();fresh.gateOut.requestedBy=String(req.user._id);fresh.gateOut.scheduledDate=day;fresh.gateOut.scheduledTime=hour;
    fresh.gateOut.truckPlateNumber=fresh.truckPlateNumber;fresh.gateOut.driverName=fresh.driverName;
    fresh.gateOut.remarks='';fresh.gateOut.conditionUponRelease=[];fresh.gateOut.conditionRemarks='';fresh.gateOut.conditionRecordedAt=null;fresh.gateOut.conditionRecordedBy=null;
    fresh.gateOut.payment.status=cash?'PENDING':'SUBMITTED';fresh.gateOut.payment.amountDue=quote.total;fresh.gateOut.payment.amountSubmitted=cash?0:amount;fresh.gateOut.payment.method=method;fresh.gateOut.payment.referenceNumber=reference;fresh.gateOut.payment.submittedAt=cash?null:new Date();
    advanceWorkflow(fresh,cash?['GATE_OUT_REQUESTED','GATE_OUT_PAYMENT_PENDING']:stages,{note:cash?'Cash selected; awaiting collection by cashier':'Gate-out request and online payment proof submitted; pending admin approval'});
    await fresh.save({session});
   });
   committed=true;
  }finally{await session.endSession();}
  await createNotification({company:booking.company,audience:'ADMIN',type:'GATE_OUT_REQUESTED',title:'Gate-out request ready for review',message:cash?`${booking.bookingReference} chose Cash for Gate-out. Collect and verify payment before approval.`:`${booking.bookingReference} submitted a gate-out request and payment proof.`,data:{id:booking._id,bookingId:booking._id,bookingReference:booking.bookingReference}}).catch(console.error);
  clearSummaryCache();
  emitToAdminModule(MODULES.GATE_OUT,'gate-out:updated',{id:String(booking._id),bookingReference:booking.bookingReference});
  emitToAdminModule(MODULES.PAYMENT_HISTORY,'invoice:updated',{bookingId:String(booking._id)});
  getIO()?.to(`company:${booking.company}`).emit('pre-advice:workflow-updated',{id:String(booking._id),workflowStage:cash?'GATE_OUT_PAYMENT_PENDING':'GATE_OUT_PAYMENT_SUBMITTED'});
  getIO()?.to(`company:${booking.company}`).emit('invoice:updated',{bookingId:String(booking._id)});
  res.json({success:true,message:cash?'Gate-out request sent. Pay Cash at the terminal cashier; no payment has been recorded yet.':'Gate-out request and payment submitted for verification.',data:{bookingId:booking._id,paymentMethod:method,paymentStatus:cash?'UNPAID':'PENDING_VERIFICATION'}});
 }catch(e){if(!committed&&file?.path)await fs.unlink(file.path).catch(()=>{});throw paymentReviewFailure(e,{reference:req.body?.reference});}
});
// Existing Gate-out payment screen: a client who first chose Cash may later
// submit verified bank/e-wallet evidence. The invoice remains unpaid until the
// authorized administrator verifies the submission.
// A client may change an unpaid, already scheduled Gate-out to Cash without
// creating a PaymentSubmission or falsely marking the invoice paid.
export const selectClientGateOutCash = asyncHandler(async(req,res)=>{
 const choice=await getPaymentChoice(req.body.paymentTypeId||req.body.method,{allowCash:true});
 if(choice.code!=='CASH')throw new AppError('Select Cash to pay at the terminal.',400);
 const booking=await PreAdvice.findOne({_id:req.params.id,company:req.user.company._id,workflowStage:'GATE_OUT_PAYMENT_PENDING'});
 if(!booking)throw new AppError('Only a Gate-out request awaiting payment can select Cash.',409);
 const invoice=await Invoice.findOne({booking:booking._id,company:booking.company,type:'GATE_OUT',status:{$in:['UNPAID','PARTIALLY_PAID']}});
 if(!invoice)throw new AppError('The Gate-out invoice is not available for a new cash selection.',409);
 if(await PaymentSubmission.exists({invoice:invoice._id,status:'PENDING_VERIFICATION'}))
  throw new AppError('Payment proof is under review. It must be reviewed before changing the payment method.',409);
 const changed=booking.gateOut.payment.method!=='CASH';
 if(changed){
  booking.gateOut.payment.method='CASH';booking.gateOut.payment.status='PENDING';
  booking.gateOut.payment.amountSubmitted=invoice.paidAmount||0;
  booking.gateOut.payment.referenceNumber='';booking.gateOut.payment.submittedAt=null;
  await booking.save();
  await createNotification({company:booking.company,audience:'ADMIN',type:'GATE_OUT_REQUESTED',
   title:'Cash selected for Gate-out',message:`${booking.bookingReference} will pay Cash at the terminal cashier.`,
   data:{id:booking._id,bookingId:booking._id,invoiceId:invoice._id}}).catch(console.error);
  emitToAdminModule(MODULES.GATE_OUT,'gate-out:updated',{id:String(booking._id)});
 }
 res.json({success:true,message:'Cash selected. Your Gate-out invoice remains unpaid until the cashier records the payment.',
  data:{bookingId:booking._id,method:'CASH',invoiceStatus:invoice.status,outstandingBalance:invoice.balance}});
});

export const submitPendingGateOutEvidence = asyncHandler(async(req,res)=>{
 const file=req.file;
 let committed=false;
 try {
  await validateUploadedProof(file);
  const reference=String(req.body.paymentReferenceNumber||req.body.reference||'').trim();
  validatePaymentEvidence(reference,file);
  const methodId=String(req.body.paymentTypeId||req.body.method||'').trim();
  const choice=await getPaymentChoice(methodId);
  const method=choice.code;
  if(reference&&await PaymentSubmission.exists({method,reference,status:{$in:['VERIFIED','PENDING_VERIFICATION']}}))
   throw new AppError('This reference has already been used for an active or verified payment.',409);
  const session=await mongoose.startSession();
  let booking,invoice,payment;
  try {
   await session.withTransaction(async()=>{
    booking=await PreAdvice.findOne({_id:req.params.id,company:req.user.company._id,workflowStage:'GATE_OUT_PAYMENT_PENDING'}).session(session);
    if(!booking)throw new AppError('Gate-out payment is not currently awaiting collection.',409);
    invoice=await Invoice.findOne({booking:booking._id,company:booking.company,type:'GATE_OUT',status:'UNPAID'}).session(session);
    if(!invoice||Number(invoice.balance)<=0)throw new AppError('The Gate-out invoice is not available for this payment.',409);
    if(await PaymentSubmission.exists({invoice:invoice._id,status:'PENDING_VERIFICATION'}).session(session))
     throw new AppError('Payment evidence has already been submitted for this invoice.',409);
    payment=(await PaymentSubmission.create([{
      invoice:invoice._id,company:booking.company,booking:booking._id,method,paymentType:choice._id,
      reference,amount:invoice.balance,receivingAccount:receivingAccountSnapshot(choice),
      proof:file?{storedName:file.filename,name:file.originalname,mimeType:file.mimetype,size:file.size}:undefined,
      submittedBy:req.user._id,status:'PENDING_VERIFICATION',
    }],{session}))[0];
    invoice.status='PAYMENT_SUBMITTED';await invoice.save({session});
    booking.gateOut.payment.status='SUBMITTED';booking.gateOut.payment.method=method;
    booking.gateOut.payment.amountSubmitted=invoice.balance;booking.gateOut.payment.referenceNumber=reference;
    booking.gateOut.payment.submittedAt=new Date();
    advanceWorkflow(booking,'GATE_OUT_PAYMENT_SUBMITTED',{note:'Gate-out transfer proof submitted; pending administrator verification'});
    await booking.save({session});
   });
   committed=true;
  } finally {await session.endSession();}
  await createNotification({company:booking.company,audience:'ADMIN',type:'GATE_OUT_REQUESTED',
    title:'Gate-out payment submitted for review',message:`${booking.bookingReference} submitted payment evidence.`,
    data:{id:booking._id,bookingId:booking._id,invoiceId:invoice._id,paymentId:payment._id}}).catch(console.error);
  clearSummaryCache();
  emitToAdminModule(MODULES.GATE_OUT,'gate-out:updated',{id:String(booking._id)});
  emitToAdminModule(MODULES.PAYMENT_HISTORY,'invoice:updated',{id:String(invoice._id)});
  getIO()?.to(`company:${booking.company}`).emit('invoice:updated',{id:String(invoice._id),bookingId:String(booking._id)});
  res.json({success:true,message:'Payment evidence submitted. Administrator verification is required.',data:{paymentId:payment._id,invoiceId:invoice._id}});
 }catch(error){if(!committed&&file?.path)await fs.unlink(file.path).catch(()=>{});throw paymentReviewFailure(error,{reference:req.body?.paymentReferenceNumber||req.body?.reference});}
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

    // A verified in-person payment is a distinct path from client evidence
    // review. No second receipt or payment record is created here.
    if(decision==='APPROVE'&&invoice.status==='PAID'&&invoice.balance===0&&
      booking.workflowStage==='GATE_OUT_PAYMENT_PENDING'&&!booking.gateOut?.approvedAt){
      payment=await PaymentSubmission.findOne({invoice:invoice._id,status:'VERIFIED'}).sort({createdAt:-1}).session(session);
      if(!payment)throw new AppError('A verified collected payment is required before Gate-out approval.',409);
      conditionUponRelease=parseGateOutReleaseCondition(req.body?.conditionUponRelease);
      conditionRemarks=parseGateOutReleaseRemarks(req.body?.remarks);
      booking.gateOut.approvalStatus='APPROVED';booking.gateOut.payment.status='VERIFIED';
      booking.gateOut.approvedAt=new Date();booking.gateOut.approvedBy=String(req.admin._id);
      booking.gateOut.conditionUponRelease=conditionUponRelease;
      booking.gateOut.conditionRemarks=conditionRemarks;
      booking.gateOut.conditionRecordedAt=booking.gateOut.approvedAt;
      booking.gateOut.conditionRecordedBy=String(req.admin._id);
      booking.gateOut.readyForReleaseAt=new Date();booking.inventory.status='RELEASE_PENDING';
      advanceWorkflow(booking,['GATE_OUT_APPROVED','READY_FOR_RELEASE'],{note:'Previously collected payment verified; Gate-out approved'});
      await booking.save({session});
      await auditAdminAction({performedBy:req.admin._id,action:'GATE_OUT_APPROVED_AFTER_ADMIN_PAYMENT',
        changes:{bookingReference:booking.bookingReference,bookingId:String(booking._id),invoice:invoice.number,
          conditionUponRelease,conditionRemarks,paymentId:String(payment._id)},session});
      return;
    }
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
 return sendStoredDocument(res, 'payment-proofs', payment.proof);
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
