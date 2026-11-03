import { Router } from 'express';
import { adminAuth, requirePasswordChanged } from '../middleware/adminAuth.js';
import { validateId } from '../middleware/validateId.js';
import {
  listAdminNotifications, readAdminNotification, readAllAdminNotifications,
} from '../controllers/adminNotificationController.js';

const router = Router();
router.use(adminAuth, requirePasswordChanged);
router.get('/', listAdminNotifications);
router.patch('/read-all', readAllAdminNotifications);
router.patch('/:id/read', validateId(), readAdminNotification);
export default router;
