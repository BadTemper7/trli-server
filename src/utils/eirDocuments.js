import { AppError } from './http.js';

const eirTypes = new Set(['eir', 'deliveryOrder']);

export function hasEirDocument(documents = []) {
  return Array.isArray(documents) && documents.some(document => eirTypes.has(document?.type));
}

export function validateEirSubmission(files, previousDocuments = []) {
  const uploaded = files?.eir?.[0] || files?.deliveryOrder?.[0];
  if (uploaded && uploaded.size > 0) return true;
  if (hasEirDocument(previousDocuments)) return true;
  throw new AppError('Equipment Interchange Receipt (EIR) is required. Upload a PDF, JPG or PNG document.', 400);
}
