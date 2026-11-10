import 'dotenv/config';
import mongoose from 'mongoose';
import PreAdvice from '../src/models/PreAdvice.js';
import HistoricalContainer from '../src/models/HistoricalContainer.js';
import StorageBlock from '../src/models/StorageBlock.js';
import StorageSlotClaim from '../src/models/StorageSlotClaim.js';
import { ACTIVE_HISTORICAL, positionKey, verifyStorageClaims } from '../src/services/storageAssignmentService.js';

/**
 * Dry run by default. Existing live / historical storage records are not
 * changed. Under a write-maintenance window, --apply creates unique slot
 * indexes and idempotently backfills the shared physical-slot registry.
 * Conflicts and orphan claims MUST be reconciled, never silently deleted.
 */
const applying = process.argv.includes('--apply');
const uri = process.env.MONGODB_URI || process.env.MONGO_URI;
if (!uri) throw new Error('MONGODB_URI is required.');
mongoose.set('autoIndex',false);
try {
  await mongoose.connect(uri, {autoIndex:false,serverSelectionTimeoutMS:10_000});
  const entries = await verifyStorageClaims();
  const [blocks, installed, legacyLive, legacyHistorical] = await Promise.all([
    StorageBlock.find().select('_id name containerSize capacityTeu layout').lean(),
    StorageSlotClaim.find().lean(),
    PreAdvice.countDocuments({'storage.status':'STORED','storage.block':{$ne:null},deletedAt:null,'gateOut.releasedAt':null}),
    HistoricalContainer.countDocuments({'storage.block':{$ne:null},status:{$in:ACTIVE_HISTORICAL},deletedAt:null,'gateOut.releasedAt':null}),
  ]);
  const byBlock = new Map(blocks.map(block => [String(block._id),block]));
  const byOwner = new Map(installed.map(claim => [`${claim.source}:${claim.container}`,claim]));
  const byPosition = new Map();
  for (const claim of installed) {
    const key=positionKey(claim);
    if(byPosition.has(key))throw new Error(`Conflicting existing slot claims: ${key}`);
    byPosition.set(key,claim);
  }
  const desired = new Map(), perBlock=new Map(), errors=[];
  for (const {doc,source} of entries) {
    const block=byBlock.get(String(doc.storage.block));
    const owner=`${source}:${doc._id}`;
    const key=positionKey(doc.storage);
    desired.set(owner,{source,container:doc._id,block:doc.storage.block,bay:doc.storage.bay,row:doc.storage.row,tier:doc.storage.tier});
    if(!block){errors.push(`Missing storage block for ${owner}`);continue;}
    if(doc.containerSize!==block.containerSize)errors.push(`Container size mismatch at ${key}: ${doc.containerSize} in ${block.containerSize} block`);
    if(doc.storage.bay>block.layout.bays || doc.storage.row>block.layout.rows || doc.storage.tier>block.layout.tiers){errors.push(`Out-of-range slot ${key}`);continue;}
    perBlock.set(String(block._id),(perBlock.get(String(block._id))||0)+1);
    const actual=byOwner.get(owner), occupant=byPosition.get(key);
    if(actual&&positionKey(actual)!==key)errors.push(`Claim for ${owner} points to another slot`);
    if(occupant && `${occupant.source}:${occupant.container}`!==owner)errors.push(`Slot ${key} already claimed by ${occupant.source}:${occupant.container}`);
  }
  for(const block of blocks) if((perBlock.get(String(block._id))||0)>block.capacityTeu)errors.push(`Block ${block.name} exceeds configured capacity`);
  for(const [owner,claim] of byOwner) if(!desired.has(owner)) errors.push(`Unmatched legacy claim: ${owner} at ${positionKey(claim)}`);
  const pending=[...desired].filter(([owner])=>!byOwner.has(owner)).map(([,doc])=>doc);
  console.log('[STORAGE_CLAIMS] Active live:',legacyLive,'historical:',legacyHistorical,'existing claims:',installed.length,'missing claims:',pending.length);
  if(errors.length) {
    for(const issue of errors.slice(0,40))console.error('[STORAGE_CLAIMS] CONFLICT:',issue);
    throw new Error(`${errors.length} storage inconsistencies found. No records were changed; resolve these before applying.`);
  }
  const indexes=[
    {name:'unique_storage_slot_cross_source',key:{block:1,bay:1,row:1,tier:1}},
    {name:'unique_active_container_claim',key:{source:1,container:1}},
  ];
  if(!applying) {
    console.log('[STORAGE_CLAIMS] DRY RUN successful. Back up MongoDB, pause Gate-In, releases and storage assignment writes, then run: npm run migrate:storage-claims -- --apply');
  } else {
    const collection=StorageSlotClaim.collection;
    for(const index of indexes)await collection.createIndex(index.key,{name:index.name,unique:true});
    for(const claim of pending) await StorageSlotClaim.updateOne({source:claim.source,container:claim.container},{$setOnInsert:claim},{upsert:true});
    const after=await collection.indexes();
    for(const index of indexes) if(!after.some(current=>current.name===index.name && current.unique===true && JSON.stringify(current.key)===JSON.stringify(index.key))) throw new Error(`Required storage index ${index.name} is missing or mismatched.`);
    if(await StorageSlotClaim.countDocuments()!==desired.size)throw new Error('Unexpected storage claim count. Keep storage writes paused until the differences are investigated.');
    console.log('[STORAGE_CLAIMS] Verified:',desired.size,'active slots protected by both unique indexes. No container or financial records changed.');
  }
} finally {
  await mongoose.disconnect();
}
