// Minimal, dependency-free vector PDF renderer for transactional documents.
// Documents are generated on demand from immutable invoice/payment snapshots.
const escapePdf = (value) => String(value ?? '').normalize('NFKD').replace(/[^\x20-\x7e]/g, '?').replace(/[\\()]/g, '\\$&');
const fmt = (number) => `PHP ${Number(number || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const timestamp = (date) => date ? new Date(date).toLocaleString('en-PH', { timeZone: 'Asia/Manila', dateStyle: 'medium', timeStyle: 'short' }) : 'N/A';

export function renderFinancialPdf({ invoice, booking, companyName, payment = null }) {
  const receipt = Boolean(payment);
  const W = 595, H = 842;
  const pages = [];
  let lines = [], y = 796;
  const push = (str) => lines.push(str);
  const write = (x, text, size = 10, bold = false) => {
    push(`BT /${bold ? 'F2' : 'F1'} ${size} Tf ${x} ${y} Td (${escapePdf(text)}) Tj ET`);
  };
  const horizontal = () => push(`0.83 0.88 0.94 RG 42 ${y} m 553 ${y} l S`);
  const reset = () => {
    lines = []; y = 797;
    push('0.09 0.29 0.49 rg'); write(42, 'TRANS ROADWAY LOGISTICS INC.', 14, true);
    y -= 24; push('0 0 0 rg'); write(42, receipt ? 'PAYMENT RECEIPT' : 'INVOICE', 20, true);
    y -= 18; horizontal(); y -= 25;
  };
  const newPage = () => { pages.push(lines.join('\n')); reset(); };
  const row = (label, value = '', opts = {}) => {
    if (y < 86) newPage();
    write(45, String(label).slice(0, 65), opts.size || 10, opts.bold || false);
    if (value !== '') write(opts.amount ? 425 : 310, String(value).slice(0, 40), opts.size || 10, opts.bold || false);
    y -= opts.gap || 20;
  };
  reset();
  row(receipt ? 'Receipt Number' : 'Invoice Number', receipt ? payment.receiptNumber : invoice.number, { bold: true });
  if (receipt) row('Invoice Number', invoice.number);
  row('Booking Reference', booking?.bookingReference || '-');
  row('Client / Company', companyName || '-');
  row('Container Number', booking?.containerNumber || '-');
  row('Transaction Type', invoice.type === 'GATE_OUT' ? 'Gate-out' : 'Gate-in');
  row(receipt ? 'Payment Verified' : 'Date Issued', timestamp(receipt ? payment.verifiedAt : invoice.createdAt));
  if (receipt) {
    row('Payment Method', payment.method);
    row('Transaction Reference', payment.reference);
    row('Amount Verified', fmt(payment.amount), { bold: true });
    y -= 12;
  }
  y -= 13; horizontal(); y -= 22;
  row('DESCRIPTION (QTY x UNIT RATE)', 'AMOUNT', { bold: true, gap: 25 });
  for (const line of invoice.lines || []) {
    row(`${line.description} (${line.quantity} x ${fmt(line.unitRate)})`, fmt(line.amount), { amount: true, gap: 23 });
  }
  y -= 10; horizontal(); y -= 20;
  row('Subtotal', fmt(invoice.subtotal), { amount: true });
  row(`VAT (${invoice.vatRate || 0}% ${invoice.vatInclusive ? 'inclusive' : 'exclusive'})`, fmt(invoice.vat), { amount: true });
  row('Total Payable', fmt(invoice.total), { amount: true, bold: true });
  row('Amount Paid', fmt(receipt ? payment.amount : invoice.paidAmount), { amount: true });
  if (!receipt) row('Remaining Balance', fmt(invoice.balance), { amount: true, bold: true });
  y -= 14; horizontal(); y -= 22;
  row(receipt ? 'Payment successfully verified by an authorized administrator.' : `Status: ${invoice.status}`, '', { size: 9 });
  row('All dates and times shown in Asia/Manila. Currency: PHP.', '', { size: 9 });
  pages.push(lines.join('\n'));
  // PDF 1.4 with built-in Helvetica; no external libraries and no file storage required.
  const objects = [null];
  const add = (content) => { objects.push(content); return objects.length - 1; };
  const catalogId = add('');
  const pagesId = add('');
  const normalId = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  const boldId = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>');
  const pageIds = [];
  for (const content of pages) {
    const data = Buffer.from(content, 'latin1');
    const streamId = add(`<< /Length ${data.length} >>\nstream\n${content}\nendstream`);
    pageIds.push(add(`<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${W} ${H}] /Resources << /Font << /F1 ${normalId} 0 R /F2 ${boldId} 0 R >> >> /Contents ${streamId} 0 R >>`));
  }
  objects[catalogId] = `<< /Type /Catalog /Pages ${pagesId} 0 R >>`;
  objects[pagesId] = `<< /Type /Pages /Kids [${pageIds.map(id => `${id} 0 R`).join(' ')}] /Count ${pageIds.length} >>`;
  let body = '%PDF-1.4\n%TRLPDF\n'; const offsets = [0];
  for (let i = 1; i < objects.length; i += 1) { offsets[i] = Buffer.byteLength(body, 'latin1'); body += `${i} 0 obj\n${objects[i]}\nendobj\n`; }
  const xref = Buffer.byteLength(body, 'latin1');
  body += `xref\n0 ${objects.length}\n0000000000 65535 f \n`;
  for (let i = 1; i < objects.length; i += 1) body += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  body += `trailer\n<< /Size ${objects.length} /Root ${catalogId} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body, 'latin1');
}
