import test from 'node:test';
import assert from 'node:assert/strict';
import {setup} from './helpers.mjs';
import {runPerformance,createRunHistory,recordRunMark} from '../src/portfolio-history.mjs';
import {performance,sortStrategies,rankedCatalog} from '../src/portfolio-ranking.mjs';
const strategy='US:near_high:breakout:inverse_vol:base';
const at=new Date().toISOString();
const order=(side,filled,price,extra={})=>({symbol:'A',side,filled,price,...extra});
test('ranking handles negative returns, positive/negative drawdown, missing values and zero risk',()=>{
 assert.equal(performance({full:{cagr_pct:10,max_drawdown_pct:-5}}).ratio,2);
 assert.equal(performance({full:{cagr_pct:10,max_drawdown_pct:0}}).ratio,null);
 const a={name:'A',metrics:{annual:-2,drawdown:1,ratio:-2}},b={name:'B',metrics:{annual:10,drawdown:5,ratio:2}},c={name:'C',metrics:{annual:null,drawdown:null,ratio:null}};
 assert.deepEqual(sortStrategies([c,a,b],'annual'),[b,a,c]);assert.deepEqual(sortStrategies([c,b,a],'drawdown'),[a,b,c]);assert.deepEqual(sortStrategies([a,c,b],'ratio'),[b,a,c]);
});
test('confirmed fills only; flat gross PnL excludes missing fees instead of inventing net profit',()=>{
 const m=runPerformance([order('buy',100,37.48),order('sell',100,37.5),order('buy',0,999)],62000);
 assert.ok(Math.abs(m.realized-2)<1e-8);assert.ok(Math.abs(m.total-2)<1e-8);assert.equal(m.unrealized,0);assert.equal(m.net,null);assert.equal(m.filled_orders,2);
});
test('partial fills, remaining stock, stale/missing quotes and invalid receipt cannot fake profit',()=>{
 const orders=[order('buy',100,10),order('sell',40,12)];let m=runPerformance(orders,10000,{A:{price:11,asof:at}});
 assert.equal(m.realized,80);assert.equal(m.unrealized,60);assert.equal(m.positions[0].qty,60);
 m=runPerformance(orders,10000,{A:{price:11,asof:'2020-01-01'}});assert.equal(m.realized,80);assert.equal(m.total,null);assert.equal(m.return_pct,null);
 assert.equal(runPerformance([order('sell',10,11)],1000).realized,null);
 assert.equal(runPerformance([order('buy',10,null)],1000).complete,false);
});
async function started(t){const f=setup(t);f.env.SCHEDULER_NATIVE='true';await f.resume();const date=new Date(Date.now()-86400000).toISOString().slice(0,10);
 const signal={schema_version:1,strategy_id:strategy,strategy_version:'modular-close-1',market:'US',currency:'USD',available:true,signal_date:date,rebalance_date:date,data_asof:date+'T00:00:00Z',execute_after:new Date(Date.now()-1000).toISOString(),expires_at:new Date(Date.now()+3600000).toISOString(),liquidity_caps:{NVDA:1e9},origin:'2024-01-02',data_digest:'a'.repeat(64),targets:[{symbol:'NVDA',weight:.1}],cash_weight:.9};
 assert.equal((await f.request('/api/v1/portfolio/signals',signal)).status,200);
 const r=await f.request('/api/v1/portfolio/start',{strategy_id:strategy,budget:1000,confirm:'启动组合自动模拟交易'});assert.equal(r.status,200,JSON.stringify(r.data));return {...f,id:r.data.runs[0].run_id};
}
test('history requires authentication; a finished run survives release with original signal and budget',async t=>{
 const f=await started(t);assert.equal((await f.request('/api/v1/portfolio/history',undefined,{auth:false})).status,401);
 assert.equal((await f.request('/api/v1/portfolio/history/detail?id='+f.id,undefined,{auth:false})).status,401);
 await f.request('/api/v1/portfolio/pause',{market:'US'});assert.equal((await f.request('/api/v1/portfolio/release',{market:'US'})).status,200);
 assert.equal(f.db.get('SELECT count(*) n FROM portfolio_runs').n,0);
 const list=(await f.request('/api/v1/portfolio/history')).data;assert.equal(list.total,1);assert.equal(list.runs[0].status,'ended');
 const d=(await f.request('/api/v1/portfolio/history/detail?id='+f.id)).data;assert.equal(d.run.budget,1000);assert.equal(d.run.initial_signal.targets[0].symbol,'NVDA');assert.equal(d.metrics.total,0);assert.equal(d.run.legacy,false);assert.equal(f.broker.posts().length,0);
 assert.ok(d.events.some(e=>e.kind==='portfolio_started'));assert.ok(d.events.some(e=>e.kind==='portfolio_paused'));
});
test('failed archive leaves management lock and original run intact',async t=>{
 const f=await started(t);await f.request('/api/v1/portfolio/pause',{market:'US'});f.db.fail=sql=>sql.includes("SELECT ?,'portfolio_run_history'");
 const r=await f.request('/api/v1/portfolio/release',{market:'US'});assert.equal(r.status,503);assert.equal(f.db.get('SELECT run_id FROM portfolio_runs').run_id,f.id);
});
test('legacy decisions recover run identity; missing budget remains unknown and reads never submit',async t=>{
 const f=setup(t),id='legacy-run';f.db.sqlite.prepare('INSERT INTO portfolio_decisions VALUES(?,?,?,?,?,?)').run(id+':buy',id,'sig','buy',JSON.stringify({orders:[],signal:{strategy_id:strategy,market:'US',targets:[]}}),at);
 const d=await f.request('/api/v1/portfolio/history/detail?id='+id);assert.equal(d.status,200);assert.equal(d.data.run.legacy,true);assert.equal(d.data.run.budget,null);assert.equal(d.data.metrics.return_pct,null);assert.equal(f.broker.posts().length,0);
});
test('ranking leaves missing latest report missing and separates dates from reference research',async t=>{
 const f=setup(t),catalog=new Map([['x',{id:'x',market:'US',name:'x',report:{dates:['2020-01-01','2020-02-01'],full:{cagr_pct:5,max_drawdown_pct:-2}}}]]);
 const a=await rankedCatalog(f.db,catalog);assert.equal(a.strategies[0].metrics.annual,null);
 const b=await rankedCatalog(f.db,catalog,'reference');assert.equal(b.strategies[0].metrics.annual,5);assert.notEqual(a.strategies[0].cohort,b.strategies[0].cohort);
});
test('monitor stores only valid valuations and coalesces the five-minute bucket',async t=>{
 const f=setup(t),s={run_id:'m',budget:1000};await recordRunMark(f.db,s,[order('buy',10,10)],{});assert.equal(f.db.get("SELECT count(*) n FROM artifacts WHERE kind='portfolio_run_mark'").n,0);
 await recordRunMark(f.db,s,[order('buy',10,10)],{A:{price:11,asof:at}});await recordRunMark(f.db,s,[order('buy',10,10)],{A:{price:12,asof:at}});assert.equal(f.db.get("SELECT count(*) n FROM artifacts WHERE kind='portfolio_run_mark'").n,1);
});
