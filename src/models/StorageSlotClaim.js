import mongoose from 'mongoose';

// Single collection arbitrates physical slots for LIVE and HISTORICAL containers.
// Independent unique indexes on PreAdvice and HistoricalContainer cannot do this.
const schema = new mongoose.Schema({
  block: { type: mongoose.Schema.Types.ObjectId, ref: 'StorageBlock', required: true },
  bay: { type: Number, required: true, min: 1 },
  row: { type: Number, required: true, min: 1 },
  tier: { type: Number, required: true, min: 1 },
  source: { type: String, enum: ['LIVE', 'HISTORICAL'], required: true },
  container: { type: mongoose.Schema.Types.ObjectId, required: true },
  assignedAt: { type: Date, default: Date.now },
}, { timestamps: true });
schema.index({ block: 1, bay: 1, row: 1, tier: 1 }, { name: 'unique_storage_slot_cross_source', unique: true });
schema.index({ source: 1, container: 1 }, { name: 'unique_active_container_claim', unique: true });
export default mongoose.model('StorageSlotClaim', schema);
