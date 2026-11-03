import mongoose from 'mongoose';

const schema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'ClientUser', default: null },
  company: { type: mongoose.Schema.Types.ObjectId, ref: 'ClientCompany', default: null },
  audience: { type: String, enum: ['CLIENT', 'ADMIN'], required: true },
  module: { type: String, default: null },
  modules: [{ type: String }], // Optional multi-queue visibility for actionable alerts.
  type: { type: String, required: true },
  title: { type: String, required: true },
  message: { type: String, required: true },
  data: { type: mongoose.Schema.Types.Mixed, default: {} },
  isRead: { type: Boolean, default: false }, // Existing client-specific read state.
  adminReadBy: [{ type: mongoose.Schema.Types.ObjectId, ref: 'AdminUser' }],
}, { timestamps: true });

schema.index({ audience: 1, module: 1, createdAt: -1 });
schema.index({ audience: 1, modules: 1, createdAt: -1 });
schema.index({ audience: 1, createdAt: -1 });
export default mongoose.model('Notification', schema);
