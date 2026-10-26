import mongoose from 'mongoose';
import Invoice from '../models/Invoice.js';
import PreAdvice from '../models/PreAdvice.js';
import {availableOptionalCharges,updateUnpaidInvoiceOptionalCharges} from '../services/invoicingService.js';
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
      await updateUnpaidInvoiceOptionalCharges(updated,booking,req.body?.rateIds,session);
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
