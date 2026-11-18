import mongoose from 'mongoose';
import PaymentType from '../models/PaymentType.js';
import { AppError } from '../utils/http.js';
import { ONLINE_METHODS, PAYMENT_METHOD_CODES, isConfiguredReceivingAccount, isAvailablePaymentChoice } from '../utils/paymentMethodRules.js';
export { ONLINE_METHODS, PAYMENT_METHOD_CODES, isConfiguredReceivingAccount, isAvailablePaymentChoice, receivingAccountSnapshot } from '../utils/paymentMethodRules.js';

// New clients select PaymentType._id, not a category shared by multiple accounts.
// Legacy category codes remain supported for already-deployed client versions.
export async function getPaymentChoice(identifier, { allowCash = false, session = null } = {}) {
  const value = String(identifier || '').trim();
  const query = mongoose.isValidObjectId(value)
    ? { _id: value, status: 'ACTIVE' }
    : { code: value.toUpperCase(), status: 'ACTIVE' };
  if (!value || (!mongoose.isValidObjectId(value) && !PAYMENT_METHOD_CODES.includes(value.toUpperCase())))
    throw new AppError('Select a valid payment method.', 400);
  let row;
  if (mongoose.isValidObjectId(value)) {
    const search = PaymentType.findOne(query);
    if (session) search.session(session);
    row = await search.lean();
  } else {
    // Older client builds submitted a code instead of an account ID. Keep
    // that path only while the code identifies exactly one active account.
    // Never silently send a customer to a random account after duplicates
    // become valid in Payment Types.
    const search = PaymentType.find(query).sort({ createdAt: 1, _id: 1 }).limit(2);
    if (session) search.session(session);
    const matches = await search.lean();
    if (matches.length > 1) throw new AppError('Multiple accounts are configured for this method. Refresh the Client Portal and select a specific account.', 409);
    row = matches[0];
  }
  if (!row) throw new AppError('This payment method is disabled or no longer available. Please choose another.', 409);
  if (row.code === 'CASH') {
    if (!allowCash) throw new AppError('Cash is payable in person. Do not submit it as an online transfer.', 400);
    return row;
  }
  if (!ONLINE_METHODS.includes(row.code) || !isConfiguredReceivingAccount(row))
    throw new AppError('The selected receiving account is not configured. Choose another payment account.', 409);
  return row;
}

export async function getReceivingMethod(identifier, session = null) {
  return getPaymentChoice(identifier, { session });
}
