import test from 'node:test';
import assert from 'node:assert/strict';
import {createAccountReader} from '../src/account-reader.mjs';
import {runLabel,runReason} from '../src/run-labels.mjs';
test('duplicate HK overview queries share one request and respect refresh interval',async()=>{
 let calls=0,time=0;const reader=createAccountReader(async()=>{calls++;return {ok:true,fetched_at:'original'};},()=>time);
 await Promise.all([reader.read('longbridge/overview'),reader.read('longbridge/overview')]);assert.equal(calls,1);
 time=5000;await reader.read('longbridge/overview');assert.equal(calls,1);
 time=6000;await reader.read('longbridge/overview');assert.equal(calls,2);
});
test('failed refresh retains visibly stale data but never on authentication failure',async()=>{
 let time=0,error=null;const reader=createAccountReader(async()=>{if(error)throw error;return {ok:true,fetched_at:'original'};},()=>time);
 await reader.read('longbridge/overview');time=6000;error=Error('temporary');
 const stale=await reader.read('longbridge/overview');assert.equal(stale.stale,true);assert.equal(stale.fetched_at,'original');
 error=Object.assign(Error('login required'),{status:401});await assert.rejects(reader.read('longbridge/overview'));
});
test('unstarted, running, paused and completed are distinct and US scope is explicit',()=>{
 assert.equal(runLabel(null),'尚未启动');assert.equal(runLabel({run_id:'1',enabled:true}),'运行中');assert.equal(runLabel({run_id:'1',enabled:false}),'已暂停');assert.equal(runLabel({run_id:'1',outcome:'completed'}),'已结束');assert.equal(runReason('全局交易已暂停'),'美股交易已暂停');assert.equal(runReason('waiting_connection'),'连接波动，后台自动重试');
});

test('concurrent catalog reads coalesce without caching completed rankings or sharing sources',async()=>{
 const calls=[],reader=createAccountReader(async path=>{calls.push(path);return {revision:calls.length};});
 const a=await Promise.all([reader.read('portfolio/catalog'),reader.read('portfolio/catalog?source=latest'),reader.read('portfolio/catalog?source=reference')]);
 assert.equal(calls.length,2);assert.deepEqual(a[0],a[1]);assert.notDeepEqual(a[0],a[2]);
 assert.equal((await reader.read('portfolio/catalog')).revision,3);
});
