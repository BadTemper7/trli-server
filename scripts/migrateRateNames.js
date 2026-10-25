import 'dotenv/config';
import { connectDB } from '../src/config/db.js';
import Rate, { RATE_NAMES } from '../src/models/Rate.js';

const normalize = (doc) => {
  const raw = String(doc.name || '').trim();
  const direct = RATE_NAMES.find((name) => name.toLowerCase() === raw.toLowerCase());
  if (direct) return direct;

  const text = raw.toUpperCase().replace(/[-_]+/g, ' ');
  if (text.includes('LIFT ON')) return 'Lift On';
  if (text.includes('LIFT OFF')) return 'Lift Off';
  if (text.includes('CONGESTION')) return 'Congestion Surcharge';
  if (text.includes('TOTAL HANDLING')) return 'Total Handling Reference';
  if (text.includes('STORAGE')) return 'Storage';

  const legacyType = String(doc.serviceType || '').toUpperCase();
  if (legacyType === 'LIFT_ON') return 'Lift On';
  if (legacyType === 'LIFT_OFF') return 'Lift Off';
  if (legacyType === 'STORAGE') return 'Storage';
  return 'Other';
};

await connectDB();
const docs = await Rate.collection.find({}).toArray();
let changed = 0;

for (const doc of docs) {
  const name = normalize(doc);
  const needsName = doc.name !== name;
  const hasLegacyType = Object.prototype.hasOwnProperty.call(doc, 'serviceType');
  if (!needsName && !hasLegacyType) continue;

  await Rate.collection.updateOne(
    { _id: doc._id },
    {
      $set: { name, updatedAt: new Date() },
      $unset: { serviceType: '' },
    },
  );
  changed += 1;
}

console.log(`Rate migration complete. ${changed} record(s) normalized; legacy Rate Type removed.`);
process.exit(0);
