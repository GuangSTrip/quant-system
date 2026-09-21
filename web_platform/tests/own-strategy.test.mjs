import test from 'node:test';
import assert from 'node:assert/strict';
import {backtest,strategyConfig} from '../src/engine.mjs';
import {enhancedLedgerState} from '../src/automation.mjs';
import {setup} from './helpers.mjs';
const config={name:'本组自研',type:'enhanced_reversion',symbol:'TSLA',budget:1000,days:10,cost_bps:10,threshold_bps:60,time_stop_bars:60};
test('enhanced: sample-end liquidation leaves no phantom equity or positions',()=>{
 const base=Date.parse('2026-09-14T13:30:00Z'),bars=[];
 for(let d=0;d<2;d++)for(let i=0;i<40;i++){const p=i<30?100:99;bars.push({t:new Date(base+d*86400000+i*60000).toISOString(),o:p,h:p+.02,l:p-.02,c:p,v:10000});}
 const r=backtest(bars,{...config,budget:25000,time_stop_bars:390});
 assert.equal(r.decisions.at(-1).qty,0);assert.ok(Math.abs(r.curve.at(-1).equity-100000*(1+r.metrics.total_return))<1e-7);
 assert.equal(r.trades.reduce((n,t)=>n+(t.side==='buy'?t.qty:-t.qty),0),0);
 assert.equal(strategyConfig({type:'enhanced_reversion',symbol:'TSLA'}).threshold_bps,60);
});
test('own: public research, saved reproducible backtest, run archive, no implicit trading',async t=>{
 const h=setup(t);const data=await h.request('/api/v1/own/research');assert.equal(data.status,200,JSON.stringify(data.data));assert.equal(data.data.pool.length,9);assert.ok(data.data.demo.trades.length>0);
 const r=await h.request('/api/v1/backtests',{config,research_sample:true});assert.equal(r.status,200,JSON.stringify(r.data));assert.equal(r.data.kernel_revision,'own-enhanced-1');assert.match(r.data.data_source,/固定样本/);
 const again=await h.request('/api/v1/backtests',{config,snapshot_id:r.data.snapshot_id});assert.deepEqual(again.data.metrics,r.data.metrics);
 assert.equal(h.broker.posts().length,0);await h.resume();
 const start=await h.request('/api/v1/automation/start',{backtest_id:r.data.id,budget:1000,confirm:'启动自动模拟交易'});assert.equal(start.status,200,JSON.stringify(start.data));
 const records=await h.request('/api/v1/own/runs');assert.equal(records.status,200,JSON.stringify(records.data));assert.equal(records.data.runs.length,1);assert.equal(records.data.runs[0].config.type,'enhanced_reversion');assert.equal(records.data.runs[0].orders.length,0);
 await h.request('/api/v1/automation/pause',{});const stopped=await h.request('/api/v1/own/runs');assert.equal(stopped.data.runs[0].state,'已暂停');assert.equal(h.broker.posts().length,0);
 await h.request('/api/v1/auth/logout',{});assert.equal((await h.request('/api/v1/own/runs')).status,401);
});
test('enhanced: execution state is anchored on fills, ignores unfilled buy, protects overnight holding',async()=>{
 const records=[{broker_data:JSON.stringify({side:'buy',filled_qty:'0',updated_at:'2026-09-14T14:00:00Z'})},{broker_data:JSON.stringify({side:'buy',filled_qty:'10',filled_at:'2026-09-14T14:02:04Z'})}];
 const db={prepare:()=>({bind:()=>({all:async()=>({results:records})})})};
 const bars=[{t:'2026-09-14T14:00:00Z'},{t:'2026-09-14T14:01:00Z'},{t:'2026-09-14T14:02:00Z'}];
 const s=await enhancedLedgerState(db,'auto:x',bars,10);assert.equal(s.entriesToday,1);assert.equal(s.entryTime,bars[2].t);assert.equal(s.overnight,false);
 const next=await enhancedLedgerState(db,'auto:x',[{t:'2026-09-15T13:31:00Z'}],10);assert.equal(next.overnight,true);assert.equal(next.qty,10);
});
