import mongoose from 'mongoose';

const documentSchema = new mongoose.Schema({
  type: String,
  name: String,
  storedName: String,
  mimeType: String,
  size: Number,
}, { _id: true });

const historySchema = new mongoose.Schema({
  status: String,
  changedAt: { type: Date, default: Date.now },
  note: String,
}, { _id: false });


const workflowHistorySchema = new mongoose.Schema({
  stage: {
    type: String,
    enum: [
      'BOOKING_SUBMITTED',
      'BOOKING_APPROVED',
      'READY_FOR_GATE_IN',
      'GATE_IN_PAYMENT_SUBMITTED',
      'GATE_IN',
      'INVENTORY',
      'STORAGE',
      'GATE_OUT_REQUESTED',
      'GATE_OUT_PAYMENT_PENDING',
      'GATE_OUT_PAYMENT_SUBMITTED',
      'GATE_OUT_APPROVED',
      'READY_FOR_RELEASE',
      'CONTAINER_RELEASED',
    ],
    required: true,
  },
  changedAt: { type: Date, default: Date.now },
  note: { type: String, default: '' },
}, { _id: false });


const paymentSchema = new mongoose.Schema({
  status: { type: String, enum: ['PENDING', 'SUBMITTED', 'CANCELLED'], default: 'PENDING' },
  amountDue: { type: Number, default: 0, min: 0 },
  amountSubmitted: { type: Number, default: 0, min: 0 },
  referenceNumber: { type: String, default: '' },
  method: { type: String, default: '' },
  submittedAt: { type: Date, default: null },
  submittedBy: { type: String, default: null },
  cancelledAt: { type: Date, default: null },
  cancelledBy: { type: String, default: null },
  cancellationReason: { type: String, default: '' },
}, { _id: false });


const gateInInspectionSchema = new mongoose.Schema({
  status: { type: String, enum: ['PENDING', 'ACCEPTED', 'REJECTED'], default: 'PENDING' },
  sealNumber: { type: String, default: '' },
  sealIntact: { type: Boolean, default: null },
  containerCondition: [{
    type: String,
    enum: ['GOOD', 'DENTED', 'RUST', 'HOLE', 'DOOR DAMAGE', 'OTHER'],
  }],
  remarks: { type: String, default: '' },
  rejectionReason: { type: String, default: '' },
  inspectedAt: { type: Date, default: null },
  inspectedBy: { type: String, default: null },
}, { _id: false });

const gateInSchema = new mongoose.Schema({
  inspection: { type: gateInInspectionSchema, default: () => ({}) },
  payment: { type: paymentSchema, default: () => ({}) },
  actualGateInAt: { type: Date, default: null },
  processedBy: { type: String, default: null },
  remarks: { type: String, default: '' },
}, { _id: false });

const inventorySchema = new mongoose.Schema({
  status: { type: String, enum: ['PENDING', 'IN_YARD', 'IN_STORAGE', 'RELEASE_PENDING', 'RELEASED'], default: 'PENDING' },
  receivedAt: { type: Date, default: null },
  receivedBy: { type: String, default: null },
  condition: [{ type: String, enum: ['GOOD', 'DENTED', 'RUST', 'HOLE', 'DOOR DAMAGE', 'OTHER', 'DAMAGED', 'FOR_INSPECTION'] }],
  sealNumber: { type: String, default: '' },
  notes: { type: String, default: '' },
}, { _id: false });

const gateOutSchema = new mongoose.Schema({
  requestedAt: { type: Date, default: null },
  requestedBy: { type: String, default: null },
  scheduledDate: { type: String, default: '' },
  scheduledTime: { type: String, default: '' },
  truckPlateNumber: { type: String, default: '' },
  driverName: { type: String, default: '' },
  payment: { type: paymentSchema, default: () => ({}) },
  approvedAt: { type: Date, default: null },
  approvedBy: { type: String, default: null },
  readyForReleaseAt: { type: Date, default: null },
  releasedAt: { type: Date, default: null },
  releasedBy: { type: String, default: null },
  remarks: { type: String, default: '' },
}, { _id: false });

const storageSchema = new mongoose.Schema({
  status: {
    type: String,
    enum: ['WAITING_STORAGE', 'STORED', 'RELEASE_PENDING', 'RELEASED'],
    default: null,
  },
  block: { type: mongoose.Schema.Types.ObjectId, ref: 'StorageBlock', default: null },
  bay: { type: Number, default: null },
  row: { type: Number, default: null },
  tier: { type: Number, default: null },
  storedAt: { type: Date, default: null },
  storedBy: { type: String, default: null },
}, { _id: false });

const schema = new mongoose.Schema({
  bookingReference: { type: String, unique: true, index: true },
  company: { type: mongoose.Schema.Types.ObjectId, ref: 'ClientCompany', required: true, index: true },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'ClientUser', required: true },
  containerNumber: { type: String, required: true, trim: true, uppercase: true, index: true },
  containerSize: { type: String, enum: ['20FT', '40FT'], required: true },
  containerType: { type: String, enum: ['DRY CONTAINER', 'REEFER', 'TANK CONTAINER', 'OPEN TOP', 'FLAT RACK'], required: true },
  loadStatus: { type: String, enum: ['EMPTY', 'LOADED'], required: true },
  transactionClassification: { type: String, enum: ['LOCAL', 'INTERNATIONAL'], required: true },
  scheduledGateDateIn: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ },
  scheduledGateTimeIn: { type: String, required: true, match: /^([01]\d|2[0-3]):00$/ },
  shippingLine: { type: String, required: true },
  truckPlateNumber: { type: String, required: true },
  driverName: { type: String, required: true },
  driverLicenceNumber: { type: String, required: true },
  hauler: { type: String, required: true },
  blNumber: String,
  vesselVoyage: String,
  weight: { type: Number, required: true, min: 0 },
  cargoDescription: String,
  remarks: String,
  documents: [documentSchema],
  status: { type: String, enum: ['DRAFT', 'SUBMITTED', 'SCHEDULED', 'READY_FOR_GATE_IN', 'GATED_IN', 'COMPLETED', 'CANCELLED'], default: 'SUBMITTED' },
  statusHistory: [historySchema],
  cancellation: {
    cancelledAt: { type: Date, default: null },
    cancelledBy: { type: mongoose.Schema.Types.ObjectId, ref: 'ClientUser', default: null },
    reason: { type: String, default: '' },
  },
  workflowStage: {
    type: String,
    enum: [
      'BOOKING_SUBMITTED', 'BOOKING_APPROVED', 'READY_FOR_GATE_IN',
      'GATE_IN_PAYMENT_SUBMITTED', 'GATE_IN', 'INVENTORY', 'STORAGE',
      'GATE_OUT_REQUESTED', 'GATE_OUT_PAYMENT_PENDING', 'GATE_OUT_PAYMENT_SUBMITTED',
      'GATE_OUT_APPROVED', 'READY_FOR_RELEASE', 'CONTAINER_RELEASED',
    ],
    default: 'BOOKING_SUBMITTED',
    index: true,
  },
  workflowHistory: [workflowHistorySchema],
  storage: { type: storageSchema, default: () => ({}) },
  gateIn: { type: gateInSchema, default: () => ({}) },
  inventory: { type: inventorySchema, default: () => ({}) },
  gateOut: { type: gateOutSchema, default: () => ({}) },
}, { timestamps: true });

schema.index(
  { 'storage.block': 1, 'storage.bay': 1, 'storage.row': 1, 'storage.tier': 1 },
  {
    unique: true,
    partialFilterExpression: {
      'storage.status': 'STORED',
      'storage.block': { $type: 'objectId' },
      'storage.bay': { $type: 'number' },
      'storage.row': { $type: 'number' },
      'storage.tier': { $type: 'number' },
    },
    name: 'unique_active_storage_position',
  },
);

export default mongoose.model('PreAdvice', schema);
