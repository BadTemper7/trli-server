import { Router } from 'express';
import { getPublicCompanySettings } from '../controllers/settingsController.js';

const router = Router();
router.get('/company-contact', getPublicCompanySettings);
export default router;
