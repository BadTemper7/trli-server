import mongoose from 'mongoose';

const schema = new mongoose.Schema({
  name: { type: String, required: true, unique: true, trim: true, uppercase: true },
  capacityTeu: { type: Number, required: true, min: 1 },
  containerSize: { type: String, enum: ['20FT', '40FT'], required: true },
  status: { type: String, enum: ['ACTIVE', 'INACTIVE', 'MAINTENANCE', 'FULL'], default: 'ACTIVE' },
  color: { type: String, required: true, match: /^#[0-9A-F]{6}$/i },
  layout: {
    bays: { type: Number, required: true, min: 1, max: 100 },
    rows: { type: Number, required: true, min: 1, max: 20 },
    tiers: { type: Number, required: true, min: 1, max: 10 },
  },
  createdBy: { type: String, default: 'external-admin' },
  updatedBy: { type: String, default: 'external-admin' },
}, { timestamps: true });

export default mongoose.model('StorageBlock', schema);
