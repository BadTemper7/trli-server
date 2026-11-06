import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const file=path=>readFileSync(new URL(path,import.meta.url),'utf8');

test('new invoice and settings Mongoose defaults are VAT-exclusive',()=>{
  assert.match(file('../src/models/Invoice.js'),/vatInclusive:\{type:Boolean,default:false\}/);
  assert.match(file('../src/models/SiteSettings.js'),/vatInclusive:\{type:Boolean,default:false\}/);
});

test('rate settings and Gate-In billing snapshots do not restore inclusive VAT',()=>{
  const settings=file('../src/controllers/settingsController.js');
  const service=file('../src/services/invoicingService.js');
  assert.match(settings,/tax:\{vatRate:Number\(settings\?\.tax\?\.vatRate\?\?12\),vatInclusive:false\}/);
  assert.match(service,/vatInclusive:false/);
  assert.match(service,/invoice\.vatInclusive/); // existing issued Gate-In invoice updates preserve their mode
});

test('administrative correction to an existing Gate-Out invoice retains original tax basis',()=>{
  const controller=file('../src/controllers/containerTrackingController.js');
  assert.match(controller,/existingInvoiceVatInclusive:invoice\.vatInclusive===true/);
  assert.match(controller,/vatInclusive:adjustedInvoice\.vatInclusive/);
  assert.match(controller,/vatableSales:adjustedInvoice\.vatableSales/);
});

test('settings metadata migration never changes Rate amounts or financial records',()=>{
  const migrate=file('../scripts/migrateVatExclusive.js');
  assert.match(migrate,/tax\.vatInclusive/);
  assert.match(migrate,/updateMany/);
  assert.doesNotMatch(migrate,/Invoice\.update|Rate\.update|PaymentSubmission\.update/);
});

test('admin/client rate labels explain VAT-exclusive base prices',()=>{
  assert.match(file('../../admin/src/components/rates/RateFormModal.jsx'),/Base Rate \(PHP, excludes VAT\)/);
  assert.match(file('../../admin/src/pages/Settings/SettingsPage.jsx'),/Configured rates exclude VAT/);
  assert.match(file('../../client/src/pages/public/Rates.jsx'),/VAT-exclusive base service amounts/);
});
