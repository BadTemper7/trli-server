import {Router} from 'express';
import {paymentProofUpload} from '../middleware/upload.js';
import {auth,requireVerified} from '../middleware/auth.js';
import {adminAuth,requirePasswordChanged} from '../middleware/adminAuth.js';
import {requirePermission} from '../middleware/requirePermission.js';
import {MODULES,ACTIONS} from '../constants/permissions.js';
import {requestClientGateOut,reviewClientGateOut,quoteClientGateOut,detailAdminGateOut,adminGateOutProof,adminGateOutPdf} from '../controllers/clientGateOutController.js';
export const clientGateOut=Router();clientGateOut.use(auth,requireVerified);clientGateOut.get('/:id/quote',quoteClientGateOut);clientGateOut.post('/:id/request',paymentProofUpload.single('proof'),requestClientGateOut);
export const adminGateOutReview=Router();adminGateOutReview.use(adminAuth,requirePasswordChanged);adminGateOutReview.get('/payments/:paymentId/proof',requirePermission(MODULES.GATE_OUT,ACTIONS.VIEW),adminGateOutProof);adminGateOutReview.get('/:id/invoice/pdf',requirePermission(MODULES.GATE_OUT,ACTIONS.VIEW),adminGateOutPdf);adminGateOutReview.get('/:id/receipt',requirePermission(MODULES.GATE_OUT,ACTIONS.VIEW),adminGateOutPdf);adminGateOutReview.get('/:id',requirePermission(MODULES.GATE_OUT,ACTIONS.VIEW),detailAdminGateOut);adminGateOutReview.post('/:id/review',requirePermission(MODULES.GATE_OUT,ACTIONS.PROCESS),reviewClientGateOut);
