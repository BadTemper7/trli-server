import PreAdvice from '../models/PreAdvice.js';
import Invoice from '../models/Invoice.js';
import ClientCompany from '../models/ClientCompany.js';
import SiteSettings from '../models/SiteSettings.js';
import {renderGatePassPdf,renderServiceInvoicePdf} from '../services/printableDocuments.js';
import {AppError,asyncHandler} from '../utils/http.js';

function download(res,buffer,filename) {
  return res.status(200).type('application/pdf')
    .set('Cache-Control','private, no-store')
    .set('X-Content-Type-Options','nosniff')
    .set('Content-Disposition',`attachment; filename="${filename}"`).send(buffer);
}
const safeFile = value => String(value || 'document').replace(/[^A-Za-z0-9_-]+/g,'-').slice(0,100);

async function bookingRecord(id) {
  const booking=await PreAdvice.findById(id).lean();
  if(!booking)throw new AppError('Booking not found.',404);
  return booking;
}

export const downloadGateInPass=asyncHandler(async(req,res)=>{
  const booking=await bookingRecord(req.params.id);
  if(!booking.preAdviceReview?.approvedAt && !['READY_FOR_GATE_IN','GATE_IN_PAYMENT_SUBMITTED','GATE_IN','INVENTORY','STORAGE','GATE_OUT_PAYMENT_SUBMITTED','READY_FOR_RELEASE','CONTAINER_RELEASED'].includes(booking.workflowStage)) {
    throw new AppError('Approve Pre-advice before printing a Gate-in Pass.',409);
  }
  download(res,renderGatePassPdf({booking,type:'GATE_IN'}),`${safeFile(booking.bookingReference)}-gate-in-pass.pdf`);
});

export const downloadGateOutPass=asyncHandler(async(req,res)=>{
  const booking=await bookingRecord(req.params.id);
  if(!booking.gateOut?.requestedAt)throw new AppError('Gate-out request has not been submitted.',409);
  // Draft passes are visibly labeled not valid for physical release.
  download(res,renderGatePassPdf({booking,type:'GATE_OUT'}),`${safeFile(booking.bookingReference)}-gate-out-${booking.gateOut?.approvedAt?'pass':'draft'}.pdf`);
});

export const downloadReleasePass=asyncHandler(async(req,res)=>{
  const booking=await bookingRecord(req.params.id);
  if(!['APPROVED','RELEASED'].includes(booking.gateOut?.approvalStatus))throw new AppError('Gate-out approval is required before printing an authorized release pass.',409);
  download(res,renderGatePassPdf({booking,type:'GATE_OUT'}),`${safeFile(booking.bookingReference)}-authorized-gate-out-pass.pdf`);
});

export const downloadOperationalInvoice=asyncHandler(async(req,res)=>{
  const booking=await bookingRecord(req.params.id);
  const type=req.params.type==='gate-in'?'GATE_IN':req.params.type==='gate-out'?'GATE_OUT':null;
  if(!type)throw new AppError('Unknown transaction type.',400);
  const invoice=await Invoice.findOne({booking:booking._id,type}).lean();
  if(!invoice)throw new AppError('Invoice has not been generated for this booking.',404);
  const [company,settings]=await Promise.all([
    ClientCompany.findById(booking.company).select('companyName').lean(),
    SiteSettings.findOne({key:'COMPANY_CONTACT'}).lean(),
  ]);
  download(res,renderServiceInvoicePdf({invoice,booking,companyName:company?.companyName,settings}),`${safeFile(invoice.number)}-service-invoice.pdf`);
});
