import mongoose from 'mongoose';

export const RATE_NAMES = [
  'Lift On',
  'Lift Off',
  'Storage',
  'Congestion Surcharge',
  'Total Handling Reference',
  'Other',
];

const schema = new mongoose.Schema({
  name: { type: String, enum: RATE_NAMES, required: true, trim: true, index: true },
  classification: { type: String, enum: ['LOCAL', 'INTERNATIONAL'], required: true, index: true },
  loadStatus: { type: String, enum: ['EMPTY', 'LOADED'], required: true, index: true },
  containerSize: { type: String, enum: ['ALL', '20FT', '40FT'], default: 'ALL', index: true },
  amount: { type: Number, required: true, min: 0.01 },
  collectionPoint: { type: String, enum: ['GATE_IN', 'GATE_OUT'], required: true, index: true },
  status: { type: String, enum: ['ACTIVE', 'INACTIVE'], default: 'ACTIVE', index: true },
  description: { type: String, trim: true, default: '', maxlength: 500 },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'AdminUser', default: null },
  updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'AdminUser', default: null },
}, { timestamps: true });

schema.index({ name: 1, classification: 1, loadStatus: 1, containerSize: 1, collectionPoint: 1 });

export default mongoose.model('Rate', schema);
