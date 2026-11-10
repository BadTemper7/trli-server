import { Router } from 'express';
import {downloadGateInPass,downloadGateOutPass,downloadReleasePass,downloadOperationalInvoice} from '../controllers/printableController.js';
import { adminAuth, requirePasswordChanged } from '../middleware/adminAuth.js';
import { requirePermission } from '../middleware/requirePermission.js';
import { validateId } from '../middleware/validateId.js';
import { MODULES, ACTIONS } from '../constants/permissions.js';
import {
  listAdminPreAdvice, getAdminPreAdvice, approvePreAdvice, rejectPreAdvice,
  listGateIn, inspectGateIn, submitGateInPayment, cancelGateInPayment, processGateIn,
  listInventory, updateInventory, updateInventoryBySource,
  listGateOut, requestGateOut, submitGateOutPayment, approveGateOut,
  listRelease, releaseContainer, operationSummary,
} from '../controllers/operationsController.js';

const router = Router();
router.use(adminAuth, requirePasswordChanged);

router.get('/pre-advice', requirePermission(MODULES.PRE_ADVICE, ACTIONS.VIEW), listAdminPreAdvice);
router.get('/pre-advice/summary', requirePermission(MODULES.PRE_ADVICE, ACTIONS.VIEW), (req,res,next)=>{req.params.resource='pre-advice';return operationSummary(req,res,next);});
router.get('/pre-advice/:id', validateId(), requirePermission(MODULES.PRE_ADVICE, ACTIONS.VIEW), getAdminPreAdvice);
router.post('/pre-advice/:id/approve', validateId(), requirePermission(MODULES.PRE_ADVICE, ACTIONS.EDIT), approvePreAdvice);
router.post('/pre-advice/:id/reject', validateId(), requirePermission(MODULES.PRE_ADVICE, ACTIONS.EDIT), rejectPreAdvice);

router.get('/gate-in', requirePermission(MODULES.GATE_IN, ACTIONS.VIEW), listGateIn);
router.get('/gate-in/summary', requirePermission(MODULES.GATE_IN, ACTIONS.VIEW), (req,res,next)=>{req.params.resource='gate-in';return operationSummary(req,res,next);});
router.get('/gate-in/:id/pass',validateId(),requirePermission(MODULES.GATE_IN,ACTIONS.VIEW),downloadGateInPass);
router.get('/gate-in/:id/invoice',validateId(),requirePermission(MODULES.GATE_IN,ACTIONS.VIEW),(req,res,next)=>{req.params.type='gate-in';return downloadOperationalInvoice(req,res,next);});
router.post('/gate-in/:id/inspection', validateId(), requirePermission(MODULES.GATE_IN, ACTIONS.PROCESS), inspectGateIn);


router.post('/gate-in/:id/process', validateId(), requirePermission(MODULES.GATE_IN, ACTIONS.PROCESS), processGateIn);

router.get('/inventory', requirePermission(MODULES.INVENTORY, ACTIONS.VIEW), listInventory);
router.get('/inventory/summary', requirePermission(MODULES.INVENTORY, ACTIONS.VIEW), (req,res,next)=>{req.params.resource='inventory';return operationSummary(req,res,next);});
router.put('/inventory/:source/:id', validateId(), requirePermission(MODULES.INVENTORY, ACTIONS.EDIT), updateInventoryBySource);
router.put('/inventory/:id', validateId(), requirePermission(MODULES.INVENTORY, ACTIONS.EDIT), updateInventory);

router.get('/gate-out', requirePermission(MODULES.GATE_OUT, ACTIONS.VIEW), listGateOut);
router.get('/gate-out/summary', requirePermission(MODULES.GATE_OUT, ACTIONS.VIEW), (req,res,next)=>{req.params.resource='gate-out';return operationSummary(req,res,next);});
router.get('/gate-out/:id/pass',validateId(),requirePermission(MODULES.GATE_OUT,ACTIONS.VIEW),downloadGateOutPass);
router.get('/gate-out/:id/invoice',validateId(),requirePermission(MODULES.GATE_OUT,ACTIONS.VIEW),(req,res,next)=>{req.params.type='gate-out';return downloadOperationalInvoice(req,res,next);});




router.get('/release', requirePermission(MODULES.RELEASE_CONTAINER, ACTIONS.VIEW), listRelease);
router.get('/release/summary', requirePermission(MODULES.RELEASE_CONTAINER, ACTIONS.VIEW), (req,res,next)=>{req.params.resource='release';return operationSummary(req,res,next);});
router.get('/release/:id/pass',validateId(),requirePermission(MODULES.RELEASE_CONTAINER,ACTIONS.VIEW),downloadReleasePass);
router.get('/release/:id/invoice',validateId(),requirePermission(MODULES.RELEASE_CONTAINER,ACTIONS.VIEW),(req,res,next)=>{req.params.type='gate-out';return downloadOperationalInvoice(req,res,next);});
router.post('/release/:id', validateId(), requirePermission(MODULES.RELEASE_CONTAINER, ACTIONS.PROCESS), releaseContainer);

export default router;
