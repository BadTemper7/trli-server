import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const content = path => fs.readFileSync(new URL(path, import.meta.url),'utf8');
test('Calendar storage is the default for new company settings and approved invoice pricing',()=>{
 const settings=content('../src/models/SiteSettings.js');
 const calculator=content('../src/utils/billingMath.js');
 assert.match(settings,/default:'CALENDAR_DAYS'/);
 assert.match(calculator,/storageBilling\?\.rounding \|\| 'CALENDAR_DAYS'/);
});
test('Physical release freezes final days using actual Gate-in and actual Gate-out timestamps',()=>{
 const operations=content('../src/controllers/operationsController.js');
 assert.match(operations,/finalDaysInTerminal=storageDaysBetween\(item\.gateIn\.actualGateInAt,now,/);
 assert.match(operations,/item\.gateOut\.releasedAt=now/);
});
test('Client Gate-out dialog and admin Storage Monitoring use calendar storage-day fields',()=>{
 const client=content('../../client/src/components/booking/GateOutRequest.jsx');
 const storage=content('../src/controllers/storageController.js');
 const page=content('../../admin/src/pages/StorageMonitoring/StorageBlockDetailPage.jsx');
 assert.match(client,/calendarStorageDays\(booking\.gateIn\?\.actualGateInAt\)/);
 assert.match(client,/Estimated storage charge:/);
 assert.match(storage,/daysInTerminal:/);
 assert.match(page,/Days in Terminal/);
});
test('Migration affects settings only, never historical paid invoices',()=>{
 const migration=content('../scripts/migrateStorageCalendarDays.js');
 assert.match(migration,/SiteSettings\.updateOne\(/);
 assert.doesNotMatch(migration,/Invoice\.update|PreAdvice\.update|PaymentSubmission\.update/);
});
