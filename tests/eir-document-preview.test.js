import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { hasEirDocument, validateEirSubmission } from '../src/utils/eirDocuments.js';
import { filePath, uploadFolder } from '../src/utils/storedDocuments.js';

const source = file => readFileSync(new URL(file, import.meta.url), 'utf8');

test('New bookings require a non-empty EIR, including the legacy Delivery Order API field', () => {
  assert.throws(() => validateEirSubmission({}), /EIR/);
  assert.throws(() => validateEirSubmission({ eir: [{size:0}] }), /EIR/);
  assert.doesNotThrow(() => validateEirSubmission({ eir: [{size:1024, mimetype:'application/pdf'}] }));
  assert.doesNotThrow(() => validateEirSubmission({ deliveryOrder: [{size:1024}] }));
  assert.equal(hasEirDocument([{type:'eir'}]), true);
  assert.equal(hasEirDocument([{type:'deliveryOrder'}]), true);
  assert.equal(hasEirDocument([{type:'packingList'}]), false);
});

test('Editing an existing booking preserves old EIR attachments and enforces EIR when absent', () => {
  assert.doesNotThrow(() => validateEirSubmission({}, [{type:'deliveryOrder'}]));
  assert.doesNotThrow(() => validateEirSubmission({}, [{type:'eir'}]));
  assert.throws(() => validateEirSubmission({}, [{type:'bookingConfirmation'}]), /EIR/);
});

test('Admin Pre-advice document route requires authenticated admin with PRE_ADVICE VIEW permission', () => {
  const ops = source('../src/routes/operationsRoutes.js');
  const ctrl = source('../src/controllers/fileController.js');
  assert.match(ops, /router\.use\(adminAuth, requirePasswordChanged\)/);
  assert.match(ops, /router\.get\('\/pre-advice\/:id\/documents\/:documentId',[^\n]*requirePermission\(MODULES\.PRE_ADVICE, ACTIONS\.VIEW\), adminPreAdviceFile/);
  assert.match(ctrl, /await PreAdvice\.findById\(req\.params\.id\)/);
  assert.match(ctrl, /booking\.documents\.id\(req\.params\.documentId\)/);
  assert.match(source('../src/controllers/operationsController.js'), /documents: \(item\.documents \|\| \[\]\)\.map\(doc/);
});

test('File paths never escape the configured uploads directory', () => {
  assert.ok(filePath('pre-advice', 'abc123.pdf').startsWith(uploadFolder('pre-advice')));
  assert.throws(() => filePath('pre-advice','../../.env'),/Invalid stored filename/);
  assert.throws(() => filePath('pre-advice','a\\b.pdf'),/Invalid stored filename/);
  assert.throws(() => uploadFolder('../private'),/Invalid document location/);
  assert.match(source('../src/middleware/upload.js'), /uploadFolder\(folder\)/);
});

test('EIR is shown in the booking form, details, admin review and protected previews', () => {
  assert.match(source('../../client/src/pages/portal/PreAdviceForm.jsx'), /EIR \(Equipment Interchange Receipt\)/);
  assert.match(source('../../client/src/pages/portal/PreAdviceForm.jsx'), /files\.eir/);
  assert.match(source('../../client/src/pages/portal/PreAdviceDetail.jsx'), /setPreviewDocument/);
  assert.match(source('../../admin/src/pages/PreAdvice/PreAdvicePage.jsx'), /Uploaded Booking Documents/);
  assert.match(source('../../admin/src/components/documents/AdminDocumentPreview.jsx'), /adminFetch\(request\.path/);
  assert.match(source('../../admin/src/lib/adminApi.js'), /credentials:'include'/);
  assert.match(source('../../client/src/components/documents/DocumentPreview.jsx'), /responseType: 'blob'/);
});

test('iOS auth cookies use configurable first-party-safe settings and strict-storage guard', () => {
  assert.match(source('../src/controllers/authController.js'), /authCookieOptions/);
  assert.match(source('../src/controllers/adminAuthController.js'), /authCookieOptions/);
  assert.match(source('../src/utils/authCookie.js'), /AUTH_COOKIE_SAME_SITE/);
  assert.match(source('../../client/src/context/AuthContext.jsx'), /try \{ return localStorage\.getItem/);
  assert.match(source('../../client/vite.config.js'), /safari15/);
});
