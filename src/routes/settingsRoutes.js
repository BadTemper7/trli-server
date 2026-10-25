import { Router } from 'express';
import { ACTIONS, MODULES } from '../constants/permissions.js';
import { adminAuth, requirePasswordChanged } from '../middleware/adminAuth.js';
import { requirePermission } from '../middleware/requirePermission.js';
import { getAdminCompanySettings, updateCompanySettings } from '../controllers/settingsController.js';

const router = Router();
router.use(adminAuth, requirePasswordChanged);
router.get('/company-contact', requirePermission(MODULES.SETTINGS, ACTIONS.VIEW), getAdminCompanySettings);
router.put('/company-contact', requirePermission(MODULES.SETTINGS, ACTIONS.EDIT), updateCompanySettings);
export default router;
