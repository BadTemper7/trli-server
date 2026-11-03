import { Router } from 'express';
import Rate from '../models/Rate.js';
import SiteSettings from '../models/SiteSettings.js';
import { asyncHandler, AppError } from '../utils/http.js';
import { availableBookingLoadStatuses } from '../utils/bookingRateOptions.js';

const router = Router();

// Live options for the Client Pre-Advice form. These are computed from the
// same active Rate rows used by billing, never hard-coded Reefer assumptions.
router.get('/load-statuses', asyncHandler(async (req,res) => {
  const containerType=String(req.query.containerType||'').trim().toUpperCase();
  const containerSize=String(req.query.containerSize||'').trim().toUpperCase();
  const transactionClassification=String(req.query.classification||'').trim().toUpperCase();
  if(!['DRY CONTAINER','REEFER','TANK CONTAINER','OPEN TOP','FLAT RACK'].includes(containerType)
   ||!['20FT','40FT'].includes(containerSize)
   ||!['LOCAL','INTERNATIONAL'].includes(transactionClassification))
    throw new AppError('Valid container type, size and classification are required.',400);
  const category=containerType==='REEFER'?'REEFER':'STANDARD';
  const rates=await Rate.find({status:'ACTIVE',containerCategory:category,
    classification:{$in:[transactionClassification,'ALL']},
    containerSize:{$in:[containerSize,'ALL']},
    loadStatus:{$in:['EMPTY','LOADED','ALL']},
    $or:[{effectiveFrom:null},{effectiveFrom:{$exists:false}},{effectiveFrom:{$lte:new Date()}}],
  }).select('status name containerCategory classification containerSize loadStatus collectionPoint effectiveFrom').lean();
  const available=availableBookingLoadStatuses(rates,{containerType,containerSize,transactionClassification});
  res.set('Cache-Control','no-store');
  res.json({success:true,data:{loadStatuses:available}});
}));

router.get('/', asyncHandler(async (req, res) => {
  const filter = { status: 'ACTIVE', $or: [{effectiveFrom:null},{effectiveFrom:{$exists:false}},{effectiveFrom:{$lte:new Date()}}] };

  const classification = String(req.query.classification || '').trim().toUpperCase();
  if (['LOCAL', 'INTERNATIONAL'].includes(classification)) filter.classification = { $in: [classification, 'ALL'] };

  const loadStatus = String(req.query.loadStatus || '').trim().toUpperCase();
  if (['EMPTY', 'LOADED'].includes(loadStatus)) filter.loadStatus = { $in: [loadStatus, 'ALL'] };

  const containerSize = String(req.query.containerSize || '').trim().toUpperCase();
  if (['ALL', '20FT', '40FT'].includes(containerSize)) filter.containerSize = containerSize === 'ALL' ? 'ALL' : { $in: [containerSize, 'ALL'] };

  const settings = await SiteSettings.findOne({key:'COMPANY_CONTACT'}).select('overtime').lean();
  // Disabled overtime is not currently applicable, even if its rate rows stay active.
  if (settings?.overtime?.active === false) filter.name = { $ne: 'Overtime' };
  const rows = await Rate.find(filter)
    .select('name classification containerCategory loadStatus containerSize amount collectionPoint billingMode taxTreatment description effectiveFrom updatedAt')
    .sort({ classification: 1, name: 1, loadStatus: 1, containerSize: 1, amount: 1 })
    .lean();

  const data = rows.map((rate) => ({
    id: String(rate._id),
    name: rate.name,
    classification: rate.classification,
    loadStatus: rate.loadStatus,
    containerSize: rate.containerSize,
    amount: rate.amount,
    collectionPoint: rate.collectionPoint,
    billingMode: rate.billingMode || 'AUTOMATIC',
    taxTreatment: rate.taxTreatment || 'TAXABLE',
    containerCategory: rate.containerCategory || 'STANDARD',
    description: rate.description || '',
    effectiveFrom:rate.effectiveFrom,
    updatedAt: rate.updatedAt,
  }));

  // Expose the existing global Settings fallback as a read-only rate, so
  // Client Rates displays the same default amount the invoice engine uses.
  // A real universal rate in Rate Setup supersedes the fallback.
  const hasUniversal = rows.some(rate => rate.name === 'Overtime' && rate.classification === 'ALL'
    && rate.loadStatus === 'ALL' && rate.containerCategory === 'ALL'
    && rate.containerSize === 'ALL' && rate.collectionPoint === 'BOTH');
  const overtime = settings?.overtime;
  if (!hasUniversal && overtime?.active !== false && Number(overtime?.fee) > 0) {
    data.push({
      id: 'settings-overtime', source: 'SETTINGS', name: 'Overtime', classification: 'ALL',
      containerCategory: 'ALL', loadStatus: 'ALL', containerSize: 'ALL',
      amount: Number(overtime.fee), collectionPoint: 'BOTH', billingMode: 'AUTOMATIC',
      taxTreatment: 'TAXABLE', description: `Default overtime charge (${overtime.start || '18:00'}-${overtime.end || '08:00'}, Asia/Manila)`,
      effectiveFrom: null, updatedAt: null,
    });
  }
  res.json({ success: true, message: 'Active rates loaded.', data });
}));

export default router;
