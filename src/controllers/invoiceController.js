import fs from 'fs/promises';
import path from 'path';
import mongoose from 'mongoose';
import Invoice from '../models/Invoice.js';
import { buildInvoiceFilter } from '../services/tableFilters.js';
import { getInvoiceSummary } from '../services/tableSummaries.js';
import { listDocuments } from '../utils/tableQuery.js';
import { clearSummaryCache } from '../utils/summaryCache.js';
import PaymentSubmission from '../models/PaymentSubmission.js';
import {getReceivingMethod,receivingAccountSnapshot} from '../services/paymentMethods.js';
import PreAdvice from '../models/PreAdvice.js';
import { buildInvoice } from '../services/invoicingService.js';
import { uniqueReceiptNumber } from '../utils/uniqueReceipt.js';
import { AppError, asyncHandler } from '../utils/http.js';
import { auditAdminAction } from '../services/adminAuditService.js';
import { renderFinancialPdf } from '../services/pdfDocuments.js';
import { renderServiceInvoicePdf } from '../services/printableDocuments.js';
import SiteSettings from '../models/SiteSettings.js';
import { validateUploadedProof, validatePaymentEvidence } from '../services/paymentProofValidation.js';
import { enqueueBookingMail } from '../services/transactionalMail.js';
import { advanceWorkflow } from '../utils/preAdviceWorkflow.js';
import { emitToAdminModule, getIO } from '../socket/index.js';
import { MODULES } from '../constants/permissions.js';
import {paymentReviewFailure} from '../utils/financialReviewErrors.js';
import { createNotification } from '../services/notificationService.js';

const owner = (req) => req.user.company._id;
const filterFor = (req) => req.user ? { company: owner(req) } : {};

const INVOICE_LIST_FIELDS = 'number booking company type status subtotal vat total paidAmount balance vatRate vatInclusive vatableSales nonVatableSales createdAt updatedAt';
const INVOICE_LIST_SORTS = ['createdAt', 'updatedAt', 'number', 'status', 'total'];
async function sendInvoiceList(req, res, company = null) {
  const filter = buildInvoiceFilter(req.query, { company });
  const { items, pagination } = await listDocuments(Invoice, filter, req.query, {
    defaultLimit: 20, maxLimit: 100, sorts: INVOICE_LIST_SORTS, select: INVOICE_LIST_FIELDS,
    ...(company ? {} : { populate: { path: 'company', select: 'companyName' } }),
  });
  res.json({ success: true, items, total: pagination.total ?? null, page: pagination.page,
    limit: pagination.limit, pages: pagination.pages ?? null, nextCursor: pagination.nextCursor ?? null,
    hasMore: pagination.hasMore ?? (pagination.page < pagination.totalPages),
    data: { items, pagination } });
}
export const listClientInvoices = asyncHandler(async (req, res) => sendInvoiceList(req, res, owner(req)));
export const listAdminInvoices = asyncHandler(async (req, res) => sendInvoiceList(req, res));
export const clientInvoiceSummary = asyncHandler(async (req, res) => {
  const { scope, summary } = await getInvoiceSummary(req.query, owner(req));
  res.json({ success: true, data: { ...summary, scope, summary } });
});
export const adminInvoiceSummary = asyncHandler(async (req, res) => {
  const { scope, summary } = await getInvoiceSummary(req.query);
  res.json({ success: true, data: { ...summary, scope, summary } });
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
    let payment,invoice,bookingReference;
    try{
      await session.withTransaction(async()=>{
        invoice=await Invoice.findOne({_id:req.params.id,company:owner(req),type:'GATE_IN',status:'UNPAID'}).session(session);
        if(!invoice)throw new AppError('Gate-in invoice is not available for payment.',409);
        const booking=await PreAdvice.findOne({_id:invoice.booking,company:owner(req)}).session(session);
        if(!booking||!['READY_FOR_GATE_IN','GATE_IN_PAYMENT_SUBMITTED'].includes(booking.workflowStage))throw new AppError('Booking is not eligible for gate-in payment.',409);
        bookingReference=booking.bookingReference;
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
    // Never re-run a committed payment operation if an alert cannot be sent.
    try {
      await createNotification({
        company: invoice.company, audience: 'ADMIN', type: 'GATE_IN_PAYMENT_SUBMITTED',
        title: 'Gate-in payment awaiting verification',
        message: `Payment proof was submitted for ${bookingReference || invoice.number}.`,
        data: { id: invoice.booking, bookingId: invoice.booking, bookingReference, invoiceId: invoice._id, paymentId: payment._id },
      });
      clearSummaryCache();
      emitToAdminModule(MODULES.GATE_IN, 'gate-in:updated', {id:String(invoice.booking)});
      emitToAdminModule(MODULES.PAYMENT_HISTORY, 'invoice:updated', {id:String(invoice._id),bookingId:String(invoice.booking)});
      getIO()?.to(`company:${invoice.company}`).emit('invoice:updated', {id:String(invoice._id),bookingId:String(invoice.booking)});
      getIO()?.to(`company:${invoice.company}`).emit('pre-advice:workflow-updated', {id:String(invoice.booking),workflowStage:'GATE_IN_PAYMENT_SUBMITTED'});
    } catch (error) {console.error('[GATE_IN_PAYMENT_ALERT_FAILED]', {paymentId:String(payment._id),message:error.message});}
    res.json({success:true,message:'Payment evidence submitted; administrator verification is required.',data:{paymentId:payment._id,invoice}});
  }catch(e){if(!committed&&proof?.path)await fs.unlink(proof.path).catch(()=>{});throw paymentReviewFailure(e,{reference:req.body?.reference});}
});

export const reviewPayment = asyncHandler(async (req,res) => {
  const decision=String(req.body.decision||'').toUpperCase(),reason=String(req.body.reason||'').trim().slice(0,800);
  if(!['APPROVE','REJECT'].includes(decision))throw new AppError('Decision must be APPROVE or REJECT.',400);
  if(decision==='REJECT'&&!reason)throw new AppError('Rejection reason is required.',400);
  if(!mongoose.isValidObjectId(req.params.id))throw new AppError('Invalid payment identifier.',400);
  let payment,invoice,booking,alreadyReviewed=false;
  for(let attempt=0;attempt<4;attempt++) {
    payment=null;invoice=null;booking=null;alreadyReviewed=false;
    const session=await mongoose.startSession();
    try {
      await session.withTransaction(async()=>{
      payment=await PaymentSubmission.findOne({_id:req.params.id,status:'PENDING_VERIFICATION'}).session(session);
      if(!payment) {
        const existing=await PaymentSubmission.findById(req.params.id).session(session);
        if(existing?.status==='VERIFIED' && decision==='APPROVE') { alreadyReviewed=true; payment=existing; invoice=await Invoice.findById(existing.invoice).session(session); booking=await PreAdvice.findById(existing.booking).session(session); return; }
        if(existing?.status==='REJECTED' && decision==='REJECT') { alreadyReviewed=true; payment=existing; invoice=await Invoice.findById(existing.invoice).session(session); booking=await PreAdvice.findById(existing.booking).session(session); return; }
        throw new AppError(existing?.status==='VERIFIED'?'This payment has already been verified. Refresh the Gate-in drawer.':
          existing?.status==='REJECTED'?'This payment has already been rejected. Refresh the Gate-in drawer.':'Payment is not awaiting verification.',409);
      }
      invoice=await Invoice.findOne({_id:payment.invoice,status:'PAYMENT_SUBMITTED',type:'GATE_IN'}).session(session);
      if(!invoice)throw new AppError('Gate-in invoice is not awaiting verification. Refresh the booking.',409);
      booking=await PreAdvice.findById(payment.booking).session(session);
      if(!booking||!['READY_FOR_GATE_IN','GATE_IN_PAYMENT_SUBMITTED'].includes(booking.workflowStage))throw new AppError('Booking is no longer waiting for Gate-in payment verification.',409);
      if(!booking.gateIn?.payment)throw new AppError('Booking does not have a Gate-in payment state. Contact technical support.',409);
      if(decision==='APPROVE') {
        if(!Number.isFinite(Number(payment.amount)) || Math.abs(Number(payment.amount)-Number(invoice.total))>0.001)throw new AppError('Payment amount does not match the invoice total.',409);
        payment.receiptNumber=await uniqueReceiptNumber(session);
        payment.status='VERIFIED';
        invoice.status='PAID';invoice.paidAmount=invoice.total;invoice.balance=0;invoice.paidAt=new Date();invoice.verifiedBy=req.admin._id;
        booking.gateIn.payment.status='VERIFIED';
      } else {
        payment.status='REJECTED';payment.rejectionReason=reason;
        invoice.status='UNPAID';booking.gateIn.payment.status='REJECTED';
      }
      payment.verifiedBy=req.admin._id;payment.verifiedAt=new Date();
      await payment.save({session});await invoice.save({session});await booking.save({session});
      // Audit lives in the SAME commit. An audit failure cannot turn an already
      // verified payment into an HTTP 500 or leave an untracked approval.
      await auditAdminAction({performedBy:req.admin._id,action:decision==='APPROVE'?'PAYMENT_VERIFIED':'PAYMENT_REJECTED',
        changes:{invoice:invoice.number,paymentId:String(payment._id),reference:payment.reference,reason},session});
    });
      break;
    } catch (error) {
      const key=Object.keys(error?.keyPattern||error?.keyValue||{});
      if(error?.code===11000 && attempt<3 && (key.includes('receiptNumber')||(key.includes('type')&&key.includes('day')))) {
        console.warn('[RECEIPT_SEQUENCE_RETRY]',{paymentId:String(req.params.id),attempt:attempt+1,index:error?.index});
        continue;
      }
    if(error?.code===11000)console.error('[PAYMENT_REVIEW_UNIQUE_CONFLICT]',{paymentId:String(req.params.id),index:error?.index,keyPattern:error?.keyPattern,code:error.code});
    const translated=paymentReviewFailure(error,{reference:payment?.reference});
    if (translated===error && !error?.status) console.error('[GATE_IN_PAYMENT_REVIEW_FAILED]',{
      paymentId:String(req.params.id),errorName:error?.name,errorCode:error?.code,message:error?.message,
    });
    throw translated;
    } finally { await session.endSession(); }
  }

  if(alreadyReviewed) return res.json({success:true,message:`Payment was already ${decision==='APPROVE'?'verified':'rejected'}. No duplicate financial transaction was created.`,data:{payment}});
  // Notifications must not change the result of a COMMITTED financial action.
  try {
    await enqueueBookingMail(booking,{
      event:decision==='APPROVE'?'GATE_IN_PAYMENT_APPROVED':'GATE_IN_PAYMENT_REJECTED',
      title:decision==='APPROVE'?'Gate-in payment verified':'Gate-in payment rejected',
      message:decision==='APPROVE'?'Your online Gate-in payment has been verified. Await terminal inspection and physical Gate-in.':`Your Gate-in payment was rejected: ${reason}. Submit corrected evidence.`,
      invoiceNumber:invoice.number,amount:payment.amount,
    });
  } catch(error) { console.error('[GATE_IN_PAYMENT_NOTIFICATION_RETRY_NEEDED]',{paymentId:String(payment._id),message:error.message}); }
  await createNotification({
    company: booking.company, audience: 'CLIENT',
    type: decision==='APPROVE'?'GATE_IN_PAYMENT_APPROVED':'GATE_IN_PAYMENT_REJECTED',
    title: decision==='APPROVE'?'Gate-in payment verified':'Gate-in payment rejected',
    message: decision==='APPROVE'?'Your Gate-in payment was verified. Await terminal inspection.':`Gate-in payment rejected: ${reason}`,
    data: {id:booking._id,bookingId:booking._id,invoiceId:invoice._id},
  }).catch(error=>console.error('[GATE_IN_CLIENT_ALERT_FAILED]',{paymentId:String(payment._id),message:error.message}));
  try {
    clearSummaryCache();
    emitToAdminModule(MODULES.GATE_IN,'gate-in:updated',{id:String(booking._id),bookingReference:booking.bookingReference});
    getIO()?.to(`company:${booking.company}`).emit('pre-advice:workflow-updated',{
      id:String(booking._id),workflowStage:booking.workflowStage,workflowHistory:booking.workflowHistory,gateIn:booking.gateIn,updatedAt:booking.updatedAt,
    });
    getIO()?.to(`company:${booking.company}`).emit('invoice:updated',{bookingId:String(booking._id),id:String(invoice._id)});
    emitToAdminModule(MODULES.PAYMENT_HISTORY,'invoice:updated',{bookingId:String(booking._id),id:String(invoice._id)});
  } catch(error) {console.error('[GATE_IN_PAYMENT_SOCKET_ERROR]',{paymentId:String(payment._id),message:error.message});}
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
  const settings=receipt?null:await SiteSettings.findOne({key:'COMPANY_CONTACT'}).lean();
  const pdf=receipt?renderFinancialPdf({invoice,booking,companyName:company?.companyName,payment}):renderServiceInvoicePdf({invoice,booking,companyName:company?.companyName,settings});
  res.type('application/pdf').set('Cache-Control','private,no-store')
    .set('Content-Disposition',`attachment; filename="${receipt?payment.receiptNumber:invoice.number}-${receipt?'receipt':'invoice'}.pdf"`)
    .send(pdf);
});
