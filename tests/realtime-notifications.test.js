import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MODULES } from '../src/constants/permissions.js';
import {
  notificationModuleForType, notificationModulesForType,
  accessibleNotificationModules, adminNotificationFilter,
} from '../src/services/notificationRouting.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const source = path => fs.readFileSync(new URL(path, import.meta.url), 'utf8');

const admin = permissions => ({ _id: 'admin-id', role: 'ADMIN_USER', mustChangePassword: false, status: 'ACTIVE', permissions });
const viewer = module => admin([{ module, actions: ['VIEW'] }]);

test('new booking alerts go only to Pre-advice queue', () => {
  assert.equal(notificationModuleForType('PRE_ADVICE_CREATED'), MODULES.PRE_ADVICE);
  assert.deepEqual(notificationModulesForType('PRE_ADVICE_CREATED'), [MODULES.PRE_ADVICE]);
});

test('Gate-in payment proof alert is shared by Gate-in and finance queues once', () => {
  assert.deepEqual(notificationModulesForType('GATE_IN_PAYMENT_SUBMITTED'), [MODULES.GATE_IN, MODULES.PAYMENT_HISTORY]);
});

test('Gate-out request/payment alert is shared by Gate-out and finance queues once', () => {
  assert.deepEqual(notificationModulesForType('GATE_OUT_REQUESTED'), [MODULES.GATE_OUT, MODULES.PAYMENT_HISTORY]);
});

test('permissions filter excludes administrators without eligible VIEW rights', () => {
  assert.deepEqual(accessibleNotificationModules(admin([{ module: MODULES.GATE_OUT, actions: ['EDIT'] }])), []);
  assert.deepEqual(accessibleNotificationModules({ ...viewer(MODULES.GATE_OUT), status:'INACTIVE' }), []);
  assert.deepEqual(accessibleNotificationModules({ ...viewer(MODULES.GATE_OUT), mustChangePassword:true }), []);
  assert.deepEqual(adminNotificationFilter(admin([])), { audience:'ADMIN', _id:{ $exists:false } });
});

test('filter allows module-level visibility for multi-queue alerts without sharing client records', () => {
  const query = adminNotificationFilter(viewer(MODULES.PAYMENT_HISTORY));
  assert.equal(query.audience, 'ADMIN');
  assert.ok(query.$or.some(item => item.modules?.$in?.includes(MODULES.PAYMENT_HISTORY)));
  assert.ok(query.$or.some(item => item.module?.$in?.includes(MODULES.PAYMENT_HISTORY)));
  assert.ok(!query.$or.some(item => item.module?.$in?.includes(MODULES.REPORTS)));
});

test('only the proper admin modules can view legacy alerts without a module field', () => {
  const query = adminNotificationFilter(viewer(MODULES.GATE_OUT));
  assert.ok(query.$or.some(item => String(item.type).includes('GATE_OUT_')));
  assert.ok(!query.$or.some(item => String(item.type).includes('GATE_IN_')));
});

test('client and admin Socket.IO clients explicitly identify their audience', () => {
  assert.match(source('../../admin/src/lib/adminSocket.js'), /audience:\s*'ADMIN'/);
  assert.match(source('../../client/src/lib/socket.js'), /audience:\s*'CLIENT'/);
  assert.match(source('../src/socket/socketAuth.js'), /audience==='ADMIN'/);
  assert.match(source('../src/socket/socketAuth.js'), /!\['ADMIN','CLIENT'\]\.includes\(audience\)/);
});

test('admin socket is activated by _id in the actual authentication response', () => {
  assert.match(source('../../admin/src/context/AuthContext.jsx'), /user\?\._id\s*\|\|\s*user\?\.id/);
  assert.match(source('../src/controllers/adminAuthController.js'), /obj\.id=String\(obj\._id\)/);
});

test('admin history, per-user unread state and mark-read endpoints are installed', () => {
  const app = source('../src/app.js');
  const api = source('../src/routes/adminNotificationRoutes.js');
  const ui = source('../../admin/src/components/user/NotificationMenu.jsx');
  const model = source('../src/models/Notification.js');
  assert.match(app, /\/api\/admin\/notifications/);
  assert.match(api, /router\.get\('\/'/);
  assert.match(api, /router\.patch\('\/read-all'/);
  assert.match(api, /router\.patch\('\/:id\/read'/);
  assert.match(model, /adminReadBy:/);
  assert.match(ui, /notification:new/);
  assert.match(ui, /notification:read-all/);
  assert.match(ui, /Mark all read/);
  assert.match(ui, /admin\/notifications/);
});

test('committed Gate-in payments notify administrators, Gate-out requests and release queue remain covered', () => {
  const invoice = source('../src/controllers/invoiceController.js');
  const gateout = source('../src/controllers/clientGateOutController.js');
  assert.match(invoice, /type:\s*'GATE_IN_PAYMENT_SUBMITTED'/);
  assert.match(invoice, /'gate-in:updated'/);
  assert.match(gateout, /type:'GATE_OUT_REQUESTED'/);
  assert.match(gateout, /type:'RELEASE_READY'/);
  assert.match(gateout, /'release:queue-updated'/);
});

test('physical release asks for confirmation using an accessible modal before calling the endpoint', () => {
  const ui = source('../../admin/src/pages/ReleaseContainer/ReleaseContainerPage.jsx');
  assert.match(ui, /<Dialog\.Root/);
  assert.match(ui, /<Dialog\.Content/);
  assert.match(ui, /Confirm physical container release/);
  assert.match(ui, /Yes, Release Container/);
  assert.match(ui, /if \(!selected \|\| !permitted \|\| busy \|\| !confirmOpen\) return/);
  assert.ok(!ui.includes('window.confirm('));
});

test('notification index migration does not reprice or alter historical financial rows', () => {
  const script = source('../scripts/migrateNotificationIndexes.js');
  assert.match(script, /!apply/);
  assert.match(script, /createIndex/);
  assert.ok(!script.includes('updateMany('));
  assert.ok(!script.includes('deleteMany('));
});
