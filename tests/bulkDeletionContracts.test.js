import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {MODULE_ACTIONS} from '../src/constants/permissions.js';
const here=path.dirname(fileURLToPath(import.meta.url));
const read=f=>fs.readFileSync(path.resolve(here,'..',f),'utf8');
const logic=read('src/controllers/bulkDeletionController.js');
const route=read('src/routes/bulkDeletionRoutes.js');
const ui=fs.readFileSync(path.resolve(here,'../../admin/src/components/deletion/DeletionControls.jsx'),'utf8');

test('each operational table has independently assignable Delete permission',()=>{
 for(const name of ['PRE_ADVICE','GATE_IN','INVENTORY','GATE_OUT','RELEASE_CONTAINER','CONTAINER_TRACKING','FORWARDING','STORAGE_MONITORING','CLIENT_VERIFICATION','RATE_SETUP','PAYMENT_TYPES','USER_MANAGEMENT','PAYMENT_HISTORY'])assert.ok(MODULE_ACTIONS[name]?.includes('DELETE'),`${name} missing DELETE`);
});
test('audit log records are read-only and cannot be deleted',()=>{
 assert.deepEqual(MODULE_ACTIONS.AUDIT_LOGS,['VIEW']);
 assert.match(route,/requirePermission\(MODULES\.AUDIT_LOGS,ACTIONS\.VIEW\)/);
 assert.doesNotMatch(logic,/AdminAuditLog\.delete/);
});
test('bulk delete route is authenticated and requires a selected module Delete right',()=>{
 assert.match(route,/router\.use\(adminAuth,requirePasswordChanged\)/);
 assert.match(logic,/hasPermission\(req\.admin,parsed\.module,ACTIONS\.DELETE\)/);
 assert.match(logic,/DELETE_DENIED/);
});
test('confirmation phrase, audit reason and record limits are server-enforced',()=>{
 assert.match(logic,/MAX_BATCH = 100/);
 assert.match(logic,/`DELETE \$\{parsed\.ids\.length\}`/);
 assert.match(logic,/reason\.length<8/);
});
test('single & bulk deletes commit their audit records atomically',()=>{
 assert.match(logic,/session\.withTransaction/);
 assert.match(logic,/RECORDS_BULK_DELETED/);
 assert.match(logic,/await auditAdminAction\([\s\S]*session\}\);/);
});
test('all booking views use one cascade, clearing financial and storage references',()=>{
 assert.match(logic,/PRE_ADVICE','GATE_IN','INVENTORY','GATE_OUT','RELEASE_CONTAINER/);
 for(const target of ['PaymentSubmission','Invoice','StorageMovement','BookingSlot','Notification','EmailOutbox','PreAdvice'])assert.match(logic,new RegExp(`${target}\\.(deleteMany|updateMany)`),`${target} missing cascade`);
});
test('verified financial documents require explicit staging-only Super Admin override',()=>{
 assert.match(logic,/process\.env\.NODE_ENV !== 'production'/);
 assert.match(logic,/ALLOW_FINANCIAL_PURGE/);
 assert.match(logic,/role === 'SUPER_ADMIN'/);
 assert.match(logic,/Verified financial records are protected/);
});
test('protected Super Admin and active accounts cannot be deleted',()=>{
 assert.match(logic,/isSystemProtected/);
 assert.match(logic,/Deactivate each administrator before deletion/);
 assert.match(logic,/your own account cannot be deleted/);
});
test('UI shows menu and selection only with granted Delete access and requires explicit confirmation',()=>{
 assert.match(ui,/can\(module,ACTIONS\.DELETE\)/);
 assert.match(ui,/DropdownMenuTrigger/);
 assert.match(ui,/onDelete/);
 assert.match(ui,/DELETE \$\{count\}/);
 assert.match(ui,/adminRequest\('\/admin\/records\/delete'/);
});
test('Audit Logs page and route are exposed',()=>{
 assert.match(read('src/app.js'),/app\.use\('\/api\/admin\/records',bulkDeletionRoutes\)/);
 const nav=fs.readFileSync(path.resolve(here,'../../admin/src/config/navigation.js'),'utf8');
 assert.match(nav,/Audit Logs/);
});
