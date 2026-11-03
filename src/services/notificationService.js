import Notification from '../models/Notification.js';
import { getIO } from '../socket/index.js';
import { notificationModuleForType, notificationModulesForType } from './notificationRouting.js';

/** Write first, then emit. Websocket delivery is best-effort; database remains source of truth. */
export async function createNotification({ user = null, company = null, audience, type, title, message, data = {}, module = null, modules = null }) {
  const targets = audience === 'ADMIN' ? [...new Set(
    (Array.isArray(modules) && modules.length ? modules : module ? [module] : notificationModulesForType(type)).filter(Boolean)
  )] : [];
  const targetModule = audience === 'ADMIN' ? (module || targets[0] || notificationModuleForType(type)) : null;
  const notification = await Notification.create({
    user, company, audience, type, title, message, data,
    module: targetModule, modules: targets,
  });
  const io = getIO();
  try {
    if (audience === 'ADMIN' && targets.length) {
      // Socket.IO joins the selected rooms as a set, so admins with multiple
      // permissions receive this notification just once.
      io?.to(targets.map(name => `admin-module:${name}`)).emit('notification:new', {
        _id: String(notification._id), type: notification.type, title: notification.title,
        message: notification.message, module: targetModule, modules: targets,
        data: notification.data, createdAt: notification.createdAt, isRead: false,
      });
    } else if (audience === 'CLIENT' && user) {
      io?.to(`client:${user}`).emit('notification:new', notification);
    } else if (audience === 'CLIENT' && company) {
      io?.to(`company:${company}`).emit('notification:new', notification);
    }
  } catch (error) {
    console.error('[NOTIFICATION_SOCKET_FAILED]', { type, message: error?.message });
  }
  return notification;
}
