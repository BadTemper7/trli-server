import ForwardingContainer from '../models/ForwardingContainer.js';
import {validateForwardingInput,terminalDuration} from '../utils/forwarding.js';
import {AppError,asyncHandler} from '../utils/http.js';
import {auditAdminAction} from '../services/adminAuditService.js';
import {emitToAdminModule} from '../socket/index.js';
import {MODULES} from '../constants/permissions.js';

const present = (item,now=new Date())=>{
  const output=item?.toObject?item.toObject():item;
  const current=output.status==='GATED_OUT'?{elapsedHours:output.finalElapsedHours,elapsedDays:output.finalElapsedDays,billableDays:output.finalDaysInTerminal}:terminalDuration(output.gateInAt,now);
  return {...output,daysInTerminal:current.billableDays,elapsedHours:current.elapsedHours,elapsedDays:current.elapsedDays};
};
const badInput=(error)=>{if(error instanceof AppError)throw error;throw new AppError(error.message||'Invalid forwarding details.',400);};
const rx=(value)=>String(value||'').slice(0,100).replace(/[.*+?^${}()|[\]\\]/g,'\\$&');

export const listForwarding=asyncHandler(async(req,res)=>{
  const filter={};const status=String(req.query.status||'').toUpperCase();
  if(status){if(!['IN_TERMINAL','GATED_OUT'].includes(status))throw new AppError('Invalid forwarding status.',400);filter.status=status;}
  if(req.query.search){const expr={$regex:rx(req.query.search),$options:'i'};filter.$or=[{containerNumber:expr},{shippingLine:expr}];}
  if(req.query.shippingLine)filter.shippingLine={$regex:rx(req.query.shippingLine),$options:'i'};
  if(req.query.from||req.query.to){filter.gateInAt={};for(const [key,operator,suffix] of [['from','$gte','T00:00:00+08:00'],['to','$lte','T23:59:59+08:00']])if(req.query[key]){
    if(!/^\d{4}-\d{2}-\d{2}$/.test(String(req.query[key])))throw new AppError('Invalid date filter.',400);
    filter.gateInAt[operator]=new Date(`${req.query[key]}${suffix}`);
  }}
  const page=Math.max(1,Math.min(100000,Number.parseInt(req.query.page,10)||1)),limit=Math.max(5,Math.min(100,Number.parseInt(req.query.limit,10)||15));
  const [items,total,totalAll,inside,gatedOut]=await Promise.all([
    ForwardingContainer.find(filter).sort({gateInAt:-1,_id:-1}).skip((page-1)*limit).limit(limit).lean(),
    ForwardingContainer.countDocuments(filter),ForwardingContainer.countDocuments(),
    ForwardingContainer.countDocuments({status:'IN_TERMINAL'}),ForwardingContainer.countDocuments({status:'GATED_OUT'}),
  ]);
  res.json({success:true,data:{items:items.map(i=>present(i)),summary:{total:totalAll,inTerminal:inside,gatedOut},pagination:{page,limit,total,pages:Math.max(1,Math.ceil(total/limit))}}});
});

export const getForwarding=asyncHandler(async(req,res)=>{
  const item=await ForwardingContainer.findById(req.params.id).populate('registeredBy','firstName lastName email').populate('gatedOutBy','firstName lastName email').populate('movements.performedBy','firstName lastName email').lean();
  if(!item)throw new AppError('Forwarding container not found.',404);
  res.json({success:true,data:{item:present(item)}});
});

export const createForwarding=asyncHandler(async(req,res)=>{
  let values;try{values=validateForwardingInput(req.body);}catch(e){badInput(e)}
  let item;
  try{
    item=await ForwardingContainer.create({...values,status:'IN_TERMINAL',registeredBy:req.admin._id,movements:[{action:'GATE_IN_RECORDED',at:new Date(),performedBy:req.admin._id,details:{gateInAt:values.gateInAt}}]});
  }catch(e){if(e.code===11000)throw new AppError('This container already has an active forwarding record.',409);throw e;}
  await auditAdminAction({performedBy:req.admin._id,action:'FORWARDING_GATE_IN_RECORDED',changes:{forwardingId:item._id,containerNumber:item.containerNumber}}).catch(console.error);
  emitToAdminModule(MODULES.FORWARDING,'forwarding:created',{id:String(item._id),containerNumber:item.containerNumber});
  res.status(201).json({success:true,message:'Forwarding container registered.',data:{item:present(item)}});
});

export const gateOutForwarding=asyncHandler(async(req,res)=>{
  const destination=String(req.body?.destination||'').trim();
  if(!destination||destination.length>250)throw new AppError('Destination is required (maximum 250 characters).',400);
  const now=new Date();
  const current=await ForwardingContainer.findById(req.params.id).select('gateInAt status');
  if(!current)throw new AppError('Forwarding container not found.',404);
  if(current.status!=='IN_TERMINAL')throw new AppError('Forwarding Gate-out has already been confirmed.',409);
  let duration;try{duration=terminalDuration(current.gateInAt,now);}catch(e){badInput(e)}
  // Compare-and-update blocks duplicate releases; append movement atomically with status change.
  const item=await ForwardingContainer.findOneAndUpdate({_id:req.params.id,status:'IN_TERMINAL',gateOutAt:null},{
    $set:{status:'GATED_OUT',destination,gateOutAt:now,gatedOutBy:req.admin._id,
      finalElapsedHours:duration.elapsedHours,finalElapsedDays:duration.elapsedDays,finalDaysInTerminal:duration.billableDays},
    $push:{movements:{action:'GATE_OUT_CONFIRMED',at:now,performedBy:req.admin._id,details:{destination,daysInTerminal:duration.billableDays}}},
  },{new:true,runValidators:true});
  if(!item)throw new AppError('Forwarding Gate-out has already been confirmed.',409);
  await auditAdminAction({performedBy:req.admin._id,action:'FORWARDING_GATE_OUT_CONFIRMED',changes:{forwardingId:item._id,containerNumber:item.containerNumber,destination,gateOutAt:now}}).catch(console.error);
  emitToAdminModule(MODULES.FORWARDING,'forwarding:gated-out',{id:String(item._id),containerNumber:item.containerNumber});
  res.json({success:true,message:'Forwarding Gate-out recorded. No invoice or payment required.',data:{item:present(item)}});
});
