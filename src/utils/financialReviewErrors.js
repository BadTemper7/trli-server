import {AppError} from './http.js';

/** Categorize expected payment review errors without exposing banking data. */
export function paymentReviewFailure(error) {
  if (error instanceof AppError) return error;
  if (error?.code === 11000) return new AppError('A duplicate receipt or financial reference was detected. Refresh the payment and retry.',409);
  if (error?.hasErrorLabel?.('TransientTransactionError') || /WriteConflict|NoSuchTransaction/i.test(error?.message||'')) {
    return new AppError('Another transaction updated this payment. Refresh its status before trying again.',409);
  }
  if (/Transaction numbers are only allowed|replica set|mongos/i.test(error?.message||'')) {
    return new AppError('Payment verification requires MongoDB transaction support. Configure a replica set before approving payments.',503);
  }
  if (error?.name==='ValidationError') return new AppError(`Payment review was not saved: ${error.message}`,409);
  return error;
}
