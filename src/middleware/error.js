import {randomUUID} from 'node:crypto';

export function notFound(req,res) {
  res.status(404).json({success:false,message:'Route not found.',errors:[]});
}

export function errorHandler(err,req,res,next) {
  const status=Number(err?.status)||500;
  const errorId=status>=500?`TRL-${randomUUID().slice(0,8).toUpperCase()}`:undefined;
  if(status>=500) {
    // Keep original stack in server logs, never reveal internal financial data to clients.
    console.error('[TRL_SERVER_ERROR]',{errorId,method:req.method,path:req.originalUrl,name:err?.name,code:err?.code,message:err?.message,stack:err?.stack});
  }else if(process.env.NODE_ENV!=='production')console.error('[TRL_REQUEST_ERROR]',{status,path:req.originalUrl,message:err?.message});
  res.status(status).json({
    success:false,
    code:status===500?'SERVER_ERROR':err?.code||undefined,
    ...(errorId?{errorId}:{}),
    message:status===500?'Internal server error. Share the error ID with technical support.':err?.message||'Request failed.',
    errors:err?.errors||[],
  });
}
