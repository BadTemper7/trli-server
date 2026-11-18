import ClientCompany from '../models/ClientCompany.js';
import PreAdvice from '../models/PreAdvice.js';
import {asyncHandler,AppError} from '../utils/http.js';
import {sendStoredDocument} from '../utils/storedDocuments.js';

export const verificationFile=asyncHandler(async(req,res)=>{
  const company=await ClientCompany.findById(req.user.company?._id);
  if(!company)throw new AppError('Company not found.',404);
  return sendStoredDocument(res,'client-verification',company.documents.id(req.params.id));
});

export const preAdviceFile=asyncHandler(async(req,res)=>{
  const booking=await PreAdvice.findOne({_id:req.params.bookingId,company:req.user.company._id});
  if(!booking)throw new AppError('Pre-advice not found.',404);
  return sendStoredDocument(res,'pre-advice',booking.documents.id(req.params.id));
});

// Admin review must use admin session and Pre-advice VIEW permission;
// client-only /api/files routes cannot be used by administrators.
export const adminPreAdviceFile=asyncHandler(async(req,res)=>{
  const booking=await PreAdvice.findById(req.params.id);
  if(!booking)throw new AppError('Pre-advice not found.',404);
  return sendStoredDocument(res,'pre-advice',booking.documents.id(req.params.documentId));
});
