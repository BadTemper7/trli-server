import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AppError } from './http.js';

// A single persistent directory shared by Multer and the protected download
// routes. It must not depend on the process working directory.
const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const uploadRoot = path.resolve(process.env.UPLOAD_ROOT || path.join(serverRoot, 'uploads'));
const folders = new Set(['client-verification', 'pre-advice', 'payment-proofs']);

export function uploadFolder(folder) {
  if (!folders.has(folder)) throw new AppError('Invalid document location.', 400);
  return path.join(uploadRoot, folder);
}

export function filePath(folder, storedName) {
  const name = String(storedName || '');
  if (!name || name !== path.basename(name) || name === '.' || name === '..' || /[\\/\r\n]/.test(name)) {
    throw new AppError('Invalid stored filename.', 400);
  }
  return path.join(uploadFolder(folder), name);
}

const supportedTypes = new Set(['application/pdf', 'image/jpeg', 'image/png']);
export function sendStoredDocument(res, folder, document) {
  if (!document) throw new AppError('Document not found.', 404);
  const location = filePath(folder, document.storedName);
  if (!fs.existsSync(location)) throw new AppError('Uploaded document is missing from server storage.', 404);
  const mimeType = supportedTypes.has(document.mimeType) ? document.mimeType : 'application/octet-stream';
  const safeName = String(document.name || 'document').replace(/[\r\n\"\\]/g, '_').slice(0, 180);
  res.type(mimeType);
  res.setHeader('Content-Disposition', `inline; filename="${safeName}"`);
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Vary', 'Cookie');
  return res.sendFile(location);
}
