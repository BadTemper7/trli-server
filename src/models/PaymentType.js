import mongoose from 'mongoose';

// `code` is a method category, not an account identifier. Multiple BANK and
// E_WALLET receiving accounts may coexist; the document _id identifies one.
export const PAYMENT_TYPE_CODES = ['CASH', 'BANK', 'GCASH', 'MAYA', 'E_WALLET'];

const schema = new mongoose.Schema({
  code: { type: String, enum: PAYMENT_TYPE_CODES, required: true },
  name: { type: String, required: true, trim: true, maxlength: 80 },
  status: { type: String, enum: ['ACTIVE', 'INACTIVE'], default: 'ACTIVE', index: true },
  requiresReference: { type: Boolean, default: true },
  description: { type: String, trim: true, default: '', maxlength: 300 },
  bankName: { type: String, trim: true, default: '', maxlength: 120 },
  accountName: { type: String, trim: true, default: '', maxlength: 120 },
  accountNumber: { type: String, trim: true, default: '', maxlength: 120 },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'AdminUser', default: null },
  updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'AdminUser', default: null },
}, { timestamps: true });

schema.index({ code: 1, status: 1, name: 1 }, { name: 'idx_payment_type_category_status' });
// Cash is one built-in method; it can be enabled/disabled, never duplicated.
schema.index({ code: 1 }, {
  name: 'unique_cash_payment_type', unique: true,
  partialFilterExpression: { code: 'CASH' },
});
export default mongoose.model('PaymentType', schema);
