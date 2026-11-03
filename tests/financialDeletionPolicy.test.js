import test from 'node:test';
import assert from 'node:assert/strict';
import {includesIssuedFinancialRecords,acknowledgedFinancialDeletion} from '../src/utils/financialDeletionPolicy.js';

test('pending or unpaid records do not require financial purge acknowledgement',()=>{
  assert.equal(includesIssuedFinancialRecords([{status:'UNPAID'}],[{status:'PENDING_VERIFICATION'}]),false);
});
test('paid invoices and any issued or reversed payment require acknowledgement',()=>{
  assert.equal(includesIssuedFinancialRecords([{status:'PAID'}],[]),true);
  for(const status of ['VERIFIED','REFUNDED','REVERSED','VOIDED']) assert.equal(includesIssuedFinancialRecords([],[{status}]),true);
});
test('financial delete acknowledgement requires the exact JSON boolean true',()=>{
  for(const value of [undefined,false,'true',1,{},null])assert.equal(acknowledgedFinancialDeletion({purgeFinancial:value}),false);
  assert.equal(acknowledgedFinancialDeletion({purgeFinancial:true}),true);
});
