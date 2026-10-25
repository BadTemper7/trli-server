import { AppError } from '../utils/http.js';

export function hasPermission(user, moduleName, action = 'VIEW') {
  if (!user) return false;
  if (user.role === 'SUPER_ADMIN') return true;
  return user.permissions?.some((p) => p.module === moduleName && p.actions?.includes(action));
}

export function requirePermission(moduleName, action = 'VIEW') {
  return (req, res, next) => {
    if (hasPermission(req.admin, moduleName, action)) return next();
    return next(new AppError(action === 'VIEW' ? 'You do not have access to this module.' : 'You do not have permission to perform this action.', 403));
  };
}
