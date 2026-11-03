import mongoose from 'mongoose';

const schema = new mongoose.Schema({
  performedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'AdminUser', default: null, index: true },
  targetUser: { type: mongoose.Schema.Types.ObjectId, ref: 'AdminUser', default: null, index: true },
  action: { type: String, required: true, index: true },
  changes: { type: mongoose.Schema.Types.Mixed, default: {} },
  createdAt: { type: Date, default: Date.now, index: true },
});

schema.index({createdAt:-1,_id:-1},{name:'idx_audit_cursor'});
schema.index({action:1,createdAt:-1,_id:-1},{name:'idx_audit_action_cursor'});

export default mongoose.model('AdminAuditLog', schema);
