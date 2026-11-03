import mongoose from 'mongoose';
const auditEntry=new mongoose.Schema({action:String,performedAt:{type:Date,default:Date.now},performedBy:{type:mongoose.Schema.Types.ObjectId,ref:'AdminUser'},before:mongoose.Schema.Types.Mixed,after:mongoose.Schema.Types.Mixed,note:String},{_id:false});
const schema=new mongoose.Schema({
  source:{type:String,enum:['HISTORICAL'],default:'HISTORICAL',immutable:true},
  company:{type:mongoose.Schema.Types.ObjectId,ref:'ClientCompany',required:true,index:true},
  containerNumber:{type:String,required:true,uppercase:true,trim:true,index:true},
  containerSize:{type:String,enum:['20FT','40FT','UNKNOWN'],default:'UNKNOWN'},
  containerType:{type:String,enum:['DRY CONTAINER','REEFER','TANK CONTAINER','OPEN TOP','FLAT RACK','UNKNOWN'],default:'UNKNOWN'},
  loadStatus:{type:String,enum:['EMPTY','LOADED','UNKNOWN'],default:'UNKNOWN'},
  transactionClassification:{type:String,enum:['LOCAL','INTERNATIONAL','UNKNOWN'],default:'UNKNOWN'},
  shippingLine:{type:String,default:''},truckPlateNumber:String,driverName:String,driverLicenceNumber:String,hauler:String,
  sealNumber:String,remarks:String,
  bookingReference:{type:String,default:''},invoiceReferences:[String],paymentReferences:[String],
  status:{type:String,enum:['UNKNOWN','BOOKED','GATED_IN','STORED','GATE_OUT_APPROVED','RELEASED','CANCELLED'],default:'UNKNOWN',index:true},
  gateIn:{actualGateInAt:Date,remarks:String,inspection:{status:{type:String,enum:['PENDING','ACCEPTED','REJECTED'],default:'PENDING'},sealNumber:String,sealIntact:Boolean,containerCondition:[String],remarks:String}},
  storage:{storedAt:Date,location:String,remarks:String},
  gateOut:{approvedAt:Date,scheduledDate:String,scheduledTime:String,releasedAt:Date,remarks:String,approvalStatus:{type:String,default:'NONE'}},
  approvals:{gateIn:{type:Boolean,default:false},gateOut:{type:Boolean,default:false}},
  originTransactionDate:Date,
  deletedAt:{type:Date,default:null},deletedBy:{type:mongoose.Schema.Types.ObjectId,ref:'AdminUser',default:null},
  history:[auditEntry],createdBy:{type:mongoose.Schema.Types.ObjectId,ref:'AdminUser'},updatedBy:{type:mongoose.Schema.Types.ObjectId,ref:'AdminUser'},
},{timestamps:true});
schema.index({containerNumber:1},{unique:true,partialFilterExpression:{deletedAt:null,status:{$in:['GATED_IN','STORED','GATE_OUT_APPROVED']}},name:'unique_active_imported_container'});
export default mongoose.model('HistoricalContainer',schema);
