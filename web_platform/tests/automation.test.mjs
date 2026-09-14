import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../worker/index.js';
import {setup,orderInput} from './helpers.mjs';
async function start(t,type='buy_hold'){const h=setup(t);h.env.SCHEDULER_NATIVE='true';await worker.scheduled({},h.env);await h.resume();const report=await h.request('/api/v1/backtests',{config:{symbol:'SPY',type,allocation:.01}});const r=await h.request('/api/v1/automation/start',{backtest_id:report.data.id,budget:1000,confirm:'启动自动模拟交易'});assert.equal(r.data.state.enabled,1,JSON.stringify(r.data));return h;}
test('background scheduled event submits without a browser request and deduplicates a completed daily decision',async t=>{
 const {env,broker,db}=await start(t);await worker.scheduled({},env);assert.equal(broker.posts().length,1);
 const order=[...broker.orders.values()][0];order.status='canceled';await worker.scheduled({},env);assert.equal(broker.posts().length,1);assert.equal(db.get('SELECT COUNT(*) n FROM auto_decisions').n,1);assert.equal(db.get('SELECT last_outcome FROM auto_strategy').last_outcome,'already_evaluated');
});
test('closed market only records waiting and scheduler heartbeats never authorize trading',async t=>{
 const h=setup(t);h.env.SCHEDULER_NATIVE='true';await worker.scheduled({},h.env);assert.equal(h.broker.posts().length,0);assert.ok(h.db.get('SELECT heartbeat_at FROM auto_strategy').heartbeat_at);
});
test('active strategy waits over market closure and starts on a later scheduled invocation',async t=>{
 const h=await start(t);h.broker.clock.is_open=false;await worker.scheduled({},h.env);assert.equal(h.broker.posts().length,0);assert.equal(h.db.get('SELECT last_outcome FROM auto_strategy').last_outcome,'market_closed');h.broker.clock.is_open=true;await worker.scheduled({},h.env);assert.equal(h.broker.posts().length,1);
});
test('pause blocks future scheduled execution and same-symbol manual orders require pause',async t=>{
 const h=await start(t);assert.equal((await h.request('/api/v1/orders',orderInput())).data.code,'STRATEGY_OWNS_SYMBOL');await h.request('/api/v1/automation/pause',{});await worker.scheduled({},h.env);assert.equal(h.broker.posts().length,0);assert.equal((await h.request('/api/v1/orders',orderInput())).data.ok,true);
});
test('pause racing broker acceptance requests cancellation of the in-flight strategy order',async t=>{
 const h=await start(t);h.broker.onPost=async p=>{await h.request('/api/v1/automation/pause',{});return Response.json(h.broker.put(p));};await worker.scheduled({},h.env);assert.equal(h.broker.posts().length,1);assert.equal([...h.broker.orders.values()][0].status,'canceled');assert.equal(h.db.get('SELECT enabled FROM auto_strategy').enabled,0);
});
test('concurrent scheduler invocations use a persistent lease and cannot submit twice',async t=>{
 const h=await start(t);let entered,release;const reached=new Promise(r=>entered=r),gate=new Promise(r=>release=r);h.broker.onGet=async u=>{if(u.pathname==='/v2/stocks/bars'){entered();await gate;}return null;};const first=worker.scheduled({},h.env);await reached;assert.equal((await worker.scheduled({},h.env)).outcome,'busy');release();await first;assert.equal(h.broker.posts().length,1);
});
test('unknown submission pauses both strategy and global order entry without blind retry',async t=>{
 const h=await start(t);h.broker.onPost=()=>{throw Error('connection lost');};await worker.scheduled({},h.env);assert.equal(h.db.get('SELECT enabled FROM auto_strategy').enabled,0);assert.equal(h.db.get('SELECT halted FROM control').halted,1);await worker.scheduled({},h.env);assert.equal(h.broker.posts().length,1);
});
test('external position drift pauses automation instead of selling unowned positions',async t=>{
 const h=await start(t);h.broker.positions=[{symbol:'SPY',qty:'1',market_value:'100'}];await worker.scheduled({},h.env);assert.equal(h.broker.posts().length,0);assert.equal(h.db.get('SELECT enabled FROM auto_strategy').enabled,0);assert.match(h.db.get('SELECT reason FROM auto_strategy').reason,/持仓/);
});
test('daily loss is monitored and halts even when no new signal is available',async t=>{
 const h=await start(t);h.broker.account.equity='90000';h.broker.account.cash='90000';await worker.scheduled({},h.env);assert.equal(h.db.get('SELECT halted FROM control').halted,1);assert.equal(h.db.get('SELECT enabled FROM auto_strategy').enabled,0);assert.equal(h.broker.posts().length,0);
});
test('stale quote cannot leak an automatic order',async t=>{
 const h=await start(t);h.broker.quote.latestQuote.t='2020-01-01T00:00:00Z';await worker.scheduled({},h.env);assert.equal(h.broker.posts().length,0);assert.equal(h.db.get('SELECT enabled FROM auto_strategy').enabled,0);
});
test('an interrupted runner is not automatically taken over',async t=>{
 const h=await start(t);h.db.sqlite.prepare('UPDATE auto_strategy SET lease_id=?,lease_until=?').run('abandoned',Date.now()-1);await worker.scheduled({},h.env);assert.equal(h.broker.posts().length,0);assert.equal(h.db.get('SELECT enabled FROM auto_strategy').enabled,0);
});
test('missing heartbeat allows authorized start and manual execution without fabricating background health',async t=>{
 const h=setup(t);h.env.SCHEDULER_NATIVE='true';await h.resume();
 const report=await h.request('/api/v1/backtests',{config:{symbol:'SPY',type:'buy_hold',allocation:.01}});
 const input={backtest_id:report.data.id,budget:1000,confirm:'启动自动模拟交易'};
 assert.equal((await h.request('/api/v1/automation/start',input,{auth:false})).status,401);
 assert.notEqual((await h.request('/api/v1/automation/start',{...input,confirm:''})).status,200);
 const started=await h.request('/api/v1/automation/start',input);assert.equal(started.data.state.enabled,1);assert.equal(started.data.state.execution_state,'awaiting_execution');assert.equal(started.data.scheduler.healthy,false);assert.equal(h.broker.posts().length,0);
 assert.equal((await h.request('/api/v1/automation/tick',{}, {auth:false})).status,401);
 assert.equal((await h.request('/api/v1/scheduler/tick',{}, {auth:false})).status,503);
 await h.request('/api/v1/automation/tick',{});assert.equal(h.broker.posts().length,1);
 let status=(await h.request('/api/v1/automation')).data;assert.equal(status.state.execution_state,'manual_checked');assert.equal(status.state.last_execution_source,'manual');assert.equal(status.scheduler.healthy,false);assert.equal(status.state.heartbeat_at,null);
 await h.request('/api/v1/automation/tick',{});assert.equal(h.broker.posts().length,1);
 await worker.scheduled({},h.env);status=(await h.request('/api/v1/automation')).data;assert.equal(status.state.execution_state,'scheduled_checked');assert.equal(status.scheduler.healthy,true);assert.equal(h.broker.posts().length,1);
});
test('expired heartbeat allows resume but resets prior execution status and retains global halt guard',async t=>{
 const h=await start(t);await h.request('/api/v1/automation/tick',{});await h.request('/api/v1/automation/pause',{});
 const stale=new Date(Date.now()-3*3600000).toISOString();h.db.sqlite.prepare('UPDATE auto_strategy SET heartbeat_at=?').run(stale);
 h.db.sqlite.prepare('UPDATE control SET halted=1').run();assert.equal((await h.request('/api/v1/automation/resume',{confirm:'启动自动模拟交易'})).data.code,'HALTED');
 await h.resume();const resumed=await h.request('/api/v1/automation/resume',{confirm:'启动自动模拟交易'});assert.equal(resumed.data.state.enabled,1);assert.equal(resumed.data.state.execution_state,'awaiting_execution');assert.equal(resumed.data.state.last_check_at,null);assert.equal(resumed.data.scheduler.healthy,false);assert.equal(resumed.data.state.heartbeat_at,stale);
});

test('automatic buy, broker fill reconciliation, and next daily exit preserve the strategy position ledger',async t=>{
 const h=await start(t,'momentum');let held=0;
 h.broker.onPost=p=>{const qty=Number(p.qty);held+=(p.side==='buy'?1:-1)*qty;h.broker.positions=held?[{symbol:'SPY',qty:String(held),market_value:String(held*100)}]:[];h.broker.account.cash=String(100000-held*100);h.broker.account.long_market_value=String(held*100);return Response.json(h.broker.put(p,{status:'filled',filled_qty:p.qty,filled_avg_price:'100',filled_at:new Date().toISOString()}));};
 await worker.scheduled({},h.env);assert.equal(h.broker.posts()[0].payload.side,'buy');assert.ok(held>0);
 const last=h.broker.historical.at(-1),barTime=new Date(Date.parse(last.t)+86400000).toISOString();h.broker.historical.push({t:barTime,o:50,c:50,h:51,l:49,v:50000});h.broker.clock.timestamp=new Date(Date.now()+86400000).toISOString();h.broker.quote.latestQuote.t=h.broker.clock.timestamp;
 await worker.scheduled({},h.env);assert.equal(h.broker.posts().length,2);assert.equal(h.broker.posts()[1].payload.side,'sell');assert.equal(held,0);assert.equal(h.db.get('SELECT enabled FROM auto_strategy').enabled,1);
});
test('failure persisting a decision prevents the broker side effect',async t=>{
 const h=await start(t);h.db.fail=sql=>sql.startsWith('INSERT INTO auto_decisions');await worker.scheduled({},h.env);assert.equal(h.broker.posts().length,0);assert.equal(h.db.get('SELECT enabled FROM auto_strategy').enabled,0);
});

test('failure to persist a fault pause retains the recovery lease and cannot silently restart',async t=>{
 const h=await start(t);h.broker.quote.latestQuote.t='2020-01-01T00:00:00Z';h.db.fail=sql=>sql.startsWith('UPDATE auto_strategy SET enabled=0');
 await assert.rejects(worker.scheduled({},h.env));assert.equal(h.broker.posts().length,0);assert.ok(h.db.get('SELECT lease_id FROM auto_strategy').lease_id);
 h.db.fail=null;h.broker.quote.latestQuote.t=h.broker.clock.timestamp;assert.equal((await worker.scheduled({},h.env)).outcome,'busy');assert.equal(h.broker.posts().length,0);
 h.db.sqlite.prepare('UPDATE auto_strategy SET lease_until=?').run(Date.now()-1);await worker.scheduled({},h.env);assert.equal(h.db.get('SELECT enabled FROM auto_strategy').enabled,0);assert.equal(h.broker.posts().length,0);
});
