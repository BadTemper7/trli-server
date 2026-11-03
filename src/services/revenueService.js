import PaymentSubmission from '../models/PaymentSubmission.js';
// Each invoice is represented at most once. Refunds/reversals are separate
// negative events at their actual dates, never inferred from proof submission.
export function revenuePipeline(from,to,extra=[]){
  return [
    {$match:{verifiedAt:{$type:'date'},status:{$in:['VERIFIED','REFUNDED','REVERSED','VOIDED']}}},
    {$sort:{verifiedAt:1,_id:1}},
    {$group:{_id:'$invoice',doc:{$first:'$$ROOT'}}},
    {$replaceRoot:{newRoot:'$doc'}},
    {$project:{company:1,invoice:1,events:[
      {when:'$verifiedAt',amount:'$amount'},
      {when:{$ifNull:['$refundedAt',{$ifNull:['$reversedAt','$voidedAt']}]},amount:{$multiply:[-1,{$ifNull:['$refundedAmount','$amount']}]},refundOnly:true},
    ],status:1}},
    {$unwind:'$events'},
    {$match:{$expr:{$and:[{$gte:['$events.when',from]},{$lt:['$events.when',to]},{$or:[{$ne:['$events.refundOnly',true]},{$in:['$status',['REFUNDED','REVERSED','VOIDED']]}]}]}}},
    ...extra,
  ];
}
export async function revenueSummary(from,to){
  const rows=await PaymentSubmission.aggregate(revenuePipeline(from,to,[{$group:{_id:null,total:{$sum:'$events.amount'},transactions:{$sum:{$cond:[{$gte:['$events.amount',0]},1,0]}}}}]));
  return {total:Math.round(Number(rows[0]?.total||0)*100)/100,transactions:rows[0]?.transactions||0};
}
export async function revenueByClient(from,to,limit=10){
  return PaymentSubmission.aggregate(revenuePipeline(from,to,[
    {$group:{_id:'$company',revenue:{$sum:'$events.amount'},transactions:{$sum:{$cond:[{$gte:['$events.amount',0]},1,0]}}}},
    {$sort:{revenue:-1}},{$limit:limit},
    {$lookup:{from:'clientcompanies',localField:'_id',foreignField:'_id',as:'company'}},
    {$project:{client:{$ifNull:[{$first:'$company.companyName'},'Unknown Client']},revenue:1,transactions:1}},
  ]));
}
export async function revenueTimeSeries(from,to,groupFormat='%Y-%m-%d'){
  return PaymentSubmission.aggregate(revenuePipeline(from,to,[
    {$group:{_id:{$dateToString:{format:groupFormat,date:'$events.when',timezone:'Asia/Manila'}},revenue:{$sum:'$events.amount'}}},
    {$sort:{_id:1}},
  ]));
}
