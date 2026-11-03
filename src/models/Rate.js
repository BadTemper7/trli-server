import mongoose from 'mongoose';

export const RATE_NAMES = [
  'Gate-in Handling',
  'Gate-out Handling',
  'Shifting Fee',
  'Documentation Fee',
  'Overtime',
  'Lift On',
  'Lift Off',
  'Storage',
  'Congestion Surcharge',
  'Total Handling Reference',
  'Other',
];

const schema = new mongoose.Schema({
  name: { type: String, enum: RATE_NAMES, required: true, trim: true, index: true },
  classification: { type: String, enum: ['LOCAL', 'INTERNATIONAL', 'ALL'], required: true, index: true },
  containerCategory:{type:String,enum:['STANDARD','REEFER','ALL'],default:'STANDARD'},
  taxTreatment:{type:String,enum:['TAXABLE','EXEMPT','ZERO_RATED'],default:'TAXABLE'},
  loadStatus: { type: String, enum: ['EMPTY', 'LOADED', 'ALL'], required: true, index: true },
  containerSize: { type: String, enum: ['ALL', '20FT', '40FT'], default: 'ALL', index: true },
  amount: { type: Number, required: true, min: 0 },
  pricingMode: { type:String, enum:['FIXED','MANUAL'], default:'FIXED' },
  allocationMode: { type:String, enum:['PERCENTAGE','FIXED'], default:'PERCENTAGE' },
  gateInAllocation: { type:Number, default:50, min:0 },
  gateOutAllocation: { type:Number, default:50, min:0 },
  billingMode: {type:String,enum:['AUTOMATIC','OPTIONAL'],default:'AUTOMATIC'},
  collectionPoint: { type: String, enum: ['GATE_IN', 'GATE_OUT', 'BOTH'], required: true, index: true },
  status: { type: String, enum: ['ACTIVE', 'INACTIVE'], default: 'ACTIVE', index: true },
  effectiveFrom: {type:Date,default:null},
  description: { type: String, trim: true, default: '', maxlength: 500 },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'AdminUser', default: null },
  updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'AdminUser', default: null },
}, { timestamps: true });

schema.pre('validate', function(next) {
  if (this.name !== 'Overtime' && (this.classification === 'ALL' || this.loadStatus === 'ALL' || this.containerCategory === 'ALL')) {
    return next(new Error('Universal rate scopes are reserved for Overtime.'));
  }
  if (this.pricingMode === 'FIXED' && !(this.amount > 0)) return next(new Error('Fixed rates require a positive amount.'));
  if (this.collectionPoint === 'BOTH') {
    const sum = Number(this.gateInAllocation) + Number(this.gateOutAllocation);
    const target = this.allocationMode === 'FIXED' ? Number(this.amount) : 100;
    if (!Number.isFinite(sum) || Math.abs(Math.round(sum*100)-Math.round(target*100))>0 || this.gateInAllocation<0 || this.gateOutAllocation<0) return next(new Error('Both-stage allocations must add up to 100% or the configured fixed rate.'));
    if(this.allocationMode==='FIXED' && this.pricingMode==='MANUAL') return next(new Error('Manual rates must use percentage allocations.'));
  }
  next();
});
schema.index({ name: 1, classification: 1, loadStatus: 1, containerCategory:1,containerSize: 1, collectionPoint: 1 },{unique:true,partialFilterExpression:{status:'ACTIVE'},name:'unique_active_rate_per_classification'});

export default mongoose.model('Rate', schema);
