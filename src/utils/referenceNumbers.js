import DailySequence from '../models/DailySequence.js';
import {REFERENCE_PREFIX, referenceDay, formatReference} from './referenceFormat.js';

export {formatReference} from './referenceFormat.js';

/** Reserve one sequence per document type and Manila calendar day. */
export async function nextReference(type, date = new Date(), session = null) {
  const documentType = String(type || '').toUpperCase();
  if (!REFERENCE_PREFIX[documentType]) throw new Error(`Unsupported reference type: ${documentType}`);
  const day = referenceDay(date);
  const row = await DailySequence.findOneAndUpdate(
    {type: documentType, day},
    {$inc: {value: 1}},
    {upsert: true, new: true, setDefaultsOnInsert: true, ...(session ? {session} : {})},
  );
  return formatReference(documentType, date, row.value);
}
