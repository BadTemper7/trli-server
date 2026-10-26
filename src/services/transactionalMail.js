import EmailOutbox from '../models/EmailOutbox.js';
import ClientUser from '../models/ClientUser.js';
import { sendMail } from './emailService.js';

const safe = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function bookingMailHtml({ title, bookingReference, containerNumber, message, invoiceNumber, amount }) {
  const link = process.env.CLIENT_URL ? `${process.env.CLIENT_URL.replace(/\/$/, '')}/portal/pre-advice` : '';
  return `<div style="font:15px Arial,sans-serif;max-width:630px;margin:auto;color:#24334b;line-height:1.6"><div style="padding:22px;background:#174a7e;color:white"><h2>Trans Roadway Logistics Inc.</h2></div><div style="padding:25px"><h3>${safe(title)}</h3><p>${safe(message)}</p><p><strong>Booking:</strong> ${safe(bookingReference)}<br><strong>Container:</strong> ${safe(containerNumber)}${invoiceNumber ? `<br><strong>Invoice:</strong> ${safe(invoiceNumber)}` : ''}${amount !== undefined ? `<br><strong>Amount:</strong> PHP ${Number(amount).toFixed(2)}` : ''}</p>${link ? `<p><a href="${safe(link)}">View your booking</a></p>` : ''}</div></div>`;
}

export async function enqueueMail({ eventKey, to, subject, html }, session = null) {
  if (!to) return;
  try {
    await EmailOutbox.updateOne({ eventKey }, { $setOnInsert: { eventKey, to, subject, html, status: 'PENDING' } }, { upsert: true, ...(session ? { session } : {}) });
  } catch (err) {
    if (err.code !== 11000) throw err;
  }
}

export async function enqueueBookingMail(booking, { event, title, message, invoiceNumber, amount }, session = null) {
  const query = ClientUser.findById(booking.createdBy).select('email');
  const user = await (session ? query.session(session) : query).lean();
  if (!user?.email) return;
  const revision = event === 'GATE_OUT_REJECTED' || event === 'GATE_IN_PAYMENT_REJECTED'
    ? `${booking.workflowHistory?.length || 0}` : '1';
  await enqueueMail({
    eventKey: `booking:${booking._id}:${event}:${revision}`,
    to: user.email,
    subject: `Trans Roadway Logistics - ${title} (${booking.bookingReference})`,
    html: bookingMailHtml({ title, message, bookingReference: booking.bookingReference, containerNumber: booking.containerNumber, invoiceNumber, amount }),
  }, session);
}

export async function drainEmailOutbox(maxItems = 20) {
  let delivered = 0;
  for (let i = 0; i < maxItems; i += 1) {
    const now = new Date();
    const row = await EmailOutbox.findOneAndUpdate({
      $or: [{ status: { $in: ['PENDING', 'FAILED'] }, nextAttemptAt: { $lte: now } }, { status: 'SENDING', lockedUntil: { $lte: now } }],
    }, { $set: { status: 'SENDING', lockedUntil: new Date(Date.now() + 120000) }, $inc: { attempts: 1 } }, { new: true, sort: { nextAttemptAt: 1 } });
    if (!row) break;
    try {
      const result = await sendMail(row.to, row.subject, row.html);
      if (!result.sent) throw new Error('SMTP not configured');
      await EmailOutbox.updateOne({ _id: row._id, status: 'SENDING' }, { $set: { status: 'SENT', sentAt: new Date(), lockedUntil: null, lastError: '' } });
      delivered += 1;
    } catch (error) {
      await EmailOutbox.updateOne({ _id: row._id }, { $set: { status: 'FAILED', lastError: String(error.message || error).slice(0, 800), nextAttemptAt: new Date(Date.now() + Math.min(3600000, 30000 * 2 ** Math.min(row.attempts, 7))), lockedUntil: null } });
    }
  }
  return delivered;
}
