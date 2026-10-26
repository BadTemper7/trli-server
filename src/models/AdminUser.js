import mongoose from 'mongoose';

const permissionSchema = new mongoose.Schema({
  module: { type: String, required: true },
  actions: [{ type: String, required: true }],
}, { _id: false });

const schema = new mongoose.Schema({
  firstName: { type: String, required: true, trim: true },
  middleName: { type: String, default: '', trim: true },
  lastName: { type: String, required: true, trim: true },
  suffix: { type: String, default: '', trim: true },
  email: { type: String, required: true, unique: true, lowercase: true, trim: true, index: true },
  phoneNumber: { type: String, default: '', trim: true },
  position: { type: String, default: '', trim: true },
  passwordHash: { type: String, required: true, select: false },
  role: { type: String, enum: ['SUPER_ADMIN','ADMIN_USER'], default: 'ADMIN_USER', index: true },
  isSystemProtected: { type:Boolean, default:false, immutable:true },
  status: { type: String, enum: ['ACTIVE','INACTIVE'], default: 'ACTIVE', index: true },
  permissions: { type: [permissionSchema], default: [] },
  mustChangePassword: { type: Boolean, default: true },
  temporaryPasswordExpiresAt: { type: Date, default: null },
  passwordChangedAt: { type: Date, default: null },
  lastLoginAt: { type: Date, default: null },
  tokenVersion: { type: Number, default: 0 },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'AdminUser', default: null },
  updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'AdminUser', default: null },
}, { timestamps: true });

schema.index({isSystemProtected:1},{unique:true,partialFilterExpression:{isSystemProtected:true},name:'one_protected_system_admin'});

schema.methods.toSafeObject = function toSafeObject() {
  const obj = this.toObject();
  delete obj.passwordHash;
  return obj;
};

export default mongoose.model('AdminUser', schema);
