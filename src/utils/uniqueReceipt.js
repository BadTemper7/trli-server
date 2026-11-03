import PaymentSubmission from '../models/PaymentSubmission.js';
import DailySequence from '../models/DailySequence.js';
import {nextReference} from './referenceNumbers.js';
import {referenceDay} from './referenceFormat.js';
import {AppError} from './http.js';

// All reads and counter writes participate in the *same* verification
// transaction. This handles historical receipts issued before the counter
// table was introduced without weakening receipt uniqueness.
export async function uniqueReceiptNumber(session){
  const today=new Date(),day=referenceDay(today);
  for(let attempt=0;attempt<20;attempt++){
    const candidate=await nextReference('RECEIPT',today,session);
    const inUse=await PaymentSubmission.exists({receiptNumber:candidate}).session(session);
    if(!inUse)return candidate;
    if(attempt===0){
      const rows=await PaymentSubmission.find({receiptNumber:{$regex:`^TRANS-RCT-${day}-\\d+$`}})
        .select('receiptNumber').session(session).lean();
      const highest=rows.reduce((n,row)=>Math.max(n,Number(String(row.receiptNumber).split('-').at(-1))||0),0);
      if(highest)await DailySequence.updateOne({type:'RECEIPT',day},{$max:{value:highest}},{session});
    }
  }
  throw new AppError('Receipt sequence cannot be safely allocated. Run financial reference reconciliation before retrying.',409);
}
