import test from 'node:test';
import assert from 'node:assert/strict';
import {setup} from './helpers.mjs';

const risk={max_order:20000,max_daily:100000,max_position:.25,max_loss:.05};
async function report(h){return (await h.request('/api/v1/backtests',{config:{symbol:'SPY',type:'buy_hold',allocation:.01}})).data;}
test('operator can set amounts above old ceilings and execute a budget above 10000',async t=>{
 const h=setup(t);
 const update=await h.request('/api/v1/risk',risk);assert.equal(update.status,200,JSON.stringify(update.data));
 assert.equal(update.data.control.max_order,20000);assert.equal(update.data.control.max_daily,100000);
 await h.resume();const r=await report(h);
 const started=await h.request('/api/v1/automation/start',{backtest_id:r.id,budget:20000,confirm:'启动自动模拟交易'});
 assert.equal(started.status,200,JSON.stringify(started.data));assert.equal(started.data.state.budget,20000);
 assert.equal(started.data.limits.max_order,20000);assert.equal(started.data.limits.max_daily,100000);
 const tick=await h.request('/api/v1/automation/tick',{});assert.equal(tick.data.outcome,'submitted',JSON.stringify(tick.data));
 assert.equal(h.broker.posts().length,1);const order=h.broker.posts()[0].payload;
 assert.ok(Number(order.qty)*Number(order.limit_price)>10000);assert.ok(Number(order.qty)*Number(order.limit_price)<=20000);
});
test('saved operator limit still bounds budgets and later reductions block order execution',async t=>{
 const h=setup(t);await h.request('/api/v1/risk',risk);await h.resume();const r=await report(h);
 const input={backtest_id:r.id,budget:20001,confirm:'启动自动模拟交易'};
 const rejected=await h.request('/api/v1/automation/start',input);assert.equal(rejected.data.code,'STRATEGY_BUDGET_LIMIT');
 assert.match(rejected.data.error,/20000/);assert.equal(h.broker.posts().length,0);
 await h.request('/api/v1/automation/start',{...input,budget:20000});
 await h.request('/api/v1/risk',{...risk,max_order:2500});
 const tick=await h.request('/api/v1/automation/tick',{});assert.equal(tick.data.outcome,'fault');
 assert.equal(tick.data.code,'ORDER_LIMIT');assert.equal(h.broker.posts().length,0);
});
test('amount configuration still requires login, finite values and consistent daily limits',async t=>{
 const h=setup(t);
 assert.equal((await h.request('/api/v1/risk',risk,{auth:false})).status,401);
 for(const max_order of [null,-1,'Infinity',Number.MAX_SAFE_INTEGER]){
  assert.notEqual((await h.request('/api/v1/risk',{...risk,max_order})).status,200);
 }
 assert.notEqual((await h.request('/api/v1/risk',{...risk,max_daily:1000})).status,200);
 assert.equal(h.broker.posts().length,0);
});
