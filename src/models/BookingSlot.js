import mongoose from 'mongoose';
const schema=new mongoose.Schema({day:{type:String,required:true},hour:{type:String,required:true},bookings:{type:[mongoose.Schema.Types.ObjectId],default:[]}},{timestamps:true});
schema.index({day:1,hour:1},{unique:true});
export default mongoose.model('BookingSlot',schema);
