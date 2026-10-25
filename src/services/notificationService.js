import Notification from '../models/Notification.js';
import { getIO, emitToAdminModule } from '../socket/index.js';
import { MODULES } from '../constants/permissions.js';

const adminModuleForType = (type = '') => {
  if (type.startsWith('VERIFICATION_')) return MODULES.CLIENT_VERIFICATION;
  if (type.startsWith('PRE_ADVICE_')) return MODULES.PRE_ADVICE;
  return MODULES.DASHBOARD;
};

export async function createNotification({ user = null, company = null, audience, type, title, message, data = {} }) {
  const n = await Notification.create({ user, company, audience, type, title, message, data });
  const io = getIO();
  if (audience === 'ADMIN') emitToAdminModule(adminModuleForType(type), 'notification:new', n);
  else if (user) io?.to(`client:${user}`).emit('notification:new', n);
  else if (company) io?.to(`company:${company}`).emit('notification:new', n);
  return n;
}
