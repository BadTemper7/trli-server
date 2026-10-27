import SiteSettings from '../models/SiteSettings.js';
import { auditAdminAction } from '../services/adminAuditService.js';
import { emitToAdminModule, getIO } from '../socket/index.js';
import { MODULES } from '../constants/permissions.js';
import { AppError, asyncHandler } from '../utils/http.js';
import { DEFAULT_OPERATING_SCHEDULE, is24HourSchedule, validateOperatingSchedule } from '../utils/operatingSchedule.js';

const SETTINGS_KEY = 'COMPANY_CONTACT';
const clean = (value, max = 500) => String(value ?? '').trim().slice(0, max);

function dto(settings) {
  return {
    phone: settings?.phone || '',
    email: settings?.email || '',
    office: settings?.office || '',
    operatingHours: settings?.operatingHours || '24 hours daily',
    schedule:settings?.schedule || DEFAULT_OPERATING_SCHEDULE,
    overtime:settings?.overtime || {start:'18:00',end:'08:00',fee:0,active:true},
    tax:settings?.tax || {vatRate:12,vatInclusive:false},
    shiftingFee:Number(settings?.shiftingFee||0),
    storageBilling:settings?.storageBilling||{rounding:'CALENDAR_DAYS'},
    updatedAt: settings?.updatedAt || null,
  };
}

async function getSettings() {
  return SiteSettings.findOne({ key: SETTINGS_KEY }).lean();
}

export const getPublicCompanySettings = asyncHandler(async (req, res) => {
  const settings = await getSettings();
  res.json({ success: true, message: 'Company contact settings loaded.', data: dto(settings) });
});

export const getAdminCompanySettings = asyncHandler(async (req, res) => {
  const settings = await getSettings();
  res.json({ success: true, message: 'Company contact settings loaded.', data: dto(settings) });
});

export const updateCompanySettings = asyncHandler(async (req, res) => {
  const phone = clean(req.body?.phone, 80);
  const email = clean(req.body?.email, 180).toLowerCase();
  const office = clean(req.body?.office, 500);
  const operatingHours = clean(req.body?.operatingHours, 300);

  if (email && !/^\S+@\S+\.\S+$/.test(email)) {
    throw new AppError('Enter a valid company email address.', 400);
  }

  const schedule=req.body?.schedule;
  const HH=/^([01]\d|2[0-3]):00$/;
  if (schedule) {const scheduleError=validateOperatingSchedule(schedule);if(scheduleError)throw new AppError(scheduleError,400);}

  const overtime=req.body?.overtime;
  if(overtime && (!HH.test(overtime.start)||!HH.test(overtime.end)||overtime.start===overtime.end||!Number.isFinite(Number(overtime.fee))||Number(overtime.fee)<0||typeof overtime.active!=='boolean'))throw new AppError('Invalid overtime configuration.',400);
  const tax=req.body?.tax;
  if(tax && (!Number.isFinite(Number(tax.vatRate))||Number(tax.vatRate)<0||Number(tax.vatRate)>100||typeof tax.vatInclusive!=='boolean'))throw new AppError('Invalid VAT configuration.',400);
  if(req.body?.shiftingFee!==undefined&&(!Number.isFinite(Number(req.body.shiftingFee))||Number(req.body.shiftingFee)<0))throw new AppError('Invalid shifting fee.',400);
  const billing=req.body?.storageBilling;
  if(billing&&!['CALENDAR_DAYS','CEIL_24_HOURS'].includes(billing.rounding))throw new AppError('Unsupported storage billing-day rule.',400);
  const settings = await SiteSettings.findOneAndUpdate(
    { key: SETTINGS_KEY },
    {
      $set: {
        phone,
        email,
        office,
        operatingHours: schedule && is24HourSchedule(schedule) && schedule.operatingDays.length===7 ? '24 hours daily' : operatingHours,
        ...(schedule?{schedule}:{}),
        ...(req.body?.overtime?{overtime:req.body.overtime}:{}),
        ...(req.body?.tax?{tax:req.body.tax}:{}),
        ...(req.body?.shiftingFee!==undefined?{shiftingFee:Number(req.body.shiftingFee)}:{}),
        ...(billing?{storageBilling:billing}:{}),
        updatedBy: req.admin._id,
      },
      $setOnInsert: { key: SETTINGS_KEY },
    },
    { new: true, upsert: true, runValidators: true },
  );

  const data = dto(settings);

  await auditAdminAction({
    performedBy: req.admin._id,
    action: 'COMPANY_SETTINGS_UPDATED',
    changes: data,
  });

  emitToAdminModule(MODULES.SETTINGS, 'settings:company-updated', data);
  getIO()?.emit('public:company-settings-updated', data);

  res.json({ success: true, message: 'Company contact information updated.', data });
});
