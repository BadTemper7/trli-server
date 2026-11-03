import {Router} from 'express';
import {adminAuth,requirePasswordChanged} from '../middleware/adminAuth.js';
import {requirePermission} from '../middleware/requirePermission.js';
import {MODULES,ACTIONS} from '../constants/permissions.js';
import {deleteRecords,auditLogs} from '../controllers/bulkDeletionController.js';
const router=Router();router.use(adminAuth,requirePasswordChanged);
// The handler checks the selected module's DELETE permission. No other role,
// including an authenticated admin without DELETE, can invoke this endpoint.
router.post('/delete',deleteRecords);
router.get('/audit-logs',requirePermission(MODULES.AUDIT_LOGS,ACTIONS.VIEW),auditLogs);
export default router;
