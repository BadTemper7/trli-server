import {AppError} from './http.js';

/** Categorize expected payment review errors without exposing banking data. */
export function paymentReviewFailure(error, {reference = undefined} = {}) {
  if (error instanceof AppError) return error;
  if (error?.code === 11000) {
    const keys=Object.keys(error?.keyPattern||error?.keyValue||{});
    if(keys.includes('receiptNumber'))return new AppError('Receipt number already exists. No payment was approved. Reconcile the receipt sequence before retrying.',409);
    if(keys.includes('type')&&keys.includes('day'))return new AppError('Concurrent receipt numbering detected. Refresh and retry the payment verification.',409);
    if(keys.includes('reference')) {
      if(reference !== undefined && !String(reference ?? '').trim()) {
        return new AppError('Proof-only payments do not need a reference. A legacy payment-reference database index is blocking verification. Ask the administrator to run the payment-evidence index migration after a database backup.',409);
      }
      return new AppError('This payment reference is already assigned to another active or verified payment.',409);
    }
    return new AppError('A database uniqueness conflict prevented verification. Review the financial index details in the server log.',409);
  }
  if (error?.hasErrorLabel?.('TransientTransactionError') || /WriteConflict|NoSuchTransaction/i.test(error?.message||'')) {
    return new AppError('Another transaction updated this payment. Refresh its status before trying again.',409);
  }
  if (/Transaction numbers are only allowed|replica set|mongos/i.test(error?.message||'')) {
    return new AppError('Payment verification requires MongoDB transaction support. Configure a replica set before approving payments.',503);
  }
  if (error?.name==='ValidationError') return new AppError(`Payment review was not saved: ${error.message}`,409);
  return error;
}
