/**
 * Dry run: npm run migrate:universal-overtime
 * Apply:   npm run migrate:universal-overtime -- --apply
 *
 * Creates a universal active BOTH overtime rate only when there is a positive
 * existing Settings overtime fee and no matching active universal rate.
 * Existing category-specific overrides, rates and issued invoices are left alone.
 * Back up the database before running any migration.
 */
import 'dotenv/config';
import mongoose from 'mongoose';
import Rate from '../src/models/Rate.js';
import SiteSettings from '../src/models/SiteSettings.js';

if (!process.env.MONGODB_URI) throw new Error('MONGODB_URI is required.');
const apply = process.argv.includes('--apply');
await mongoose.connect(process.env.MONGODB_URI);
try {
  const settings = await SiteSettings.findOne({ key: 'COMPANY_CONTACT' }).lean();
  const amount = Number(settings?.overtime?.fee || 0);
  const enabled = settings?.overtime?.active !== false;
  const selector = {name:'Overtime',classification:'ALL',containerCategory:'ALL',loadStatus:'ALL',containerSize:'ALL',collectionPoint:'BOTH',status:'ACTIVE'};
  const exists = await Rate.exists(selector);
  const categoryOverrides = await Rate.countDocuments({name:'Overtime',status:'ACTIVE',$nor:[selector]});
  const action = exists ? 'already configured, no changes' : !enabled ? 'overtime disabled in Settings, no changes'
    : !(amount > 0) ? 'configure a positive global amount in Settings or manually create an All/Both rate' : 'create universal Overtime Rate';
  console.log(JSON.stringify({mode:apply?'APPLY':'DRY_RUN',settingsActive:enabled,settingsAmount:amount,activeCategoryOverrides:categoryOverrides,universalRateExists:Boolean(exists),action},null,2));
  if (apply && !exists && enabled && amount > 0) {
    try {
      const result = await Rate.create({...selector,amount:Math.round(amount*100)/100,billingMode:'AUTOMATIC',taxTreatment:'TAXABLE',description:'Universal overtime rate migrated from terminal Settings. Individual active overtime rates override this amount when more specific.'});
      console.log(`Created universal Gate-in/Gate-out Overtime rate ${result.id}.`);
    } catch (error) {
      if (error.code === 11000) console.log('An active universal overtime rate already exists (concurrent migration). No action taken.');
      else throw error;
    }
  }
  if (apply) console.log('No historical invoices, paid amounts or category-specific rates were updated.');
} finally {
  await mongoose.disconnect();
}
