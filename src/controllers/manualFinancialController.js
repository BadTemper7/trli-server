import mongoose from 'mongoose';
import Invoice from '../models/Invoice.js';
import PreAdvice from '../models/PreAdvice.js';
import PaymentSubmission from '../models/PaymentSubmission.js';
import ManualFinancialEntry from '../models/ManualFinancialEntry.js';
import { hasPermission } from '../middleware/requirePermission.js';
import { MODULES, ACTIONS } from '../constants/permissions.js';
import { AppError, asyncHandler } from '../utils/http.js';
import { manualChargeInput, recordedPaymentInput, updatedInvoiceForCharge, updatedInvoiceForPayment } from '../utils/manualFinancialMath.js';
import { uniqueReceiptNumber } from '../utils/uniqueReceipt.js';
import { auditAdminAction } from '../services/adminAuditService.js';
import { clearSummaryCache } from '../utils/summaryCache.js';
import { emitToAdminModule, getIO } from '../socket/index.js';
import { createNotification } from '../services/notificationService.js';

const stagePermission = type => type === 'GATE_OUT' ? MODULES.GATE_OUT : MODULES.GATE_IN;
function validateDate(value) {
  const date = value ? new Date(value) : new Date();
  if (!Number.isFinite(date.getTime()) || date > new Date(Date.now() + 60_000)) throw new AppError('Transaction date must be a valid date and cannot be in the future.',400);
  return date;
}
function requiredRequestKey(value) {
  const key = String(value||'').trim();
  if (!/^[\w-]{12,100}$/.test(key)) throw new AppError('A unique requestKey (12–100 letters, numbers, underscores or hyphens) is required to prevent duplicate transactions.',400);
  return key;
}
function prepareEntry(body, kind) {
  const requestKey=requiredRequestKey(body.requestKey);
  const transactionDate=validateDate(body.transactionDate);
  const remarks=String(body.remarks||'').trim().slice(0,800);
  try {
    return {kind,requestKey,transactionDate,remarks,
      ...(kind==='CHARGE'?manualChargeInput(body):recordedPaymentInput(body))};
  } catch(error) {throw new AppError(error.message,400);}
}
async function requireAdminStage(req, invoice) {
  if (!hasPermission(req.admin,stagePermission(invoice.type),ACTIONS.PROCESS)) throw new AppError('You do not have permission to change this billing stage.',403);
  if (['CANCELLED','VOID','PAID','PAYMENT_SUBMITTED'].includes(invoice.status)) throw new AppError('Issued, verified, void or submitted payments cannot be repriced. Create a separately approved adjustment instead.',409);
  if (!['UNPAID','PARTIALLY_PAID'].includes(invoice.status)) throw new AppError('The selected invoice cannot accept manual transactions.',409);
}
export const manualTransactionHistory = asyncHandler(async(req,res) => {
  const invoice=await Invoice.findById(req.params.id).lean();
  if(!invoice)throw new AppError('Invoice not found.',404);
  if(!hasPermission(req.admin,stagePermission(invoice.type),ACTIONS.VIEW)&&!hasPermission(req.admin,MODULES.PAYMENT_HISTORY,ACTIONS.VIEW))throw new AppError('Invoice access is required.',403);
  const [entries,payments]=await Promise.all([
    ManualFinancialEntry.find({invoice:invoice._id}).populate('recordedBy','name username').sort({createdAt:-1}).lean(),
    PaymentSubmission.find({invoice:invoice._id}).sort({createdAt:-1}).lean(),
  ]);
  res.json({success:true,data:{invoice,entries,payments}});
});
export const addManualFinancialTransaction = asyncHandler(async(req,res) => {
  if(!mongoose.isValidObjectId(req.params.id))throw new AppError('Invalid invoice identifier.',400);
  const kind=String(req.body.kind||'').toUpperCase();
  if(!['CHARGE','PAYMENT'].includes(kind))throw new AppError('Choose CHARGE or PAYMENT.',400);
  const input=prepareEntry(req.body,kind);
  let entry,invoice,duplicate=false;
  const session=await mongoose.startSession();
  try {
    await session.withTransaction(async()=>{
      invoice=await Invoice.findById(req.params.id).session(session);
      if(!invoice)throw new AppError('Invoice not found.',404);
      await requireAdminStage(req,invoice);
      entry=await ManualFinancialEntry.findOne({invoice:invoice._id,requestKey:input.requestKey}).session(session);
      if(entry) {duplicate=true;return;}
      const beforeFinancial={total:invoice.total,vat:invoice.vat,paidAmount:invoice.paidAmount,balance:invoice.balance,status:invoice.status};
      const booking=await PreAdvice.findById(invoice.booking).session(session);
      if(!booking)throw new AppError('Booking not found.',404);
      if(booking.gateOut?.releasedAt)throw new AppError('Cannot post financial transactions after physical release.',409);
      if(invoice.type==='GATE_IN'&&booking.gateIn?.actualGateInAt)throw new AppError('Gate-in charges are frozen after physical entry.',409);
      const id=new mongoose.Types.ObjectId();
      const common={_id:id,invoice:invoice._id,booking:invoice.booking,company:invoice.company,
        kind:input.kind,requestKey:input.requestKey,transactionDate:input.transactionDate,remarks:input.remarks,recordedBy:req.admin._id};
      let document;
      if(kind==='CHARGE') {
        const line={description:input.description,quantity:input.quantity,unitRate:input.amount,
          amount:Math.round(input.amount*input.quantity*100)/100,
          fullAmount:Math.round(input.amount*input.quantity*100)/100,
          taxTreatment:input.taxTreatment,isOptional:false,isManual:true,manualTransactionId:id,
          chargeType:input.chargeType,recordedBy:req.admin._id,recordedAt:input.transactionDate,
          remarks:input.remarks,collectionPoint:invoice.type,pricingMode:'MANUAL'};
        Object.assign(invoice,updatedInvoiceForCharge(invoice,line));
        document={...common,transactionType:input.chargeType,description:input.description,
          quantity:input.quantity,amount:line.amount,taxTreatment:input.taxTreatment};
      } else {
        try {Object.assign(invoice,updatedInvoiceForPayment(invoice,input.amount));}
        catch(error){throw new AppError(error.message,409);}
        const payment=(await PaymentSubmission.create([{
          invoice:invoice._id,booking:invoice.booking,company:invoice.company,source:'ADMIN',
          recordedBy:req.admin._id,verifiedBy:req.admin._id,verifiedAt:new Date(),transactionDate:input.transactionDate,
          remarks:input.remarks,method:input.method,reference:input.reference,amount:input.amount,
          status:'VERIFIED',receiptNumber:await uniqueReceiptNumber(session),
        }],{session}))[0];
        document={...common,description:'Received payment',amount:input.amount,method:input.method,
          reference:input.reference,payment:payment._id};
        if(invoice.status==='PAID'){invoice.paidAt=new Date();invoice.verifiedBy=req.admin._id;}
        const paymentState=invoice.type==='GATE_IN'?booking.gateIn.payment:booking.gateOut.payment;
        paymentState.amountDue=invoice.total;
        paymentState.amountSubmitted=invoice.paidAmount;
        paymentState.status=invoice.status==='PAID'?'VERIFIED':'SUBMITTED';
        paymentState.method=input.method;paymentState.referenceNumber=input.reference;
        paymentState.submittedAt=input.transactionDate;
      }
      entry=(await ManualFinancialEntry.create([document],{session}))[0];
      await invoice.save({session});
      await booking.save({session});
      await auditAdminAction({performedBy:req.admin._id,action:kind==='CHARGE'?'MANUAL_INVOICE_CHARGE_ADDED':'MANUAL_INVOICE_PAYMENT_RECEIVED',
        changes:{invoice:invoice.number,invoiceId:String(invoice._id),entryId:String(id),kind,
          amount:document.amount,description:document.description,transactionType:document.transactionType,method:document.method,
          taxTreatment:document.taxTreatment,reference:document.reference,requestKey:input.requestKey,remarks:input.remarks,
          before:beforeFinancial,after:{total:invoice.total,vat:invoice.vat,paidAmount:invoice.paidAmount,balance:invoice.balance,status:invoice.status}},session});
    });
  } catch(error) {
    if(error?.code===11000) {
      const found=await ManualFinancialEntry.findOne({invoice:req.params.id,requestKey:input.requestKey}).lean();
      if(found){entry=found;duplicate=true;invoice=await Invoice.findById(req.params.id).lean();}
      else if(input.reference)throw new AppError('The payment reference is already linked to another active or verified payment.',409);
      else throw new AppError('Concurrent financial update detected. Refresh and retry.',409);
    } else throw error;
  } finally {await session.endSession();}
  if(!duplicate){
    clearSummaryCache();
    emitToAdminModule(MODULES.PAYMENT_HISTORY,'invoice:updated',{id:String(invoice._id),bookingId:String(invoice.booking)});
    emitToAdminModule(stagePermission(invoice.type),invoice.type==='GATE_IN'?'gate-in:updated':'gate-out:updated',{id:String(invoice.booking)});
    getIO()?.to(`company:${invoice.company}`).emit('invoice:updated',{id:String(invoice._id),bookingId:String(invoice.booking)});
    await createNotification({company:invoice.company,audience:'CLIENT',type:kind==='CHARGE'?'INVOICE_CHARGE_ADDED':'PAYMENT_RECORDED',
      title:kind==='CHARGE'?'Invoice charge added':'Payment received',message:kind==='CHARGE'?`A new charge was added to invoice ${invoice.number}.`:`A payment was recorded for invoice ${invoice.number}.`,
      data:{id:invoice.booking,bookingId:invoice.booking,invoiceId:invoice._id}}).catch(error=>console.error('[MANUAL_ENTRY_NOTIFICATION_FAILED]',error.message));
  }
  res.status(duplicate?200:201).json({success:true,message:duplicate?'Transaction was already recorded. No duplicate was created.':'Financial transaction recorded.',data:{entry,invoice,duplicate}});
});
