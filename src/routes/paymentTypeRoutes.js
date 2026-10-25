import { Router } from 'express';
import { ACTIONS, MODULES } from '../constants/permissions.js';
import { adminAuth, requirePasswordChanged } from '../middleware/adminAuth.js';
import { requirePermission } from '../middleware/requirePermission.js';
import { validateId } from '../middleware/validateId.js';
import { createPaymentType, deletePaymentType, listActivePaymentTypes, listPaymentTypes, updatePaymentType } from '../controllers/paymentTypeController.js';

const r = Router();
r.use(adminAuth, requirePasswordChanged);
r.get('/active', listActivePaymentTypes);
r.get('/', requirePermission(MODULES.PAYMENT_TYPES, ACTIONS.VIEW), listPaymentTypes);
r.post('/', requirePermission(MODULES.PAYMENT_TYPES, ACTIONS.CREATE), createPaymentType);
r.put('/:id', validateId(), requirePermission(MODULES.PAYMENT_TYPES, ACTIONS.EDIT), updatePaymentType);
r.delete('/:id', validateId(), requirePermission(MODULES.PAYMENT_TYPES, ACTIONS.DELETE), deletePaymentType);
export default r;
