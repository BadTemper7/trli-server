import { Router } from 'express';
import { ACTIONS, MODULES } from '../constants/permissions.js';
import { adminAuth, requirePasswordChanged } from '../middleware/adminAuth.js';
import { requirePermission } from '../middleware/requirePermission.js';
import { validateId } from '../middleware/validateId.js';
import { createRate, deleteRate, getRate, importRates, listRates, updateRate } from '../controllers/rateController.js';

const r = Router();
r.use(adminAuth, requirePasswordChanged);
r.get('/', requirePermission(MODULES.RATE_SETUP, ACTIONS.VIEW), listRates);
r.post('/import-local', requirePermission(MODULES.RATE_SETUP, ACTIONS.CREATE), importRates);
r.post('/', requirePermission(MODULES.RATE_SETUP, ACTIONS.CREATE), createRate);
r.get('/:id', validateId(), requirePermission(MODULES.RATE_SETUP, ACTIONS.VIEW), getRate);
r.put('/:id', validateId(), requirePermission(MODULES.RATE_SETUP, ACTIONS.EDIT), updateRate);
r.delete('/:id', validateId(), requirePermission(MODULES.RATE_SETUP, ACTIONS.DELETE), deleteRate);
export default r;
