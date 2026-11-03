import mongoose from 'mongoose';
const line=new mongoose.Schema({description:String,quantity:{type:Number,default:1},unitRate:Number,amount:Number,taxTreatment:{type:String,enum:['TAXABLE','EXEMPT','ZERO_RATED'],default:'TAXABLE'},rateId:{type:mongoose.Schema.Types.ObjectId,ref:'Rate'},isOptional:{type:Boolean,default:false},fullAmount:Number,pricingMode:{type:String,enum:['FIXED','MANUAL'],default:'FIXED'},collectionPoint:{type:String,enum:['GATE_IN','GATE_OUT','BOTH']}},{_id:false});
const schema=new mongoose.Schema({number:{type:String,unique:true,required:true},booking:{type:mongoose.Schema.Types.ObjectId,ref:'PreAdvice',required:true,index:true},company:{type:mongoose.Schema.Types.ObjectId,ref:'ClientCompany',required:true,index:true},type:{type:String,enum:['GATE_IN','GATE_OUT'],required:true},status:{type:String,enum:['UNPAID','PAYMENT_SUBMITTED','PAID','CANCELLED','VOID'],default:'UNPAID'},lines:[line],optionalRateIds:[{type:mongoose.Schema.Types.ObjectId,ref:'Rate'}],subtotal:{type:Number,required:true},vat:{type:Number,required:true},total:{type:Number,required:true},paidAmount:{type:Number,default:0},balance:{type:Number,required:true},vatRate:{type:Number,default:12},vatInclusive:{type:Boolean,default:true},vatableSales:{type:Number,default:0},nonVatableSales:{type:Number,default:0},paidAt:Date,verifiedBy:{type:mongoose.Schema.Types.ObjectId,ref:'AdminUser'}},{timestamps:true});
schema.index({booking:1,type:1},{unique:true});
schema.index({company:1,createdAt:-1,_id:-1},{name:'idx_invoice_company_created'});
schema.index({company:1,status:1,createdAt:-1,_id:-1},{name:'idx_invoice_company_status_created'});
schema.index({company:1,type:1,createdAt:-1,_id:-1},{name:'idx_invoice_company_type_created'});
schema.index({status:1,createdAt:-1,_id:-1},{name:'idx_invoice_status_created'});
schema.index({type:1,status:1,createdAt:-1,_id:-1},{name:'idx_invoice_type_status_created'});
schema.index({createdAt:-1,_id:-1},{name:'idx_invoice_created'});

export default mongoose.model('Invoice',schema);
