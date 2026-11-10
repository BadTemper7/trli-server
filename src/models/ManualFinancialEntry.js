import mongoose from 'mongoose';

// Immutable transaction journal: every administrator-entered charge or received
// payment is traceable independently of the invoice's mutable current balance.
const schema = new mongoose.Schema({
  invoice: { type:mongoose.Schema.Types.ObjectId, ref:'Invoice',required:true,index:true },
  booking: { type:mongoose.Schema.Types.ObjectId, ref:'PreAdvice',required:true },
  company: { type:mongoose.Schema.Types.ObjectId, ref:'ClientCompany',required:true },
  kind: { type:String,enum:['CHARGE','PAYMENT'],required:true },
  requestKey: { type:String,required:true,trim:true,maxlength:100 },
  transactionType: { type:String,default:'' },
  description: { type:String,default:'' },
  quantity: { type:Number,default:1 },
  amount: { type:Number,required:true,min:0 },
  taxTreatment: { type:String,enum:['TAXABLE','EXEMPT','ZERO_RATED'],default:'TAXABLE' },
  method: { type:String,default:'' },
  reference: { type:String,default:'' },
  transactionDate: { type:Date,required:true,default:Date.now },
  remarks: { type:String,default:'' },
  payment: { type:mongoose.Schema.Types.ObjectId,ref:'PaymentSubmission',default:null },
  recordedBy: { type:mongoose.Schema.Types.ObjectId,ref:'AdminUser',required:true },
}, {timestamps:true});
schema.index({invoice:1,requestKey:1},{unique:true,name:'unique_admin_financial_request'});
schema.index({invoice:1,createdAt:-1},{name:'idx_admin_invoice_entries'});
export default mongoose.model('ManualFinancialEntry',schema);
