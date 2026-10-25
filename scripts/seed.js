import 'dotenv/config';
import bcrypt from 'bcrypt';
import mongoose from 'mongoose';
import { connectDB } from '../src/config/db.js';
import ClientCompany from '../src/models/ClientCompany.js';
import ClientUser from '../src/models/ClientUser.js';
import PreAdvice from '../src/models/PreAdvice.js';
import StorageBlock from '../src/models/StorageBlock.js';

if (process.env.NODE_ENV === 'production') throw new Error('Seed is development-only.');
await connectDB();

const company = await ClientCompany.findOneAndUpdate(
  { companyName: 'Development Verified Client' },
  { $set: { companyAddress: 'Development sample only', businessType: 'TRUCKING', verificationStatus: 'VERIFIED', verifiedAt: new Date() } },
  { new: true, upsert: true },
);
const passwordHash = await bcrypt.hash('DevOnly#123', 12);
const user = await ClientUser.findOneAndUpdate(
  { email: 'verified@example.test' },
  { $set: { company: company._id, firstName: 'Dev', lastName: 'Client', phoneNumber: '09171234567', position: 'MANAGER', emailVerified: true, passwordHash, role: 'CLIENT', isActive: true } },
  { new: true, upsert: true },
);

const blockSeed = [
  ['ALPHA', 56, '40FT', '#2E7D32', 7, 4, 2],
  ['BRAVO', 56, '40FT', '#1565C0', 7, 4, 2],
  ['CHARLIE', 96, '20FT', '#E65100', 8, 4, 3],
  ['ECHO', 140, '40FT', '#00838F', 10, 7, 2],
  ['DELTA', 70, '40FT', '#6A1B9A', 7, 5, 2],
  ['FOXTROT', 160, '20FT', '#B8860B', 8, 5, 4],
  ['GOLF', 40, '40FT', '#C2185B', 5, 4, 1],
];
const blocks = {};
for (const [name, capacityTeu, containerSize, color, bays, rows, tiers] of blockSeed) {
  blocks[name] = await StorageBlock.findOneAndUpdate(
    { name },
    { $setOnInsert: { name, capacityTeu, containerSize, color, status: 'ACTIVE', layout: { bays, rows, tiers }, createdBy: 'seed', updatedBy: 'seed' } },
    { new: true, upsert: true },
  );
}

const samples = [
  { ref: 'PA-DEMO-0001', no: 'MSCU1234567', size: '40FT', type: 'DRY CONTAINER', line: 'Sample Shipping Line', status: 'GATED_IN', storage: { status: 'WAITING_STORAGE' } },
  { ref: 'PA-DEMO-0002', no: 'OOLU7654321', size: '40FT', type: 'REEFER', line: 'Ocean Sample', status: 'GATED_IN', storage: { status: 'WAITING_STORAGE' } },
  { ref: 'PA-DEMO-0003', no: 'TGHU2468101', size: '20FT', type: 'DRY CONTAINER', line: 'Demo Maritime', status: 'GATED_IN', storage: { status: 'WAITING_STORAGE' } },
  { ref: 'PA-DEMO-0004', no: 'CMAU1357913', size: '40FT', type: 'DRY CONTAINER', line: 'Sample Cargo', status: 'GATED_IN', storage: { status: 'STORED', block: blocks.ALPHA._id, bay: 1, row: 1, tier: 1, storedAt: new Date(), storedBy: 'seed' } },
  { ref: 'PA-DEMO-0005', no: 'TEMU5550101', size: '40FT', type: 'DRY CONTAINER', line: 'Sample Cargo', status: 'GATED_IN', storage: { status: 'STORED', block: blocks.ALPHA._id, bay: 2, row: 1, tier: 1, storedAt: new Date(), storedBy: 'seed' } },
];
for (const sample of samples) {
  await PreAdvice.findOneAndUpdate(
    { bookingReference: sample.ref },
    { $setOnInsert: {
      bookingReference: sample.ref, company: company._id, createdBy: user._id,
      containerNumber: sample.no, containerSize: sample.size, containerType: sample.type,
      loadStatus: 'LOADED', transactionClassification: 'LOCAL', scheduledGateDateIn: '2026-10-25',
      scheduledGateTimeIn: '10:42', shippingLine: sample.line, truckPlateNumber: 'ABC1234',
      driverName: 'Sample Driver', driverLicenceNumber: 'DEV-001', hauler: 'Sample Hauler', weight: 1000,
      status: sample.status, statusHistory: [{ status: sample.status }], storage: sample.storage,
    } },
    { new: true, upsert: true },
  );
}

console.log('Development seed complete.');
console.log('Client login: verified@example.test / DevOnly#123');
console.log('Storage blocks: ALPHA, BRAVO, CHARLIE, ECHO, DELTA, FOXTROT, GOLF');
await mongoose.disconnect();
