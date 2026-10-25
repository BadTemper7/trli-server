import mongoose from 'mongoose';

const schema = new mongoose.Schema({
  performedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'AdminUser', default: null, index: true },
  targetUser: { type: mongoose.Schema.Types.ObjectId, ref: 'AdminUser', default: null, index: true },
  action: { type: String, required: true, index: true },
  changes: { type: mongoose.Schema.Types.Mixed, default: {} },
  createdAt: { type: Date, default: Date.now, index: true },
});

export default mongoose.model('AdminAuditLog', schema);
