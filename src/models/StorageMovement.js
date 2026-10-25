import mongoose from 'mongoose';

const positionSchema = new mongoose.Schema({
  block: { type: mongoose.Schema.Types.ObjectId, ref: 'StorageBlock', default: null },
  bay: { type: Number, default: null },
  row: { type: Number, default: null },
  tier: { type: Number, default: null },
}, { _id: false });

const schema = new mongoose.Schema({
  container: { type: mongoose.Schema.Types.ObjectId, ref: 'PreAdvice', required: true, index: true },
  action: { type: String, enum: ['ASSIGNED', 'RELOCATED', 'REMOVED'], required: true },
  from: { type: positionSchema, default: () => ({}) },
  to: { type: positionSchema, default: () => ({}) },
  performedBy: { type: String, required: true },
  performedAt: { type: Date, default: Date.now },
}, { timestamps: false });

export default mongoose.model('StorageMovement', schema);
