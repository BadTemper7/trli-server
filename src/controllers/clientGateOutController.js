import mongoose from 'mongoose';
import fs from 'fs/promises';
import path from 'path';
import {renderFinancialPdf} from '../services/pdfDocuments.js';
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
import {nextReference} from '../utils/referenceNumbers.js';
import {auditAdminAction} from '../services/adminAuditService.js';
import {enqueueBookingMail} from '../services/transactionalMail.js';
import {createNotification} from '../services/notificationService.js';
import {validateUploadedProof,validatePaymentEvidence} from '../services/paymentProofValidation.js';
import {emitToAdminModule,getIO} from '../socket/index.js';
import {MODULES} from '../constants/permissions.js';

const stages=['GATE_OUT_REQUESTED','GATE_OUT_PAYMENT_SUBMITTED'];
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
  await validateSlot(day,hour);
  const method=String(req.body.method||'').toUpperCase(),reference=String(req.body.reference||'').trim();
  validatePaymentEvidence(reference,file);
  const receivingMethod = await getReceivingMethod(method);
  const booking=await PreAdvice.findOne({_id:req.params.id,company:req.user.company._id});
  if(!booking)throw new AppError('Booking not found.',404);
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
    fresh.gateOut.remarks='';fresh.gateOut.payment.status='SUBMITTED';fresh.gateOut.payment.amountDue=quote.total;fresh.gateOut.payment.amountSubmitted=amount;fresh.gateOut.payment.method=method;fresh.gateOut.payment.referenceNumber=reference;fresh.gateOut.payment.submittedAt=new Date();
    advanceWorkflow(fresh,stages,{note:'Gate-out request and online payment proof submitted; pending admin approval'});
    await fresh.save({session});
   });
   committed=true;
  }finally{await session.endSession();}
  await createNotification({company:booking.company,audience:'ADMIN',type:'GATE_OUT_REQUESTED',title:'Gate-out request ready for review',message:`${booking.bookingReference} submitted a gate-out request and payment proof.`,data:{id:booking._id}}).catch(console.error);
  emitToAdminModule(MODULES.GATE_OUT,'gate-out:updated',{id:String(booking._id),bookingReference:booking.bookingReference});
  getIO()?.to(`company:${booking.company}`).emit('pre-advice:workflow-updated',{id:String(booking._id),workflowStage:'GATE_OUT_PAYMENT_SUBMITTED'});
  res.json({success:true,message:'Gate-out request and payment submitted for verification.',data:{bookingId:booking._id}});
 }catch(e){if(!committed&&file?.path)await fs.unlink(file.path).catch(()=>{});throw e;}
});
export const reviewClientGateOut=asyncHandler(async(req,res)=>{
 const decision=String(req.body.decision||'').toUpperCase(),reason=String(req.body.reason||'').trim();
 if(!['APPROVE','REJECT'].includes(decision))throw new AppError('Decision must be APPROVE or REJECT.',400);
 if(decision==='REJECT'&&!reason)throw new AppError('Rejection reason is required.',400);
 const session=await mongoose.startSession();let releasedSlot=null;let bookingReference='';let notifyBooking=null;
 try{
  await session.withTransaction(async()=>{
   const booking=await PreAdvice.findById(req.params.id).session(session);
   if(!booking||booking.workflowStage!=='GATE_OUT_PAYMENT_SUBMITTED')throw new AppError('No gate-out payment is awaiting approval.',409);
   const invoice=await Invoice.findOne({booking:booking._id,type:'GATE_OUT',status:'PAYMENT_SUBMITTED'}).session(session);
   const payment=invoice&&await PaymentSubmission.findOne({invoice:invoice._id,status:'PENDING_VERIFICATION'}).session(session);
   if(!invoice||!payment)throw new AppError('No pending invoice/payment to verify.',409);
   bookingReference=booking.bookingReference;notifyBooking=booking;
   if(decision==='APPROVE'){
    if(Math.abs(payment.amount-invoice.balance)>0.001)throw new AppError('Submitted amount does not match the invoice.',409);
    payment.status='VERIFIED';payment.verifiedAt=new Date();payment.verifiedBy=req.admin._id;payment.receiptNumber=await nextReference('RECEIPT',new Date(),session);await payment.save({session});
    invoice.status='PAID';invoice.paidAmount=invoice.total;invoice.balance=0;invoice.paidAt=new Date();invoice.verifiedBy=req.admin._id;await invoice.save({session});
    booking.gateOut.approvalStatus='APPROVED';booking.gateOut.payment.status='VERIFIED';booking.gateOut.approvedAt=new Date();booking.gateOut.approvedBy=String(req.admin._id);booking.gateOut.readyForReleaseAt=new Date();booking.inventory.status='RELEASE_PENDING';
    advanceWorkflow(booking,['GATE_OUT_APPROVED','READY_FOR_RELEASE'],{note:'Payment verified and gate-out approved'});
   }else{
    payment.status='REJECTED';payment.verifiedAt=new Date();payment.verifiedBy=req.admin._id;payment.rejectionReason=reason;await payment.save({session});
    invoice.status='UNPAID';await invoice.save({session});
    await releaseSlot(booking._id,booking.gateOut.scheduledDate,booking.gateOut.scheduledTime,session,'GATE_OUT');
    booking.gateOut.approvalStatus='REJECTED';booking.gateOut.payment.status='REJECTED';booking.gateOut.remarks=reason;
    advanceWorkflow(booking,'STORAGE',{note:`Gate-out rejected: ${reason}`});
   }
   await booking.save({session});
   await enqueueBookingMail(booking,{event:decision==='APPROVE'?'GATE_OUT_APPROVED':'GATE_OUT_REJECTED',title:decision==='APPROVE'?'Gate-out payment verified and approved':'Gate-out request rejected',message:decision==='APPROVE'?'Your gate-out payment has been verified and your container is approved for physical release.':`Your gate-out request was rejected: ${reason}. Please submit corrected payment details.`,invoiceNumber:invoice.number,amount:payment.amount},session);
  });
 }finally{await session.endSession();}

 await auditAdminAction({performedBy:req.admin._id,action:`GATE_OUT_${decision}`,changes:{bookingReference,reason}});
 emitToAdminModule(MODULES.GATE_OUT,decision==='APPROVE'?'gate-out:approved':'gate-out:updated',{id:String(notifyBooking._id),bookingReference});
 if(decision==='APPROVE')emitToAdminModule(MODULES.RELEASE_CONTAINER,'release:queue-updated',{id:String(notifyBooking._id),bookingReference});
 getIO()?.to(`company:${notifyBooking.company}`).emit('pre-advice:workflow-updated',{id:String(notifyBooking._id),workflowStage:notifyBooking.workflowStage,workflowHistory:notifyBooking.workflowHistory,gateOut:notifyBooking.gateOut,updatedAt:notifyBooking.updatedAt});

 res.json({success:true,message:decision==='APPROVE'?'Payment verified and container approved for release.':'Request rejected. Client may resubmit payment details.'});
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
 const pdf=renderFinancialPdf({booking,invoice,companyName:company?.companyName,payment});
 res.type('application/pdf').set('Cache-Control','private,no-store').set('Content-Disposition',`attachment; filename="${receipt?payment.receiptNumber:invoice.number}-${receipt?'receipt':'invoice'}.pdf"`).send(pdf);
});
