import jwt from 'jsonwebtoken';
import AdminUser from '../models/AdminUser.js';
import { AppError, asyncHandler } from '../utils/http.js';

const secret = () => process.env.ADMIN_JWT_SECRET || process.env.JWT_SECRET;

export const adminAuth = asyncHandler(async (req, res, next) => {
  const token = req.cookies?.adminToken || req.headers.authorization?.replace(/^Bearer\s+/i, '');
  if (!token) throw new AppError('Admin authentication required.', 401);
  let payload;
  try { payload = jwt.verify(token, secret()); } catch { throw new AppError('Admin session is invalid or expired.', 401); }
  if (payload.type !== 'admin') throw new AppError('Admin authentication required.', 401);
  const admin = await AdminUser.findById(payload.sub);
  if (!admin || admin.status !== 'ACTIVE' || Number(payload.tv || 0) !== Number(admin.tokenVersion || 0)) {
    throw new AppError('Admin session is no longer valid.', 401);
  }
  req.admin = admin;
  next();
});

export function requirePasswordChanged(req, res, next) {
  if (req.admin?.mustChangePassword) {
    return res.status(403).json({ success:false, code:'PASSWORD_CHANGE_REQUIRED', message:'You must create a new password before accessing the system.', errors:[] });
  }
  next();
}
