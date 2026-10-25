import SiteSettings from '../models/SiteSettings.js';
import { auditAdminAction } from '../services/adminAuditService.js';
import { emitToAdminModule, getIO } from '../socket/index.js';
import { MODULES } from '../constants/permissions.js';
import { AppError, asyncHandler } from '../utils/http.js';

const SETTINGS_KEY = 'COMPANY_CONTACT';
const clean = (value, max = 500) => String(value ?? '').trim().slice(0, max);

function dto(settings) {
  return {
    phone: settings?.phone || '',
    email: settings?.email || '',
    office: settings?.office || '',
    operatingHours: settings?.operatingHours || '',
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

  const settings = await SiteSettings.findOneAndUpdate(
    { key: SETTINGS_KEY },
    {
      $set: {
        phone,
        email,
        office,
        operatingHours,
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
