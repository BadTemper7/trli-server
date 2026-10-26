import PaymentType from '../models/PaymentType.js';
import { AppError } from '../utils/http.js';
import { ONLINE_METHODS, isConfiguredReceivingAccount } from '../utils/paymentMethodRules.js';
export { ONLINE_METHODS, isConfiguredReceivingAccount, receivingAccountSnapshot } from '../utils/paymentMethodRules.js';

// A method with no real receiving account must never allow payment submissions.
export async function getReceivingMethod(code, session = null) {
  if (!ONLINE_METHODS.includes(code)) throw new AppError('Select a valid online payment method.', 400);
  const query=PaymentType.findOne({code,status:'ACTIVE'});
  if(session) query.session(session);
  const row=await query.lean();
  if (!isConfiguredReceivingAccount(row)) throw new AppError('Selected payment account is not configured. Please contact the administrator.',409);
  return row;
}
