import {readFileSync} from 'node:fs';

/**
 * Trans Roadway Logistics printable operational forms.
 * Dependency-free vector PDFs: values come from the stored booking, invoice,
 * and payment snapshots, not a browser-supplied template or arbitrary prices.
 * All paper dimensions and coordinates are PDF points.
 */
const logoJpeg=readFileSync(new URL('../assets/trans-roadway-logo.jpg',import.meta.url));
const LOGO_W=469, LOGO_H=250;

const C = {
  green: '#17633d', greenLight: '#e7f3e8', blue: '#164b7c', blueLight: '#e8f2fa',
  ink: '#202d3b', gray: '#526174', line: '#9aabc0', white: '#ffffff', light: '#f6f8fa',
  red: '#a33535',
};
const ASCII = value => String(value ?? '').normalize('NFKD').replace(/[^\x20-\x7E]/g, '?');
const safe = value => ASCII(value).replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
const rgb = hex => [1, 3, 5].map(i => (parseInt(hex.slice(i, i + 2), 16) / 255).toFixed(3)).join(' ');
const peso = value => 'PHP ' + Number(value || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const stamp = value => value ? new Date(value).toLocaleString('en-PH', {timeZone:'Asia/Manila',year:'numeric',month:'short',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:true}) : '';
const val = (value, fallback = '') => value === undefined || value === null || value === '' ? fallback : String(value);
const upper = value => val(value).toUpperCase();

class Page {
  constructor(width, height) { this.width = width; this.height = height; this.ops = []; }
  rect(x, y, w, h, fill = null, stroke = C.line, lw = 0.65) {
    if (fill) this.ops.push(`${rgb(fill)} rg ${x} ${this.height-y-h} ${w} ${h} re f`);
    if (stroke) this.ops.push(`${rgb(stroke)} RG ${lw} w ${x} ${this.height-y-h} ${w} ${h} re S`);
  }
  line(x1, y1, x2, y2, color = C.line, lw = 0.65) {
    this.ops.push(`${rgb(color)} RG ${lw} w ${x1} ${this.height-y1} m ${x2} ${this.height-y2} l S`);
  }
  text(x, y, value, size = 9, options = {}) {
    const {bold=false,color=C.ink,maxWidth=null,align='left'} = options;
    let content = ASCII(value);
    // Conservative monospace-like measurement; prevents values overrunning cells.
    if (maxWidth) {
      const capacity = Math.max(1, Math.floor(maxWidth / (size * (bold ? 0.60 : 0.55))));
      if (content.length > capacity) content = content.slice(0, Math.max(1, capacity - 3)) + '...';
    }
    const estimate = content.length * size * (bold ? 0.60 : 0.55);
    const at = align === 'right' ? x - estimate : align === 'center' ? x - estimate / 2 : x;
    this.ops.push(`${rgb(color)} rg BT /${bold ? 'B' : 'R'} ${size} Tf 1 0 0 1 ${at.toFixed(2)} ${(this.height-y-size).toFixed(2)} Tm (${safe(content)}) Tj ET`);
  }
  checkbox(x, y, label, checked = false, color = C.ink, size = 8) {
    this.rect(x, y + 1, 8, 8, C.white, color, 0.7);
    if (checked) { this.line(x+1.5,y+5,x+3.5,y+7,color,1.25); this.line(x+3.5,y+7,x+7,y+2,color,1.25); }
    this.text(x+13, y, label, size, {color});
  }
  section(y, label, color, light) {
    this.rect(25, y, this.width-50, 23, light, color, 0.65);
    this.text(34, y+5, upper(label), 11, {bold:true,color});
  }
  field(x, y, w, h, label, value = '', opts = {}) {
    this.rect(x, y, w, h, C.white, C.line);
    this.text(x+7, y+3, upper(label), 6.8, {bold:true,color:C.gray,maxWidth:w-13});
    this.text(x+7, y+13, val(value, opts.placeholder || ''), 9.4, {bold:!!value,color:C.ink,maxWidth:w-14});
  }
  logo(x,y,w,h) {
    this.ops.push(`q ${w} 0 0 ${h} ${x} ${this.height-y-h} cm /TRLLogo Do Q`);
  }
  boxLabel(x,y,label, value, width, color=C.ink) {
    this.text(x,y,label,8,{color:C.gray});
    this.text(x,y+12,val(value,'-'),10,{bold:true,color,maxWidth:width});
  }
}

function makePdf(pages) {
  const objects = [''];
  const add = data => { objects.push(data); return objects.length-1; };
  const root = add(''); const pagesObj = add('');
  const regular = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  const bold = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>');
  const logoStream=logoJpeg.toString('latin1');
  const imageId=add(`<< /Type /XObject /Subtype /Image /Width ${LOGO_W} /Height ${LOGO_H} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${logoJpeg.length} >>\nstream\n${logoStream}\nendstream`);
  const ids = [];
  pages.forEach(page => {
    const stream = page.ops.join('\n') + '\n';
    const streamId = add(`<< /Length ${Buffer.byteLength(stream,'latin1')} >>\nstream\n${stream}endstream`);
    ids.push(add(`<< /Type /Page /Parent ${pagesObj} 0 R /MediaBox [0 0 ${page.width} ${page.height}] /Resources << /Font << /R ${regular} 0 R /B ${bold} 0 R >> /XObject << /TRLLogo ${imageId} 0 R >> >> /Contents ${streamId} 0 R >>`));
  });
  objects[root] = `<< /Type /Catalog /Pages ${pagesObj} 0 R >>`;
  objects[pagesObj] = `<< /Type /Pages /Kids [${ids.map(id=>`${id} 0 R`).join(' ')}] /Count ${ids.length} >>`;
  let out = '%PDF-1.4\n%TRL-PRINT\n'; const offsets = [0];
  for (let id=1;id<objects.length;id++) {offsets[id]=Buffer.byteLength(out,'latin1');out+=`${id} 0 obj\n${objects[id]}\nendobj\n`;}
  const xref=Buffer.byteLength(out,'latin1');
  out+=`xref\n0 ${objects.length}\n0000000000 65535 f \n`;
  for(let id=1;id<objects.length;id++)out+=`${String(offsets[id]).padStart(10,'0')} 00000 n \n`;
  out+=`trailer\n<< /Size ${objects.length} /Root ${root} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out,'latin1');
}

function header(page, title, green, reference, stampAt, status) {
  const accent=green?C.green:C.blue;
  page.rect(19,17,page.width-38,page.height-34,null,accent,1.15);
  page.rect(25,26,240,52,C.light,null);
  page.logo(34,35,56,30);
  page.text(99,29,'TRANS ROADWAY',15,{bold:true,color:C.blue,maxWidth:164});
  page.text(102,51,'LOGISTICS INC.',9,{bold:true,color:C.gray});
  page.rect(279,26,page.width-304,43,accent,null);
  page.text(279+(page.width-304)/2,32,title,22,{bold:true,color:C.white,align:'center'});
  page.text(280,76,'Booking Ref: '+val(reference,'N/A'),9,{bold:true,color:C.ink,maxWidth:360});
  page.text(page.width-30,76,stamp(stampAt),8,{color:C.gray,align:'right'});
  page.rect(25,93,page.width-50,23,C.light,C.line);
  page.text(34,98,'Document Status: '+upper(status),10,{bold:true,color:accent});
  page.text(page.width-34,100,'Date/time: Asia/Manila',8,{color:C.gray,align:'right'});
}

function passData(page, booking, type) {
  const isOut = type === 'GATE_OUT';
  const y=123, x=25, w=page.width-50, half=w/2;
  page.section(y,'Truck / Driver Information',isOut?C.blue:C.green,isOut?C.blueLight:C.greenLight);
  const fields = [
    [['Truck Plate No.',booking.truckPlateNumber],['Driver Licence No.',booking.driverLicenceNumber]],
    [['Driver Name',booking.driverName],['Hauler',booking.hauler]],
    [['Booking No.',booking.bookingReference],['Shipping Line',booking.shippingLine]],
  ];
  if(isOut) {
    fields.push([['Release Authorization',['APPROVED','RELEASED'].includes(booking.gateOut?.approvalStatus)?'Approved Gate-out request':'Pending review'],['Authorized By',booking.gateOut?.approvedBy]]);
    fields.push([['Release Order No.',''],['Gate-out Schedule',`${val(booking.gateOut?.scheduledDate)} ${val(booking.gateOut?.scheduledTime)}`.trim()]]);
  }
  fields.forEach((r,i)=>{
    page.field(x,y+23+i*24,half,24,r[0][0],r[0][1]);
    page.field(x+half,y+23+i*24,half,24,r[1][0],r[1][1]);
  });
  const containerY=y+23+fields.length*24+8;
  page.section(containerY,'Container Information',isOut?C.blue:C.green,isOut?C.blueLight:C.greenLight);
  const ci=booking.gateIn?.inspection||{};
  page.field(x,containerY+23,half,24,'Container No.',booking.containerNumber);
  page.field(x+half,containerY+23,half,24,'Seal No.',ci.sealNumber);
  page.field(x,containerY+47,half,24,'Size / Type',`${val(booking.containerSize)} / ${val(booking.containerType)}`);
  page.field(x+half,containerY+47,half,24,'Seal Intact',ci.sealIntact===null||ci.sealIntact===undefined?'Not recorded':ci.sealIntact?'Yes':'No');
  page.field(x,containerY+71,half,24,'Empty / Loaded',booking.loadStatus);
  page.field(x+half,containerY+71,half,24,'Shipping Line',booking.shippingLine);
  const conditionY=containerY+106;
  page.section(conditionY,isOut?'Condition Upon Release':'Condition Upon Entry',isOut?C.blue:C.green,isOut?C.blueLight:C.greenLight);
  const options=['GOOD','DENTED','RUST','HOLE','DOOR DAMAGE','OTHER'];
  const check = isOut ? [] : (booking.gateIn?.inspection?.containerCondition || []);
  const cellWidth=w/options.length;
  page.rect(x,conditionY+23,w,24,C.white,C.line);
  options.forEach((label,i)=>page.checkbox(x+13+i*cellWidth,conditionY+30,label,check.includes(label),C.ink,label.length>10?7:8));
  const remarksY=conditionY+52;
  page.section(remarksY,'Remarks',isOut?C.blue:C.green,isOut?C.blueLight:C.greenLight);
  page.rect(x,remarksY+23,w,36,C.white,C.line);
  page.text(x+8,remarksY+27,val(isOut?booking.gateOut?.remarks:ci.remarks),9,{maxWidth:w-16});
  const declarationY=remarksY+68;
  page.text(page.width/2,declarationY,isOut?'The driver acknowledges receipt of the container in the recorded condition.':'The driver acknowledges delivery of the container in the recorded condition.',8,{color:C.gray,align:'center'});
  page.text(page.width/2,declarationY+12,'Any observed damage or discrepancy must be recorded on this pass before signatures.',8,{color:C.gray,align:'center'});
  const sigY=declarationY+(isOut?35:44);
  page.line(67,sigY,376,sigY,C.ink,.9);page.line(461,sigY,page.width-67,sigY,C.ink,.9);
  page.text(221,sigY+6,'NAME & SIGNATURE - YARD CHECKER',9,{bold:true,align:'center'});
  page.text((461+page.width-67)/2,sigY+6,'NAME & SIGNATURE - DRIVER',9,{bold:true,align:'center'});
  page.text(page.width/2,page.height-30,'Printed from Trans Roadway Logistics Operations  |  '+upper(type.replace('_','-')),7.5,{color:C.gray,align:'center'});
}

/** Prints a one-page form, using real stored details. Not a booking approval. */
export function renderGatePassPdf({booking,type,now=new Date()}) {
  if(!['GATE_IN','GATE_OUT'].includes(type))throw new Error('Unknown gate pass type');
  const page=new Page(842,595);
  const entered=!!booking.gateIn?.actualGateInAt;
  const approved=booking.gateOut?.approvalStatus==='APPROVED'||booking.gateOut?.approvalStatus==='RELEASED';
  const status=type==='GATE_IN'?(entered?'GATE-IN CONFIRMED':'INSPECTION COPY - ENTRY NOT YET CONFIRMED')
    : booking.gateOut?.releasedAt?'RELEASED':approved?'APPROVED FOR RELEASE':'DRAFT - NOT VALID FOR RELEASE';
  header(page,type==='GATE_IN'?'GATE-IN PASS':'GATE-OUT PASS',type==='GATE_IN',booking.bookingReference,
    type==='GATE_IN'?(booking.gateIn?.actualGateInAt||booking.scheduledGateDateIn):
    (booking.gateOut?.releasedAt||booking.gateOut?.approvedAt||now),status);
  passData(page,booking,type);
  return makePdf([page]);
}

function invoiceHeader(page,invoice,booking,companyName,settings,pageNo,totalPages) {
  const w=page.width;
  page.rect(20,18,w-40,page.height-36,null,C.green,1);
  page.rect(29,28,w-58,68,C.greenLight,null);
  page.logo(40,35,58,31);
  page.text(104,30,'TRANS ROADWAY LOGISTICS INC.',12,{bold:true,color:C.blue,maxWidth:290});
  page.text(104,52,val(settings?.office,'Office address: (not configured)'),8,{color:C.gray,maxWidth:292});
  page.text(104,66,[settings?.phone,settings?.email].filter(Boolean).join('  |  '),8,{color:C.gray,maxWidth:294});
  page.text(w-40,35,'SERVICE',17,{bold:true,color:C.green,align:'right'});
  page.text(w-40,55,'INVOICE',17,{bold:true,color:C.green,align:'right'});
  page.rect(29,108,w-58,58,C.white,C.line);
  page.boxLabel(39,115,'INVOICE NUMBER',invoice.number,262,C.green);
  page.boxLabel(321,115,'DATE ISSUED',stamp(invoice.createdAt),208);
  page.boxLabel(39,142,'BOOKING REFERENCE',booking?.bookingReference,265);
  page.boxLabel(321,142,'TRANSACTION',invoice.type==='GATE_OUT'?'GATE-OUT':'GATE-IN',205);
  page.section(177,'Billed To',C.green,C.greenLight);
  page.field(29,200,267,42,'Client / Company',companyName||'');
  page.field(296,200,270,42,'Container',`${val(booking?.containerNumber)} / ${val(booking?.containerSize)}`);
  page.field(29,242,267,35,'Payment Channel','ONLINE ONLY');
  page.field(296,242,270,35,'Invoice Status',invoice.status);
  page.text(w-31,792,`Page ${pageNo} of ${totalPages}  |  Asia/Manila  |  Amounts in PHP`,8,{align:'right',color:C.gray});
}

function invoiceTable(page,lines) {
  const xs=[29,241,341,377,459,566];const top=291;
  page.rect(29,top,537,27,C.greenLight,C.green);
  const titles=['SERVICE / TRANSACTION','CONTAINER / UNIT','QTY','UNIT PRICE','AMOUNT'];
  for(let j=0;j<5;j++)page.text(xs[j]+5,top+7,titles[j],7.7,{bold:true,color:C.green,maxWidth:xs[j+1]-xs[j]-10});
  for(let i=0;i<11;i++){
    const y=318+i*22;
    page.rect(29,y,537,22,i%2===0?C.white:C.light,C.line,.4);
    const item=lines[i];
    if(item){
      const values=[item.description,item.unitRate?'Per '+(item.description?.toLowerCase().includes('storage')?'day':'container'):'',item.quantity,
        peso(item.unitRate),peso(item.amount)];
      for(let j=0;j<values.length;j++)page.text(xs[j]+5,y+6,values[j],8,{color:C.ink,maxWidth:xs[j+1]-xs[j]-10});
    }
  }
  xs.slice(1,-1).forEach(x=>page.line(x,291,x,560,C.line,.5));
}

function invoiceTotals(page,invoice,lines,showTotals) {
  if(!showTotals){page.text(36,583,'Additional transaction lines continue on the next page.',9,{color:C.gray});return;}
  const sums={TAXABLE:0,EXEMPT:0,ZERO_RATED:0};
  for(const line of lines){sums[line.taxTreatment||'TAXABLE']=(sums[line.taxTreatment||'TAXABLE']||0)+Number(line.amount||0);}
  const taxRate=Number(invoice.vatRate||0);
  const taxableBase=invoice.vatInclusive && taxRate? sums.TAXABLE/(1+taxRate/100):sums.TAXABLE;
  const info=[['VATable Sales',taxableBase],['Non-VATable Sales',sums.EXEMPT+sums.ZERO_RATED],['Zero-Rated Sales',sums.ZERO_RATED]];
  info.forEach(([label,value],i)=>{
    page.rect(29,578+i*22,234,22,C.white,C.line);
    page.text(36,584+i*22,label,8,{color:C.green,bold:true});
    page.text(256,584+i*22,peso(value),8,{align:'right'});
  });
  const summary=[['Subtotal',invoice.subtotal],['VAT ('+taxRate+'%)',invoice.vat],['Total Amount Due',invoice.total],['Amount Paid',invoice.paidAmount],['Balance',invoice.balance]];
  summary.forEach(([label,value],i)=>{
    page.rect(285,578+i*25,281,25,i===2?C.greenLight:C.white,C.line,.6);
    page.text(292,584+i*25,label,9,{bold:i===2,color:i===2?C.green:C.ink});
    page.text(559,584+i*25,peso(value),9,{bold:i===2,align:'right'});
  });
  page.text(30,721,'Prepared by:',8,{color:C.gray});page.line(30,748,199,748,C.line,.7);
  page.text(217,721,'Authorized by:',8,{color:C.gray});page.line(217,748,387,748,C.line,.7);
  page.text(406,721,'Received by:',8,{color:C.gray});page.line(406,748,565,748,C.line,.7);
  page.text(30,764,'This invoice reflects recorded rates and tax classifications when issued.',8,{color:C.gray});
}

/** Reference-format service invoice, with itemization, tax treatment and verified balance. */
export function renderServiceInvoicePdf({invoice,booking,companyName,settings={}}) {
  const lines=invoice.lines||[];
  const chunks=[];
  for(let i=0;i<lines.length;i+=11)chunks.push(lines.slice(i,i+11));
  if(!chunks.length)chunks.push([]);
  const pages=chunks.map((chunk,index)=>{
    const page=new Page(595,842);
    invoiceHeader(page,invoice,booking,companyName,settings,index+1,chunks.length);
    invoiceTable(page,chunk);
    invoiceTotals(page,invoice,lines,index===chunks.length-1);
    return page;
  });
  return makePdf(pages);
}
