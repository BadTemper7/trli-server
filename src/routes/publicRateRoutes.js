import { Router } from 'express';
import Rate from '../models/Rate.js';
import { asyncHandler } from '../utils/http.js';

const router = Router();

router.get('/', asyncHandler(async (req, res) => {
  const filter = { status: 'ACTIVE' };

  const classification = String(req.query.classification || '').trim().toUpperCase();
  if (['LOCAL', 'INTERNATIONAL'].includes(classification)) filter.classification = classification;

  const loadStatus = String(req.query.loadStatus || '').trim().toUpperCase();
  if (['EMPTY', 'LOADED'].includes(loadStatus)) filter.loadStatus = loadStatus;

  const containerSize = String(req.query.containerSize || '').trim().toUpperCase();
  if (['ALL', '20FT', '40FT'].includes(containerSize)) filter.containerSize = containerSize;

  const rows = await Rate.find(filter)
    .select('name classification loadStatus containerSize amount collectionPoint description updatedAt')
    .sort({ classification: 1, name: 1, loadStatus: 1, containerSize: 1, amount: 1 })
    .lean();

  const data = rows.map((rate) => ({
    id: String(rate._id),
    name: rate.name,
    classification: rate.classification,
    loadStatus: rate.loadStatus,
    containerSize: rate.containerSize,
    amount: rate.amount,
    collectionPoint: rate.collectionPoint,
    description: rate.description || '',
    updatedAt: rate.updatedAt,
  }));

  res.json({ success: true, message: 'Active rates loaded.', data });
}));

export default router;
