import mongoose from 'mongoose';

const schema = new mongoose.Schema({
  key: { type: String, required: true, unique: true, default: 'COMPANY_CONTACT' },
  phone: { type: String, default: '', trim: true },
  email: { type: String, default: '', trim: true, lowercase: true },
  office: { type: String, default: '', trim: true },
  operatingHours: { type: String, default: '', trim: true },
  updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'AdminUser', default: null },
}, { timestamps: true });

export default mongoose.model('SiteSettings', schema);
