import mongoose from 'mongoose';

const schema = new mongoose.Schema({
  key: { type: String, required: true, unique: true, default: 'COMPANY_CONTACT' },
  phone: { type: String, default: '', trim: true },
  email: { type: String, default: '', trim: true, lowercase: true },
  office: { type: String, default: '', trim: true },
  operatingHours: { type: String, default: '24 hours daily', trim: true },
  schedule: { openingTime: {type:String,default:'00:00'}, closingTime: {type:String,default:'24:00'}, operatingDays:{type:[Number],default:[0,1,2,3,4,5,6]}, maxBookingsPerHour:{type:Number,default:4,min:1,max:100}, active:{type:Boolean,default:true} },
  shiftingFee:{type:Number,default:0,min:0},
  storageBilling: { rounding: {type:String,enum:['CALENDAR_DAYS','CEIL_24_HOURS'],default:'CALENDAR_DAYS'} },
  tax: { vatRate:{type:Number,default:12,min:0,max:100}, vatInclusive:{type:Boolean,default:false} },
  overtime: { start:{type:String,default:'18:00'}, end:{type:String,default:'08:00'}, fee:{type:Number,default:0,min:0}, active:{type:Boolean,default:true} },
  updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'AdminUser', default: null },
}, { timestamps: true });

export default mongoose.model('SiteSettings', schema);
