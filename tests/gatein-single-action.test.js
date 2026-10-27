import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { parseGateInInspection } from '../src/utils/gateInInspection.js';
const good={status:'ACCEPTED',sealNumber:'ABC123',sealIntact:true,containerCondition:['GOOD'],remarks:'No damage'};
const read=()=>fs.readFileSync(new URL('../src/controllers/operationsController.js',import.meta.url),'utf8');

test('inspection parser accepts complete physical arrival data',()=>{
  const data=parseGateInInspection(good,'admin-1',new Date('2026-10-27T00:00:00Z'));
  assert.equal(data.status,'ACCEPTED');
  assert.equal(data.sealNumber,'ABC123');
  assert.deepEqual(data.containerCondition,['GOOD']);
  assert.equal(data.inspectedBy,'admin-1');
});
test('inspection requires seal, intact status, and condition',()=>{
  for(const changed of [{sealNumber:''},{sealIntact:undefined},{containerCondition:[]}]) {
    assert.throws(()=>parseGateInInspection({...good,...changed},'admin-1'));
  }
});
test('inspection rejects invalid conflicting conditions and missing rejection reason',()=>{
  assert.throws(()=>parseGateInInspection({...good,containerCondition:['GOOD','DENTED']},'admin-1'),/GOOD cannot/);
  assert.throws(()=>parseGateInInspection({...good,status:'REJECTED',rejectionReason:''},'admin-1'),/Rejection reason/);
  assert.equal(parseGateInInspection({...good,status:'REJECTED',rejectionReason:'Damaged'},'admin-1').status,'REJECTED');
});
test('physical Gate-in commits accepted inspection and inventory in one transaction',()=>{
  const controller=read();
  const fn=controller.split('export const processGateIn =')[1].split('export const listInventory =')[0];
  assert.match(fn,/withTransaction/);
  assert.match(fn,/type:'GATE_IN',status:'PAID',balance:0/);
  assert.match(fn,/gateIn\?\.payment\?\.status!=='VERIFIED'/);
  assert.match(fn,/parseGateInInspection/);
  assert.match(fn,/item\.gateIn\.inspection=inspection/);
  assert.match(fn,/item\.gateIn\.actualGateInAt=now/);
  assert.match(fn,/item\.inventory\.status='IN_YARD'/);
  assert.match(fn,/await item\.save\(\{session\}\)/);
});
test('separate inspection endpoint cannot commit ACCEPTED status',()=>{
  const fn=read().split('export const inspectGateIn =')[1].split('async function applyGateInPayment')[0];
  assert.match(fn,/status === 'ACCEPTED'/);
  assert.match(fn,/Use Confirm Physical Gate-in/);
});
