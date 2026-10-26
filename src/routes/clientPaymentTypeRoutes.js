import {Router} from 'express';
import {auth} from '../middleware/auth.js';
import {listActivePaymentTypes} from '../controllers/paymentTypeController.js';
const router=Router();
router.use(auth);
router.get('/active',listActivePaymentTypes);
export default router;
