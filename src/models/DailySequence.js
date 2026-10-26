import mongoose from 'mongoose';
const schema = new mongoose.Schema({ type: {type:String,required:true}, day:{type:String,required:true}, value:{type:Number,default:0} },{timestamps:true});
schema.index({type:1,day:1},{unique:true});
export default mongoose.model('DailySequence',schema);
