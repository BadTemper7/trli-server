import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {resolve, dirname} from 'node:path';
import {documentSelectionError, documentMetadata, MAX_DOCUMENT_BYTES} from '../../client/src/utils/documentSelection.js';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const read=path=>readFileSync(resolve(root,path),'utf8');

test('document picker rejects empty and oversize files, supports common iOS missing MIME type',()=>{
  assert.match(documentSelectionError({name:'file.pdf',type:'application/pdf',size:0}),/empty/);
  assert.match(documentSelectionError({name:'file.pdf',type:'application/pdf',size:MAX_DOCUMENT_BYTES+1}),/10 MB/);
  assert.match(documentSelectionError({name:'file.exe',type:'application/octet-stream',size:20}),/Only PDF/);
  assert.equal(documentSelectionError({name:'receipt.PDF',type:'',size:128}), '');
  assert.equal(documentSelectionError({name:'receipt.jpg',type:'image/jpeg',size:128}), '');
  const file={name:'file.pdf',type:'application/pdf',size:100,customField:Symbol('no')};
  assert.deepEqual(documentMetadata(file),{name:'file.pdf',size:100,type:'application/pdf'});
});

test('both Pre-Advice implementations keep native File objects out of react form state',()=>{
  const modern=read('client/src/pages/portal/PreAdviceForm.jsx');
  const legacy=read('client/src/pages/ClientPages.jsx');
  assert.match(modern,/selectedFiles = useRef\(\{\}\)/);
  assert.match(modern,/documentMetadata\(file\)/);
  assert.match(modern,/Object\.entries\(selectedFiles\.current\)/);
  assert.match(legacy,/selectedFiles = useRef\(\{\}\)/);
  assert.match(legacy,/documentMetadata\(file\)/);
  assert.match(legacy,/Object\.entries\(selectedFiles\.current\)/);
});

test('client document picker has a local error boundary instead of blank screen',()=>{
  const c=read('client/src/components/ui/FileUpload.jsx');
  assert.match(c,/event\.currentTarget\.value = ''/);
  assert.match(c,/documentSelectionError\(next\)/);
  assert.match(read('client/src/main.jsx'),/ClientErrorBoundary/);
  assert.match(read('client/src/pages/portal/PreAdviceForm.jsx'),/onReset=\{\(\)=>selectDocument/);
});

test('admin cookie fallback issued only when asked after cookie verification failure',()=>{
  const ctrl=read('server/src/controllers/adminAuthController.js');
  const context=read('admin/src/context/AuthContext.jsx');
  const api=read('admin/src/lib/adminApi.js');
  assert.match(ctrl,/req\.body\?\.compatibilityFallback===true/);
  assert.match(ctrl,/purpose:'browser-compatibility'/);
  assert.match(ctrl,/Math\.min\(requested,120\)/);
  assert.match(context,/verified = await adminAuthApi\.me\(\)/);
  assert.match(context,/error\.status !== 401/);
  assert.match(context,/compatibilityFallback: true/);
  assert.match(context,/setAdminFallbackToken\(response\.data\.fallbackToken\)/);
  assert.match(api,/Authorization = `Bearer \$\{token\}`/);
  assert.match(read('server/src/middleware/adminAuth.js'),/authorization\?\.replace/);
  assert.match(read('server/src/socket/socketAuth.js'),/handshake\.auth\?\.token/);
  assert.match(read('admin/src/lib/adminSocket.js'),/getAdminFallbackToken/);
});

test('admin upload preview and CSV report export support authenticated token fallback',()=>{
  assert.match(read('admin/src/components/documents/AdminDocumentPreview.jsx'),/adminFetch\(request\.path/);
  assert.match(read('admin/src/lib/adminFiles.js'),/adminFetch\(path/);
  assert.match(read('admin/src/pages/Reports/ReportsPage.jsx'),/analyticsApi\.downloadReport\(params\)/);
});
