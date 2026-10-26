import mongoose from 'mongoose';

export const PAYMENT_TYPE_CODES = ['CASH', 'BANK', 'GCASH', 'MAYA', 'E_WALLET'];

const schema = new mongoose.Schema({
  code: { type: String, enum: PAYMENT_TYPE_CODES, required: true, unique: true, index: true },
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

export default mongoose.model('PaymentType', schema);
