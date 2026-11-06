import mongoose from 'mongoose';
import Invoice from '../models/Invoice.js';
import PreAdvice from '../models/PreAdvice.js';
import {availableOptionalCharges,updateUnpaidInvoiceOptionalCharges,calculateInvoice} from '../services/invoicingService.js';
import PaymentSubmission from '../models/PaymentSubmission.js';
import {clearSummaryCache} from '../utils/summaryCache.js';
import {auditAdminAction} from '../services/adminAuditService.js';
import {enqueueBookingMail} from '../services/transactionalMail.js';
import {AppError,asyncHandler} from '../utils/http.js';
import {emitToAdminModule,getIO} from '../socket/index.js';
import {MODULES} from '../constants/permissions.js';

/** Gate-in optional charges are applied by an authorized admin before payment. */
export const getInvoiceOptionalCharges = asyncHandler(async(req,res)=>{
  const invoice=await Invoice.findOne({_id:req.params.id,type:'GATE_IN'}).lean();
  if(!invoice)throw new AppError('Gate-in invoice not found.',404);
  const booking=await PreAdvice.findById(invoice.booking).lean();
  if(!booking)throw new AppError('Booking not found.',404);
  const available=await availableOptionalCharges(booking,'GATE_IN');
  res.json({success:true,data:{invoice,available,selectedRateIds:(invoice.optionalRateIds||[]).map(String),editable:invoice.status==='UNPAID'}});
});
export const updateInvoiceOptionalCharges = asyncHandler(async(req,res)=>{
  const session=await mongoose.startSession();
  let updated,booking;
  try{
    await session.withTransaction(async()=>{
      updated=await Invoice.findOne({_id:req.params.id,type:'GATE_IN',status:'UNPAID'}).session(session);
      if(!updated)throw new AppError('Optional charges can only be edited before Gate-in payment is submitted.',409);
      booking=await PreAdvice.findById(updated.booking).session(session);
      if(!booking||!['READY_FOR_GATE_IN','GATE_IN_PAYMENT_SUBMITTED'].includes(booking.workflowStage))throw new AppError('Booking is no longer eligible for billing changes.',409);
      await updateUnpaidInvoiceOptionalCharges(updated,booking,req.body?.rateIds,session,req.body?.manualAmounts||{});
      await updated.save({session});
      booking.gateIn.payment.amountDue=updated.total;
      await booking.save({session});
      await enqueueBookingMail(booking,{event:'GATE_IN_INVOICE_UPDATED',title:'Gate-in invoice updated',message:'The terminal has updated the optional Gate-in charges. Please review the revised invoice before submitting payment proof.',invoiceNumber:updated.number,amount:updated.total},session);
    });
  }finally{await session.endSession();}
  await auditAdminAction({performedBy:req.admin._id,action:'GATE_IN_OPTIONAL_CHARGES_UPDATED',changes:{invoiceNumber:updated.number,bookingReference:booking.bookingReference,rateIds:(updated.optionalRateIds||[]).map(String),total:updated.total}});
  emitToAdminModule(MODULES.GATE_IN,'gate-in:updated',{id:String(booking._id),bookingReference:booking.bookingReference});
  getIO()?.to(`company:${booking.company}`).emit('invoice:updated',{id:String(updated._id),bookingId:String(booking._id),total:updated.total});
  res.json({success:true,message:'Optional charges updated and Gate-in invoice recalculated.',data:{invoice:updated}});
});

/**
 * Re-quote an existing UNPAID Gate-in invoice after Rate Setup changes.
 * This must be an explicit admin action; neither a client GET nor a socket
 * event is permitted to silently modify an issued financial document.
 * Already submitted/verified payments and physical arrivals are immutable.
 */
export const refreshUnpaidGateInInvoice = asyncHandler(async (req, res) => {
  const session = await mongoose.startSession();
  let invoice, booking, oldTotal;
  try {
    await session.withTransaction(async () => {
      invoice = await Invoice.findOne({_id:req.params.id,type:'GATE_IN',status:'UNPAID'}).session(session);
      if (!invoice) throw new AppError('Only an unpaid Gate-in invoice can be refreshed.',409);
      if (invoice.vatInclusive) throw new AppError('This historical VAT-inclusive invoice requires a formal billing adjustment. Its original tax treatment must be preserved.',409);
      booking = await PreAdvice.findById(invoice.booking).session(session);
      if (!booking || booking.gateIn?.actualGateInAt || !['READY_FOR_GATE_IN','GATE_IN_PAYMENT_SUBMITTED'].includes(booking.workflowStage))
        throw new AppError('Gate-in has already been processed or the booking is no longer eligible for re-pricing.',409);
      const activePayment = await PaymentSubmission.exists({invoice:invoice._id,status:{$in:['PENDING_VERIFICATION','VERIFIED']}}).session(session);
      if (activePayment || Number(invoice.paidAmount||0)>0) throw new AppError('Submitted or verified payment prevents invoice re-pricing.',409);
      // Explicitly discard the outdated Gate-in rate/settings snapshots for
      // this NEW quote. The original invoice is still available in audit logs.
      const freshBooking={...booking.toObject(),rateSnapshots:[],billingSettingsSnapshot:null};
      const quote=await calculateInvoice(freshBooking,'GATE_IN',{optionalRateIds:(invoice.optionalRateIds||[]).map(String)});
      const {rateSnapshots,billingSettingsSnapshot,...values}=quote;
      oldTotal=invoice.total;
      invoice.set({...values,status:'UNPAID',paidAmount:0,balance:quote.total});
      await invoice.save({session});
      booking.rateSnapshots=rateSnapshots;
      booking.billingSettingsSnapshot=billingSettingsSnapshot;
      booking.gateIn.payment.amountDue=invoice.total;
      await booking.save({session});
      await auditAdminAction({performedBy:req.admin._id,action:'GATE_IN_INVOICE_REPRICED',
        changes:{invoiceId:String(invoice._id),invoiceNumber:invoice.number,bookingReference:booking.bookingReference,
          oldTotal,newTotal:invoice.total,subtotal:invoice.subtotal,vat:invoice.vat,
          lines:invoice.lines.map(line=>({description:line.description,amount:line.amount,rateId:String(line.rateId||'')}))},session});
    });
  } finally { await session.endSession(); }
  clearSummaryCache();
  emitToAdminModule(MODULES.GATE_IN,'gate-in:updated',{id:String(booking._id),bookingReference:booking.bookingReference});
  emitToAdminModule(MODULES.PAYMENT_HISTORY,'invoice:updated',{id:String(invoice._id),bookingId:String(booking._id)});
  getIO()?.to(`company:${booking.company}`).emit('invoice:updated',{id:String(invoice._id),bookingId:String(booking._id),total:invoice.total});
  // Notification failures cannot roll back an already-committed financial change.
  try { await enqueueBookingMail(booking,{event:'GATE_IN_INVOICE_UPDATED',title:'Gate-in invoice updated',
    message:'Your unpaid Gate-in invoice has been recalculated using current configured transactions and VAT. Please review the new amount before paying.',
    invoiceNumber:invoice.number,amount:invoice.total}); }
  catch(error) {console.error('[GATE_IN_REPRICE_NOTIFICATION_FAILED]',{invoiceId:String(invoice._id),message:error.message});}
  res.json({success:true,message:'Unpaid Gate-in charges and VAT refreshed from Rate Setup.',data:{invoice,oldTotal}});
});
