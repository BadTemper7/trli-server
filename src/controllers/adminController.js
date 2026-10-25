import fs from 'fs';
import path from 'path';
import ClientCompany from '../models/ClientCompany.js';
import ClientUser from '../models/ClientUser.js';
import VerificationHistory from '../models/VerificationHistory.js';
import { createNotification } from '../services/notificationService.js';
import { sendApproved, sendRejected } from '../services/emailService.js';
import { getIO, emitToAdminModule } from '../socket/index.js';
import { MODULES } from '../constants/permissions.js';
import { asyncHandler, ok, AppError } from '../utils/http.js';

const serializeCompany = (company, primaryUser = null) => ({
  id: String(company._id),
  companyName: company.companyName,
  companyAddress: company.companyAddress,
  businessType: company.businessType,
  otherBusinessType: company.otherBusinessType || '',
  verificationStatus: company.verificationStatus,
  rejectionReason: company.rejectionReason || null,
  verifiedAt: company.verifiedAt || null,
  documentCount: company.documents?.length || 0,
  createdAt: company.createdAt,
  updatedAt: company.updatedAt,
  primaryContact: primaryUser
    ? {
        id: String(primaryUser._id),
        firstName: primaryUser.firstName,
        middleName: primaryUser.middleName || '',
        lastName: primaryUser.lastName,
        suffix: primaryUser.suffix || '',
        email: primaryUser.email,
        phoneNumber: primaryUser.phoneNumber,
        position: primaryUser.position,
        otherPosition: primaryUser.otherPosition || '',
        emailVerified: primaryUser.emailVerified,
      }
    : null,
});

export const list = asyncHandler(async (req, res) => {
  const status = ['PENDING', 'VERIFIED', 'REJECTED'].includes(String(req.query.status || '').toUpperCase())
    ? String(req.query.status).toUpperCase()
    : null;

  const filter = status ? { verificationStatus: status } : {};
  const companies = await ClientCompany.find(filter).sort({ updatedAt: -1 }).lean();
  const ids = companies.map((company) => company._id);
  const users = ids.length
    ? await ClientUser.find({ company: { $in: ids } }).sort({ createdAt: 1 }).lean()
    : [];

  const primaryByCompany = new Map();
  for (const user of users) {
    const key = String(user.company);
    if (!primaryByCompany.has(key)) primaryByCompany.set(key, user);
  }

  const items = companies.map((company) => serializeCompany(company, primaryByCompany.get(String(company._id))));
  const counts = await ClientCompany.aggregate([
    { $group: { _id: '$verificationStatus', count: { $sum: 1 } } },
  ]);
  const summary = { total: 0, PENDING: 0, VERIFIED: 0, REJECTED: 0 };
  for (const row of counts) {
    summary[row._id] = row.count;
    summary.total += row.count;
  }

  ok(res, { items, summary });
});

export const detail = asyncHandler(async (req, res) => {
  const company = await ClientCompany.findById(req.params.id).lean();
  if (!company) throw new AppError('Company not found.', 404);

  const users = await ClientUser.find({ company: company._id }).sort({ createdAt: 1 }).lean();
  const history = await VerificationHistory.find({ company: company._id }).sort({ createdAt: -1 }).lean();

  ok(res, {
    company: {
      ...serializeCompany(company, users[0]),
      documents: (company.documents || []).map((document) => ({
        id: String(document._id),
        type: document.type,
        name: document.name,
        mimeType: document.mimeType,
        size: document.size,
      })),
    },
    users: users.map((user) => ({
      id: String(user._id),
      firstName: user.firstName,
      middleName: user.middleName || '',
      lastName: user.lastName,
      suffix: user.suffix || '',
      email: user.email,
      phoneNumber: user.phoneNumber,
      position: user.position,
      otherPosition: user.otherPosition || '',
      emailVerified: user.emailVerified,
      createdAt: user.createdAt,
    })),
    history: history.map((item) => ({
      id: String(item._id),
      status: item.status,
      reason: item.reason || '',
      actionByType: item.actionByType,
      actionBy: item.actionBy || '',
      createdAt: item.createdAt,
    })),
  });
});

export const document = asyncHandler(async (req, res) => {
  const company = await ClientCompany.findById(req.params.id);
  if (!company) throw new AppError('Company not found.', 404);
  const item = company.documents.id(req.params.documentId);
  if (!item) throw new AppError('Document not found.', 404);

  const filePath = path.resolve('uploads/client-verification', item.storedName);
  if (!fs.existsSync(filePath)) throw new AppError('File not found.', 404);

  res.type(item.mimeType || 'application/octet-stream');
  res.setHeader('Content-Disposition', `inline; filename="${String(item.name || 'document').replace(/"/g, '')}"`);
  res.sendFile(filePath);
});

export const approve = asyncHandler(async (req, res) => {
  const company = await ClientCompany.findById(req.params.id);
  if (!company) throw new AppError('Company not found.', 404);
  if (company.verificationStatus === 'VERIFIED') {
    return ok(res, { company: serializeCompany(company) }, 'Company is already verified.');
  }

  company.verificationStatus = 'VERIFIED';
  company.rejectionReason = null;
  company.verifiedAt = new Date();
  company.verifiedBy = String(req.admin._id);
  await company.save();

  await VerificationHistory.create({
    company: company._id,
    status: 'VERIFIED',
    reason: 'Approved',
    actionByType: 'ADMIN',
    actionBy: String(req.admin._id),
  });

  const users = await ClientUser.find({ company: company._id });
  for (const user of users) {
    await createNotification({
      user: user._id,
      company: company._id,
      audience: 'CLIENT',
      type: 'VERIFICATION_APPROVED',
      title: 'Company Verified',
      message: 'Your company account has been approved.',
    });
    try {
      await sendApproved(user.email);
    } catch (error) {
      console.error(`Verification approval email failed for ${user.email}:`, error.message);
    }
  }

  const payload = serializeCompany(company, users[0]);
  getIO()?.to(`company:${company._id}`).emit('client:verification:approved', {
    companyId: String(company._id),
    status: 'VERIFIED',
    verifiedAt: company.verifiedAt,
  });
  getIO()?.to(`company:${company._id}`).emit('client:verification:updated', {
    companyId: String(company._id),
    status: 'VERIFIED',
    updatedAt: company.updatedAt,
  });
  emitToAdminModule(MODULES.CLIENT_VERIFICATION, 'admin:client-verification:updated', payload);

  ok(res, { company: payload }, 'Company approved.');
});

export const reject = asyncHandler(async (req, res) => {
  const reason = String(req.body.reason || '').trim();
  if (!reason) throw new AppError('Rejection reason is required.', 400);

  const company = await ClientCompany.findById(req.params.id);
  if (!company) throw new AppError('Company not found.', 404);

  company.verificationStatus = 'REJECTED';
  company.rejectionReason = reason;
  company.verifiedAt = null;
  company.verifiedBy = null;
  await company.save();

  await VerificationHistory.create({
    company: company._id,
    status: 'REJECTED',
    reason,
    actionByType: 'ADMIN',
    actionBy: String(req.admin._id),
  });

  const users = await ClientUser.find({ company: company._id });
  for (const user of users) {
    await createNotification({
      user: user._id,
      company: company._id,
      audience: 'CLIENT',
      type: 'VERIFICATION_REJECTED',
      title: 'Verification Requires Attention',
      message: reason,
    });
    try {
      await sendRejected(user.email, reason);
    } catch (error) {
      console.error(`Verification rejection email failed for ${user.email}:`, error.message);
    }
  }

  const payload = serializeCompany(company, users[0]);
  getIO()?.to(`company:${company._id}`).emit('client:verification:rejected', {
    companyId: String(company._id),
    status: 'REJECTED',
    reason,
    updatedAt: company.updatedAt,
  });
  getIO()?.to(`company:${company._id}`).emit('client:verification:updated', {
    companyId: String(company._id),
    status: 'REJECTED',
    updatedAt: company.updatedAt,
  });
  emitToAdminModule(MODULES.CLIENT_VERIFICATION, 'admin:client-verification:updated', payload);

  ok(res, { company: payload }, 'Company rejected.');
});
