import mongoose from 'mongoose';
import {FORWARDING_SIZES,FORWARDING_TYPES,FORWARDING_STATUSES} from '../utils/forwarding.js';

const movementSchema=new mongoose.Schema({action:{type:String,required:true},at:{type:Date,default:Date.now},performedBy:{type:mongoose.Schema.Types.ObjectId,ref:'AdminUser',required:true},details:{type:mongoose.Schema.Types.Mixed,default:{}}},{_id:false});
const schema=new mongoose.Schema({
  containerNumber:{type:String,required:true,uppercase:true,trim:true,index:true},
  containerSize:{type:String,enum:FORWARDING_SIZES,required:true},
  containerType:{type:String,enum:FORWARDING_TYPES,required:true},
  loadStatus:{type:String,enum:['EMPTY','LOADED'],required:true},
  gateInDate:{type:String,required:true},gateInTime:{type:String,required:true},
  gateInAt:{type:Date,required:true,index:true},
  shippingLine:{type:String,required:true,trim:true},
  truckPlateNumber:{type:String,required:true,trim:true},
  driverName:{type:String,required:true,trim:true},
  driverLicense:{type:String,required:true,trim:true},
  hauler:{type:String,required:true,trim:true},
  status:{type:String,enum:FORWARDING_STATUSES,default:'IN_TERMINAL',required:true,index:true},
  gateOutAt:{type:Date,default:null},destination:{type:String,default:''},
  finalElapsedHours:{type:Number,default:null},finalElapsedDays:{type:Number,default:null},finalDaysInTerminal:{type:Number,default:null},
  registeredBy:{type:mongoose.Schema.Types.ObjectId,ref:'AdminUser',required:true},
  gatedOutBy:{type:mongoose.Schema.Types.ObjectId,ref:'AdminUser',default:null},
  movements:{type:[movementSchema],default:[]},
},{timestamps:true});
// Distinct from normal inventory. Prevent two simultaneous active forwarding movements of the same container.
schema.index({containerNumber:1},{unique:true,name:'unique_active_forwarding_container',partialFilterExpression:{status:'IN_TERMINAL'}});
schema.index({shippingLine:1,status:1,gateInAt:-1});
export default mongoose.model('ForwardingContainer',schema);
