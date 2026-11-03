import { listDocuments } from '../utils/tableQuery.js';
import Notification from '../models/Notification.js';import {asyncHandler,ok,AppError} from '../utils/http.js';const filter=req=>({$or:[{user:req.user._id},{user:null,company:req.user.company._id,audience:'CLIENT'}]});export const list=asyncHandler(async(req,res)=>{
  const { items, pagination }=await listDocuments(Notification, filter(req), req.query, {
    defaultLimit: 30,maxLimit:100,sorts:['createdAt','_id'],
    select:'audience user company type title message data isRead createdAt',
  });
  ok(res,{items,pagination});
});export const read=asyncHandler(async(req,res)=>{const n=await Notification.findOneAndUpdate({_id:req.params.id,...filter(req)},{$set:{isRead:true}},{new:true});if(!n)throw new AppError('Notification not found.',404);ok(res,{item:n},'Notification marked as read.')});export const readAll=asyncHandler(async(req,res)=>{await Notification.updateMany(filter(req),{$set:{isRead:true}});ok(res,{},'Notifications marked as read.')});
