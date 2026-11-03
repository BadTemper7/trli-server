import Notification from '../models/Notification.js';
import { adminNotificationFilter } from '../services/notificationRouting.js';
import { getIO } from '../socket/index.js';
import { asyncHandler, ok, AppError } from '../utils/http.js';
import { listDocuments } from '../utils/tableQuery.js';

const toPublic = (item, userId) => ({
  _id: String(item._id),
  type: item.type, title: item.title, message: item.message,
  module: item.module, data: item.data, createdAt: item.createdAt,
  isRead: (item.adminReadBy || []).some(id => String(id) === String(userId)),
});

export const listAdminNotifications = asyncHandler(async (req, res) => {
  const filter = adminNotificationFilter(req.admin);
  const [{ items, pagination }, unread] = await Promise.all([
    listDocuments(Notification, filter, req.query, { defaultLimit: 30, maxLimit: 100,
      sorts: ['createdAt', '_id'], select: 'type title message module data adminReadBy createdAt' }),
    Notification.countDocuments({ $and: [filter, { adminReadBy: { $ne: req.admin._id } }] }),
  ]);
  res.set('Cache-Control', 'private, no-store');
  ok(res, { items: items.map(item => toPublic(item, req.admin._id)), unread,
    pagination: { ...pagination, totalPages: pagination.totalPages ?? null } });
});

export const readAdminNotification = asyncHandler(async (req, res) => {
  const filter = adminNotificationFilter(req.admin);
  const item = await Notification.findOneAndUpdate({ $and: [filter, { _id: req.params.id }] },
    { $addToSet: { adminReadBy: req.admin._id } }, { new: true }).lean();
  if (!item) throw new AppError('Notification not found or access denied.', 404);
  getIO()?.to(`admin-user:${req.admin._id}`).emit('notification:read', { id: String(item._id) });
  ok(res, { item: toPublic(item, req.admin._id) }, 'Notification marked as read.');
});

export const readAllAdminNotifications = asyncHandler(async (req, res) => {
  const filter = adminNotificationFilter(req.admin);
  await Notification.updateMany({ $and: [filter, { adminReadBy: { $ne: req.admin._id } }] },
    { $addToSet: { adminReadBy: req.admin._id } });
  getIO()?.to(`admin-user:${req.admin._id}`).emit('notification:read-all', {});
  ok(res, {}, 'Notifications marked as read.');
});
