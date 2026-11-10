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

// Preserve a tamper-resistant append-only audit trail at the application layer.
for (const method of ['updateOne','updateMany','findOneAndUpdate','deleteOne','deleteMany','findOneAndDelete','findOneAndReplace','replaceOne']) {
  schema.pre(method, function(){ throw new Error('Audit log entries are immutable.'); });
}
schema.pre('save', function(){ if(!this.isNew)throw new Error('Audit log entries are immutable.'); });
export default mongoose.model('AdminAuditLog', schema);
