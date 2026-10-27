import fs from 'fs/promises';
import path from 'path';
import mongoose from 'mongoose';
import Invoice from '../models/Invoice.js';
import PaymentSubmission from '../models/PaymentSubmission.js';
import {getReceivingMethod,receivingAccountSnapshot} from '../services/paymentMethods.js';
import PreAdvice from '../models/PreAdvice.js';
import { buildInvoice } from '../services/invoicingService.js';
import { nextReference } from '../utils/referenceNumbers.js';
import { AppError, asyncHandler } from '../utils/http.js';
import { auditAdminAction } from '../services/adminAuditService.js';
import { renderFinancialPdf } from '../services/pdfDocuments.js';
import { validateUploadedProof, validatePaymentEvidence } from '../services/paymentProofValidation.js';
import { enqueueBookingMail } from '../services/transactionalMail.js';
import { advanceWorkflow } from '../utils/preAdviceWorkflow.js';
import { emitToAdminModule, getIO } from '../socket/index.js';
import { MODULES } from '../constants/permissions.js';

const owner = (req) => req.user.company._id;
const filterFor = (req) => req.user ? { company: owner(req) } : {};

export const listClientInvoices = asyncHandler(async (req, res) => {
  const items = await Invoice.find({ company: owner(req) }).sort({createdAt:-1}).limit(300).lean();
  res.json({success:true,data:{items}});
});
export const listAdminInvoices = asyncHandler(async (req, res) => {
  const filter={};
  for(const name of ['status','type','company']) if(req.query[name])filter[name]=req.query[name];
  if(req.query.booking && mongoose.isValidObjectId(req.query.booking))filter.booking=req.query.booking;
  const items=await Invoice.find(filter).populate('company','companyName').sort({createdAt:-1}).limit(300).lean();
  res.json({success:true,data:{items}});
});
export const getClientInvoice = asyncHandler(async (req, res) => {
  const invoice=await Invoice.findOne({_id:req.params.id,company:owner(req)}).lean();
  if(!invoice)throw new AppError('Invoice not found.',404);
  const payments=await PaymentSubmission.find({invoice:invoice._id,company:owner(req)}).select('-proof.storedName').sort({createdAt:-1}).lean();
  res.json({success:true,data:{invoice,payments}});
});
export const getAdminInvoice = asyncHandler(async (req, res) => {
  const invoice=await Invoice.findById(req.params.id).lean();
  if(!invoice)throw new AppError('Invoice not found.',404);
  const payments=await PaymentSubmission.find({invoice:invoice._id}).sort({createdAt:-1}).lean();
  res.json({success:true,data:{invoice,payments}});
});
export const ensureClientInvoice = asyncHandler(async (req,res) => {
  const booking=await PreAdvice.findOne({_id:req.params.id,company:owner(req)});
  if(!booking)throw new AppError('Booking not found.',404);
  const type=String(req.body.type||'GATE_IN').toUpperCase();
  if(type!=='GATE_IN')throw new AppError('Gate-out invoices are created by the combined request and payment action.',409);
  if(!['READY_FOR_GATE_IN','GATE_IN_PAYMENT_SUBMITTED'].includes(booking.workflowStage))throw new AppError('Pre-advice approval is required.',409);
  const invoice=await buildInvoice(booking,'GATE_IN');
  res.json({success:true,data:{invoice}});
});

export const submitProof = asyncHandler(async (req,res) => {
  const proof=req.file;
  let committed=false;
  try{
    await validateUploadedProof(proof);
    const method=String(req.body.method||'').toUpperCase(),reference=String(req.body.reference||'').trim();
    validatePaymentEvidence(reference,proof);
    const receivingMethod = await getReceivingMethod(method);
    if (reference && await PaymentSubmission.exists({method,reference,status:{$in:['VERIFIED','PENDING_VERIFICATION']}})) {
      throw new AppError('This payment reference is already in use for an active or verified submission.',409);
    }
    const session=await mongoose.startSession();
    let payment,invoice;
    try{
      await session.withTransaction(async()=>{
        invoice=await Invoice.findOne({_id:req.params.id,company:owner(req),type:'GATE_IN',status:'UNPAID'}).session(session);
        if(!invoice)throw new AppError('Gate-in invoice is not available for payment.',409);
        const booking=await PreAdvice.findOne({_id:invoice.booking,company:owner(req)}).session(session);
        if(!booking||!['READY_FOR_GATE_IN','GATE_IN_PAYMENT_SUBMITTED'].includes(booking.workflowStage))throw new AppError('Booking is not eligible for gate-in payment.',409);
        const amount=Number(req.body.amount);
        if(!Number.isFinite(amount)||Math.abs(amount-invoice.total)>0.001)throw new AppError('Payment amount must match the invoice.',400);
        payment=(await PaymentSubmission.create([{
          invoice:invoice._id,company:invoice.company,booking:invoice.booking,method,reference,amount,receivingAccount:receivingAccountSnapshot(receivingMethod),
          proof:proof?{storedName:proof.filename,name:proof.originalname,mimeType:proof.mimetype,size:proof.size}:undefined,submittedBy:req.user._id,
          status:'PENDING_VERIFICATION',
        }],{session}))[0];
        invoice.status='PAYMENT_SUBMITTED';await invoice.save({session});
        booking.gateIn.payment.status='SUBMITTED';booking.gateIn.payment.amountDue=invoice.total;
        booking.gateIn.payment.amountSubmitted=amount;booking.gateIn.payment.method=method;
        booking.gateIn.payment.referenceNumber=reference;booking.gateIn.payment.submittedAt=new Date();
        advanceWorkflow(booking,'GATE_IN_PAYMENT_SUBMITTED',{note:'Online gate-in payment evidence submitted for verification'});
        await booking.save({session});
      });
      committed=true;
    }finally{await session.endSession();}
    res.json({success:true,message:'Payment evidence submitted; administrator verification is required.',data:{paymentId:payment._id,invoice}});
  }catch(e){if(!committed&&proof?.path)await fs.unlink(proof.path).catch(()=>{});throw e;}
});

export const reviewPayment = asyncHandler(async (req,res) => {
  const decision=String(req.body.decision||'').toUpperCase(),reason=String(req.body.reason||'').trim().slice(0,800);
  if(!['APPROVE','REJECT'].includes(decision))throw new AppError('Decision must be APPROVE or REJECT.',400);
  if(decision==='REJECT'&&!reason)throw new AppError('Rejection reason is required.',400);
  const session=await mongoose.startSession();
  let payment,invoice,booking;
  try{
    await session.withTransaction(async()=>{
      payment=await PaymentSubmission.findOne({_id:req.params.id,status:'PENDING_VERIFICATION'}).session(session);
      if(!payment)throw new AppError('Payment is not awaiting review.',409);
      invoice=await Invoice.findOne({_id:payment.invoice,status:'PAYMENT_SUBMITTED',type:'GATE_IN'}).session(session);
      if(!invoice)throw new AppError('Gate-in invoice is not awaiting review.',409);
      booking=await PreAdvice.findById(payment.booking).session(session);
      if(!booking||!['READY_FOR_GATE_IN','GATE_IN_PAYMENT_SUBMITTED'].includes(booking.workflowStage))throw new AppError('Booking is not waiting for payment approval.',409);
      if(decision==='APPROVE'){
        if(Math.abs(payment.amount-invoice.total)>0.001)throw new AppError('Payment does not match total payable.',409);
        payment.status='VERIFIED';payment.receiptNumber=await nextReference('RECEIPT',new Date(),session);
        invoice.status='PAID';invoice.paidAmount=invoice.total;invoice.balance=0;invoice.paidAt=new Date();invoice.verifiedBy=req.admin._id;
        booking.gateIn.payment.status='VERIFIED';
      }else{
        payment.status='REJECTED';payment.rejectionReason=reason;
        invoice.status='UNPAID';booking.gateIn.payment.status='REJECTED';
      }
      payment.verifiedBy=req.admin._id;payment.verifiedAt=new Date();
      await payment.save({session});await invoice.save({session});await booking.save({session});
      await enqueueBookingMail(booking,{
        event:decision==='APPROVE'?'GATE_IN_PAYMENT_APPROVED':'GATE_IN_PAYMENT_REJECTED',
        title:decision==='APPROVE'?'Gate-in payment verified':'Gate-in payment rejected',
        message:decision==='APPROVE'?'Your online gate-in payment was verified. Your container can proceed to gate-in inspection and entry.':`Your gate-in payment proof was rejected: ${reason}. Please submit a new proof.`,
        invoiceNumber:invoice.number,amount:payment.amount,
      },session);
    });
  }finally{await session.endSession();}
  await auditAdminAction({performedBy:req.admin._id,action:decision==='APPROVE'?'PAYMENT_VERIFIED':'PAYMENT_REJECTED',changes:{invoice:invoice.number,reference:payment.reference,reason}});
  emitToAdminModule(MODULES.GATE_IN,'gate-in:updated',{id:String(booking._id),bookingReference:booking.bookingReference});
  getIO()?.to(`company:${booking.company}`).emit('pre-advice:workflow-updated',{id:String(booking._id),workflowStage:booking.workflowStage,workflowHistory:booking.workflowHistory,gateIn:booking.gateIn,updatedAt:booking.updatedAt});
  res.json({success:true,message:decision==='APPROVE'?'Gate-in payment verified.':'Payment rejected; client may submit replacement proof.',data:{payment}});
});
export const listPendingPayments = asyncHandler(async (req,res) => {
  // Gate-in owns verification. Allow the drawer to request only its booking so
  // the payment isn't hidden behind the general queue's 300-row limit.
  const filter={status:'PENDING_VERIFICATION'};
  if (req.query.booking) {
    if (!mongoose.isValidObjectId(req.query.booking)) throw new AppError('Invalid booking identifier.',400);
    filter.booking=req.query.booking;
  }
  const invoices=await Invoice.find({type:'GATE_IN',status:'PAYMENT_SUBMITTED'}).distinct('_id');
  filter.invoice={$in:invoices};
  const items=await PaymentSubmission.find(filter)
    .populate('invoice','number type total')
    .populate('company','companyName')
    .sort({createdAt:1}).limit(300).lean();
  res.json({success:true,data:{items}});
});
export const proofFile = asyncHandler(async (req,res) => {
  const payment=await PaymentSubmission.findOne({_id:req.params.id,...filterFor(req)}).lean();
  if(!payment?.proof?.storedName)throw new AppError('Payment proof not found.',404);
  const full=path.resolve('uploads/payment-proofs',path.basename(payment.proof.storedName));
  try{await fs.access(full);}catch{throw new AppError('Proof file is missing from server storage.',404);}
  res.set('Cache-Control','private, no-store');
  res.type(payment.proof.mimeType).set('Content-Disposition','inline; filename="payment-proof"').sendFile(full);
});
export const downloadFinancialPdf = asyncHandler(async (req,res) => {
  const invoice=await Invoice.findOne({_id:req.params.id,...filterFor(req)}).lean();
  if(!invoice)throw new AppError('Invoice not found.',404);
  const receipt=req.path.endsWith('/receipt');
  const payment=receipt?await PaymentSubmission.findOne({invoice:invoice._id,status:'VERIFIED'}).lean():null;
  if(receipt&&!payment?.receiptNumber)throw new AppError('Verified receipt is not yet available.',409);
  const booking=await PreAdvice.findById(invoice.booking).select('bookingReference containerNumber').lean();
  const ClientCompany=(await import('../models/ClientCompany.js')).default;
  const company=await ClientCompany.findById(invoice.company).select('companyName').lean();
  const pdf=renderFinancialPdf({invoice,booking,companyName:company?.companyName,payment});
  res.type('application/pdf').set('Cache-Control','private,no-store')
    .set('Content-Disposition',`attachment; filename="${receipt?payment.receiptNumber:invoice.number}-${receipt?'receipt':'invoice'}.pdf"`)
    .send(pdf);
});
