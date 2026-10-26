import Invoice from '../models/Invoice.js';
import Rate from '../models/Rate.js';
import SiteSettings from '../models/SiteSettings.js';
import {nextReference} from '../utils/referenceNumbers.js';
import {AppError} from '../utils/http.js';
import {priceLines, getOptionalRateChoices, optionalPriceLines, parseOptionalRateIds, totalsForLines} from '../utils/billingMath.js';

async function activeRates(type, session = null) {
  const query = Rate.find({status:'ACTIVE',collectionPoint:type,$or:[{effectiveFrom:null},{effectiveFrom:{$exists:false}},{effectiveFrom:{$lte:new Date()}}]});
  return (session ? query.session(session) : query).lean();
}
export async function availableOptionalCharges(booking, type, session = null) {
  try { return getOptionalRateChoices(await activeRates(type, session), booking,type); }
  catch(error) { throw new AppError(error.message,409); }
}
export async function calculateInvoice(booking,type,options={}) {
  if(!['GATE_IN','GATE_OUT'].includes(type))throw new AppError('Invalid invoice type.',400);
  const settings=await SiteSettings.findOne({key:'COMPANY_CONTACT'}).lean()||{};
  const rates=await activeRates(type);
  try {
    const ids = parseOptionalRateIds(options.optionalRateIds || []);
    const quoted=priceLines(rates,booking,type,settings,new Date(),ids);
    if(!quoted.lines.length)throw new AppError(`No ${type} rate is configured for this container; contact the terminal administrator.`,409);
    return {...quoted,optionalRateIds:ids,balance:quoted.total};
  } catch(err) { if(err instanceof AppError)throw err;throw new AppError(err.message,409); }
}

/** Rebuild ONLY manually selected charges; preserve existing automatic line snapshots. */
export async function updateUnpaidInvoiceOptionalCharges(invoice, booking, selectedRateIds, session = null) {
  if(invoice.status!=='UNPAID' || invoice.type!=='GATE_IN')throw new AppError('Only an unpaid Gate-in invoice can be adjusted before payment submission.',409);
  try {
    const ids=parseOptionalRateIds(selectedRateIds);
    const rates=await activeRates(invoice.type,session);
    const optionalLines=optionalPriceLines(rates,booking,ids,invoice.type);
    // Old invoices do not have isOptional, so their original fixed lines are retained.
    const automaticLines=(invoice.lines||[]).filter(line=>!line.isOptional)
      .map(line=>({description:line.description,quantity:line.quantity,unitRate:line.unitRate,amount:line.amount,taxTreatment:line.taxTreatment,rateId:line.rateId,isOptional:false}));
    const totals=totalsForLines([...automaticLines,...optionalLines],invoice.vatRate,invoice.vatInclusive);
    Object.assign(invoice,totals,{optionalRateIds:ids,paidAmount:0,balance:totals.total});
    return invoice;
  } catch(err) { if(err instanceof AppError)throw err;throw new AppError(err.message,409); }
}

export async function requirePaid(booking,type){
  const invoice=await Invoice.findOne({booking:booking._id,type});
  if(!invoice||invoice.status!=='PAID'||invoice.balance>0)throw new AppError(`${type.replace('_','-')} invoice must be verified first.`,409);
  return invoice;
}
export async function buildInvoice(booking,type){
  const existing=await Invoice.findOne({booking:booking._id,type});
  if(existing)return existing;
  const quote=await calculateInvoice(booking,type);
  try{
    return await Invoice.create({...quote,number:await nextReference('INVOICE'),booking:booking._id,company:booking.company?._id||booking.company,type,status:quote.total===0?'PAID':'UNPAID'});
  }catch(err){if(err.code===11000){const found=await Invoice.findOne({booking:booking._id,type});if(found)return found;}throw err;}
}
