import mongoose from 'mongoose';

const schema = new mongoose.Schema({
  eventKey: { type: String, required: true, unique: true },
  to: { type: String, required: true },
  subject: { type: String, required: true },
  html: { type: String, required: true },
  status: { type: String, enum: ['PENDING', 'SENDING', 'SENT', 'FAILED'], default: 'PENDING', index: true },
  attempts: { type: Number, default: 0 },
  nextAttemptAt: { type: Date, default: Date.now, index: true },
  lastError: { type: String, default: '' },
  sentAt: { type: Date, default: null },
  lockedUntil: { type: Date, default: null },
}, { timestamps: true });

export default mongoose.model('EmailOutbox', schema);
