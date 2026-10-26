import test from 'node:test';
import assert from 'node:assert/strict';
import {getManilaTodayAndHour,validateHourlySchedule} from '../src/utils/scheduleValidation.js';
import {advanceWorkflow} from '../src/utils/preAdviceWorkflow.js';

test('Manila time conversion uses GMT+8',()=>{
 const t=getManilaTodayAndHour(new Date('2026-10-26T16:15:00Z'));
 assert.deepEqual(t,{today:'2026-10-27',hour:0});
});
test('hourly booking validation rejects non-hourly timestamps',()=>{
 assert.match(validateHourlySchedule('2099-01-02','09:30'),/1-hour/);
});
test('hourly booking validation rejects past dates',()=>{
 assert.match(validateHourlySchedule('2020-01-01','10:00'),/past/);
});
test('workflow advancement records each stage once',()=>{
 const item={workflowHistory:[],workflowStage:'BOOKING_SUBMITTED'};
 advanceWorkflow(item,['BOOKING_APPROVED','READY_FOR_GATE_IN']);
 advanceWorkflow(item,'READY_FOR_GATE_IN');
 assert.equal(item.workflowStage,'READY_FOR_GATE_IN');
 assert.equal(item.workflowHistory.length,2);
});
