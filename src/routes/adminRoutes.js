import { Router } from 'express';
import { adminAuth, requirePasswordChanged } from '../middleware/adminAuth.js';
import { requirePermission } from '../middleware/requirePermission.js';
import { MODULES, ACTIONS } from '../constants/permissions.js';
import { validateId } from '../middleware/validateId.js';
import { list, detail, document, approve, reject } from '../controllers/adminController.js';

const router = Router();
router.use(adminAuth, requirePasswordChanged);

router.get('/client-verifications', requirePermission(MODULES.CLIENT_VERIFICATION, ACTIONS.VIEW), list);
router.get('/client-verifications/:id', validateId(), requirePermission(MODULES.CLIENT_VERIFICATION, ACTIONS.VIEW), detail);
router.get('/client-verifications/:id/documents/:documentId', validateId(), validateId('documentId'), requirePermission(MODULES.CLIENT_VERIFICATION, ACTIONS.VIEW), document);
router.post('/client-verifications/:id/approve', validateId(), requirePermission(MODULES.CLIENT_VERIFICATION, ACTIONS.APPROVE), approve);
router.post('/client-verifications/:id/reject', validateId(), requirePermission(MODULES.CLIENT_VERIFICATION, ACTIONS.REJECT), reject);

export default router;
