import { Router } from 'express';
import { adminAuth, requirePasswordChanged } from '../middleware/adminAuth.js';
import { requirePermission } from '../middleware/requirePermission.js';
import { validateId } from '../middleware/validateId.js';
import { MODULES, ACTIONS } from '../constants/permissions.js';
import {
  listAdminPreAdvice, getAdminPreAdvice, approvePreAdvice, rejectPreAdvice,
  listGateIn, inspectGateIn, submitGateInPayment, cancelGateInPayment, processGateIn,
  listInventory, updateInventory,
  listGateOut, requestGateOut, submitGateOutPayment, approveGateOut,
  listRelease, releaseContainer,
} from '../controllers/operationsController.js';

const router = Router();
router.use(adminAuth, requirePasswordChanged);

router.get('/pre-advice', requirePermission(MODULES.PRE_ADVICE, ACTIONS.VIEW), listAdminPreAdvice);
router.get('/pre-advice/:id', validateId(), requirePermission(MODULES.PRE_ADVICE, ACTIONS.VIEW), getAdminPreAdvice);
router.post('/pre-advice/:id/approve', validateId(), requirePermission(MODULES.PRE_ADVICE, ACTIONS.EDIT), approvePreAdvice);
router.post('/pre-advice/:id/reject', validateId(), requirePermission(MODULES.PRE_ADVICE, ACTIONS.EDIT), rejectPreAdvice);

router.get('/gate-in', requirePermission(MODULES.GATE_IN, ACTIONS.VIEW), listGateIn);
router.post('/gate-in/:id/inspection', validateId(), requirePermission(MODULES.GATE_IN, ACTIONS.PROCESS), inspectGateIn);


router.post('/gate-in/:id/process', validateId(), requirePermission(MODULES.GATE_IN, ACTIONS.PROCESS), processGateIn);

router.get('/inventory', requirePermission(MODULES.INVENTORY, ACTIONS.VIEW), listInventory);
router.put('/inventory/:id', validateId(), requirePermission(MODULES.INVENTORY, ACTIONS.EDIT), updateInventory);

router.get('/gate-out', requirePermission(MODULES.GATE_OUT, ACTIONS.VIEW), listGateOut);




router.get('/release', requirePermission(MODULES.RELEASE_CONTAINER, ACTIONS.VIEW), listRelease);
router.post('/release/:id', validateId(), requirePermission(MODULES.RELEASE_CONTAINER, ACTIONS.PROCESS), releaseContainer);

export default router;
