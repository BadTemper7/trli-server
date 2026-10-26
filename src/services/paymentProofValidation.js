import fs from 'fs/promises';
import { AppError } from '../utils/http.js';

export async function validateUploadedProof(file) {
  if (!file) return; // A transaction reference alone is acceptable.
  const fd = await fs.open(file.path, 'r');
  let bytes;
  try { const buffer = Buffer.alloc(12); const result = await fd.read(buffer, 0, 12, 0); bytes = buffer.subarray(0, result.bytesRead); }
  finally { await fd.close(); }
  const matches = (
    (file.mimetype === 'application/pdf' && bytes.subarray(0, 5).toString() === '%PDF-') ||
    (file.mimetype === 'image/png' && bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) ||
    (file.mimetype === 'image/jpeg' && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff)
  );
  if (!matches) throw new AppError('The payment attachment does not match its declared PDF/image type.', 400);
}

/** Online payment evidence must include a reference OR a validated upload. */
export function validatePaymentEvidence(reference, file) {
  const value = String(reference ?? '').trim();
  if (value.length > 120) throw new AppError('Payment reference cannot exceed 120 characters.',400);
  if (!value && !file) throw new AppError('Enter a payment reference OR attach proof of payment.',400);
  return value;
}
