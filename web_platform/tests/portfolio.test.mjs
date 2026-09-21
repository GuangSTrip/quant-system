import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {setup,orderInput} from './helpers.mjs';
import {buildPortfolioCatalog,validateSignal,deltaOrders} from '../src/portfolio-contract.mjs';
const catalog=buildPortfolioCatalog(...['modular-daily-results','daily-refinement'].map(n=>JSON.parse(readFileSync(new URL('../src/'+n+'.json',import.meta.url)))));
const strategy='US:near_high:breakout:inverse_vol:base';
function signal(id=strategy,targets=[{symbol:'NVDA',weight:.1},{symbol:'GOOGL',weight:.1}],days=1){const e=catalog.get(id),date=new Date(Date.now()-days*86400000).toISOString().slice(0,10);return {schema_version:1,strategy_id:id,strategy_version:e.version,market:e.market,currency:e.currency,available:true,signal_date:date,rebalance_date:date,data_asof:date+'T00:00:00Z',execute_after:new Date(Date.now()-1000).toISOString(),expires_at:new Date(Date.now()+3600000).toISOString(),liquidity_caps:Object.fromEntries(targets.map(t=>[t.symbol,1e9])),origin:'2024-01-02',data_digest:'a'.repeat(64),targets,cash_weight:1-targets.reduce((a,t)=>a+t.weight,0)};}
async function fixture(t){const f=setup(t);f.env.SCHEDULER_NATIVE='true';await f.resume();f.db.sqlite.exec('UPDATE control SET max_daily=100000');return f;}
async function start(f,s=signal()){let r=await f.request('/api/v1/portfolio/signals',s);assert.equal(r.status,200,JSON.stringify(r.data));r=await f.request('/api/v1/portfolio/start',{strategy_id:s.strategy_id,budget:10000,confirm:'启动组合自动模拟交易'});assert.equal(r.status,200,JSON.stringify(r.data));return r;}
function fill(f){for(const o of f.broker.orders.values()){if(o.status==='filled')continue;o.filled_qty=o.qty;o.filled_avg_price=o.limit_price;o.status='filled';const n=Number(o.qty)*(o.side==='buy'?1:-1),p=f.broker.positions.find(p=>p.symbol===o.symbol);if(p){p.qty=String(Number(p.qty)+n);p.market_value=String(Number(p.qty)*100);}else f.broker.positions.push({symbol:o.symbol,qty:String(n),market_value:String(n*100)});f.broker.account.cash=String(Number(f.broker.account.cash)-n*Number(o.limit_price));}f.broker.positions=f.broker.positions.filter(p=>Number(p.qty));f.broker.account.long_market_value=String(f.broker.positions.reduce((a,p)=>a+Number(p.market_value),0));f.broker.account.equity=String(Number(f.broker.account.cash)+Number(f.broker.account.long_market_value));}

test('catalog covers every original/refined strategy, version and market without duplicates',()=>{
 assert.equal(catalog.size,178);for(const m of ['US','HK','CN']){assert.equal([...catalog.values()].filter(e=>e.market===m&&e.recommended).length,1);}
 for(const e of catalog.values()){assert.equal(e.report.equity.length,e.report.dates.length);assert.equal(e.currency,{US:'USD',HK:'HKD',CN:'CNY'}[e.market]);}
});
test('signals reject cross-market, unavailable, duplicate, stale, future, leveraged and unversioned targets',()=>{
 const e=catalog.get(strategy),s=signal();assert.equal(validateSignal(s,e).targets.length,2);
 for(const patch of [{market:'HK'},{currency:'HKD'},{available:false},{targets:[s.targets[0],s.targets[0]]},{strategy_version:'old'},{expires_at:'2020-01-01'},{data_asof:new Date(Date.now()+86400000).toISOString()},{cash_weight:0},{targets:[{symbol:'NVDA',weight:NaN}]},{targets:[{symbol:'700.HK',weight:.2}]}])assert.throws(()=>validateSignal({...s,...patch},e));
});
test('lot-aware deltas zero removed symbols, reserve fees and never use sale proceeds before fills',()=>{
 const quotes={A:{price:10,lot:100,tradable:true},B:{price:20,lot:100,tradable:true}};
 assert.deepEqual(deltaOrders({targets:[{symbol:'B',weight:.8}],liquidity_caps:{A:1e9,B:1e9}},{A:100},quotes,10000,0,'HK'),[{symbol:'A',side:'sell',qty:100,price:10,lot_size:100}]);
 const buy=deltaOrders({targets:[{symbol:'B',weight:.8}],liquidity_caps:{A:1e9,B:1e9}},{},quotes,10000,2500,'HK');assert.equal(buy[0].qty,100);assert.throws(()=>deltaOrders({targets:[],liquidity_caps:{A:1e9}},{A:101},quotes,10000,500,'HK'));
});
test('portfolio catalog/report public; writes require auth/CSRF and CN requires a fresh signal',async t=>{
 const f=await fixture(t);assert.equal((await f.request('/api/v1/portfolio/catalog',undefined,{auth:false})).data.strategies.length,178);
 assert.equal((await f.request('/api/v1/portfolio/report?id='+strategy,undefined,{auth:false})).status,200);
 assert.equal((await f.request('/api/v1/portfolio/signals',signal(),{auth:false})).status,401);
 assert.equal((await f.request('/api/v1/portfolio/signals',signal(),{headers:{origin:'https://evil.test'}})).status,403);
 const cn=[...catalog.values()].find(e=>e.market==='CN').id;assert.equal((await f.request('/api/v1/portfolio/start',{strategy_id:cn,budget:1000,confirm:'启动组合自动模拟交易'})).data.code,'SIGNAL_REQUIRED');assert.equal(f.broker.posts().length,0);
});
test('US portfolio trades dynamic assets via existing risk and reconciles actual fills idempotently',async t=>{
 const f=await fixture(t);await start(f);let r=await f.request('/api/v1/portfolio/tick',{market:'US'});assert.equal(r.data.outcome,'submitted',JSON.stringify(r.data));assert.equal(f.broker.posts().length,2);
 assert.equal((await f.request('/api/v1/portfolio/tick',{market:'US'})).data.outcome,'pending_orders');fill(f);
 r=await f.request('/api/v1/portfolio/tick',{market:'US'});assert.equal(r.data.outcome,'already_evaluated',JSON.stringify(r.data));assert.equal(f.broker.posts().length,2);
 assert.equal((await f.request('/api/v1/orders',orderInput())).data.code,'PORTFOLIO_OWNS_ACCOUNT');
 await f.request('/api/v1/portfolio/pause',{market:'US'});assert.equal((await f.request('/api/v1/orders',orderInput())).data.code,'PORTFOLIO_OWNS_ACCOUNT');
 assert.equal((await f.request('/api/v1/portfolio/release',{market:'US'})).data.code,'NEEDS_FLAT');
});
test('portfolio startup requires scheduler, fresh signal and explicit budget authorization, retaining existing shares',async t=>{
 const f=await fixture(t),input={strategy_id:strategy,budget:10000,confirm:'启动组合自动模拟交易'};
 assert.equal((await f.request('/api/v1/portfolio/start',input)).data.code,'SIGNAL_REQUIRED');await f.request('/api/v1/portfolio/signals',signal());
 f.env.SCHEDULER_NATIVE='false';assert.equal((await f.request('/api/v1/portfolio/start',input)).data.code,'NO_SCHEDULER');f.env.SCHEDULER_NATIVE='true';
 f.broker.positions=[{symbol:'SPY',qty:'1'}];assert.equal((await f.request('/api/v1/portfolio/start',input)).status,200);
 assert.equal(f.broker.posts().length,0);
});
test('same-date signals immutable; stale quote waits and external position drift pauses',async t=>{
 const f=await fixture(t),s=signal();await start(f,s);assert.equal((await f.request('/api/v1/portfolio/signals',s)).status,200);
 assert.equal((await f.request('/api/v1/portfolio/signals',{...s,data_digest:'b'.repeat(64)})).data.code,'SIGNAL_CONFLICT');
 f.broker.quote.latestQuote.t='2020-01-01';assert.equal((await f.request('/api/v1/portfolio/tick',{market:'US'})).data.outcome,'waiting_data');assert.equal(f.broker.posts().length,0);
 f.broker.quote.latestQuote.t=new Date().toISOString();f.broker.positions=[{symbol:'SPY',qty:'1'}];assert.equal((await f.request('/api/v1/portfolio/tick',{market:'US'})).data.code,'POSITION_DRIFT');assert.equal(f.db.get('SELECT enabled FROM portfolio_runs').enabled,0);
});
test('timeout/unknown never resends; failure persisting fault retains lease',async t=>{
 const f=await fixture(t);await start(f);f.broker.onPost=()=>{throw Error('timeout');};f.broker.lookupMissing=true;
 const r=await f.request('/api/v1/portfolio/tick',{market:'US'});assert.equal(r.data.code,'ORDER_UNRESOLVED');assert.equal(f.broker.posts().length,1);assert.equal(f.db.get('SELECT enabled FROM portfolio_runs').enabled,0);
 assert.equal((await f.request('/api/v1/portfolio/tick',{market:'US'})).data.outcome,'paused');
});
test('storage failure before intentions cannot place orders, failed pause retains recovery barrier',async t=>{
 const f=await fixture(t);await start(f);f.db.fail=sql=>sql.startsWith('INSERT INTO portfolio_decisions')||sql.startsWith('UPDATE portfolio_runs SET enabled=0');
 assert.equal((await f.request('/api/v1/portfolio/tick',{market:'US'})).status,503);assert.equal(f.broker.posts().length,0);assert.ok(f.db.get('SELECT lease_id FROM portfolio_runs').lease_id);
 f.db.fail=null;assert.equal((await f.request('/api/v1/portfolio/tick',{market:'US'})).data.outcome,'busy');
});
test('operator liquidation waits for actual sells, then releases flat account without duplicate orders',async t=>{
 const f=await fixture(t);await start(f);await f.request('/api/v1/portfolio/tick',{market:'US'});fill(f);await f.request('/api/v1/portfolio/tick',{market:'US'});
 await f.request('/api/v1/portfolio/pause',{market:'US'});let r=await f.request('/api/v1/portfolio/liquidate',{market:'US',confirm:'平仓并停止组合'});assert.equal(r.status,200,JSON.stringify(r.data));
 r=await f.request('/api/v1/portfolio/tick',{market:'US'});assert.equal(r.data.outcome,'submitted',JSON.stringify(r.data));assert.equal(f.broker.posts().filter(o=>o.payload.side==='sell').length,2);
 assert.equal((await f.request('/api/v1/portfolio/tick',{market:'US'})).data.outcome,'pending_orders');fill(f);
 r=await f.request('/api/v1/portfolio/tick',{market:'US'});assert.equal(r.data.outcome,'no_order',JSON.stringify(r.data));assert.equal(f.db.get('SELECT enabled FROM portfolio_runs').enabled,0);
 assert.equal((await f.request('/api/v1/portfolio/release',{market:'US'})).status,200);
 assert.equal(f.db.get('SELECT COUNT(*) n FROM portfolio_runs').n,0);
});
test('native scheduler runs authorized portfolios without a browser',async t=>{
 const f=await fixture(t);await start(f);const {default:worker}=await import('../worker/index.js');const r=await worker.scheduled({},f.env);assert.equal(r.portfolios[0].outcome,'submitted');assert.equal(f.broker.posts().length,2);
});

test('concurrent signal publication freezes exactly one version per strategy/session',async t=>{
 const f=await fixture(t),s=signal();const r=await Promise.all([f.request('/api/v1/portfolio/signals',s),f.request('/api/v1/portfolio/signals',{...s,data_digest:'b'.repeat(64)})]);
 assert.deepEqual(r.map(x=>x.status).sort(),[200,409]);assert.equal(f.db.get('SELECT COUNT(*) n FROM portfolio_signals').n,1);
});
test('overlapping scheduler cycles cannot duplicate portfolio orders',async t=>{
 const f=await fixture(t);await start(f);let ready,release;const entered=new Promise(r=>ready=r),gate=new Promise(r=>release=r);
 f.broker.onPost=async p=>{ready();await gate;return Response.json(f.broker.put(p));};
 const first=f.request('/api/v1/portfolio/tick',{market:'US'});await entered;
 assert.equal((await f.request('/api/v1/portfolio/tick',{market:'US'})).data.outcome,'busy');release();assert.equal((await first).data.outcome,'submitted');assert.equal(f.broker.posts().length,2);
});
test('pause between quote checks and dispatch blocks portfolio side effects',async t=>{
 const f=await fixture(t);await start(f);let once=false;
 f.broker.onGet=async u=>{if(!once&&u.pathname.startsWith('/v2/assets/')){once=true;await f.request('/api/v1/portfolio/pause',{market:'US'});}return null;};
 const r=await f.request('/api/v1/portfolio/tick',{market:'US'});assert.equal(r.data.code,'PORTFOLIO_STOPPED');assert.equal(f.broker.posts().length,0);
});
test('lagged liquidity limits cap quantities instead of looking at current-session volume',()=>{
 const quotes={NVDA:{price:100,lot:1,tradable:true}};
 assert.equal(deltaOrders({targets:[{symbol:'NVDA',weight:.8}],liquidity_caps:{NVDA:250}}, {},quotes,10000,10000,'US')[0].qty,2);
 assert.deepEqual(deltaOrders({targets:[{symbol:'NVDA',weight:.8}],liquidity_caps:{NVDA:0}}, {},quotes,10000,10000,'US'),[]);
});
test('replay report import remains distinct from reference backtest and never enables execution',async t=>{
 const f=await fixture(t);const s=signal(),config=catalog.get(strategy).config;
 const r=await f.request('/api/v1/portfolio/backtests',{signal:s,config,dates:['2026-01-01','2026-01-02'],backtest:{equity:[1,1.01],full:{cagr_pct:5,max_drawdown_pct:-1,total_return_pct:1}},note:'fixture replay'});
 assert.equal(r.status,200);const latest=await f.request('/api/v1/portfolio/report?id='+strategy+'&source=latest');assert.deepEqual(latest.data.report.equity,[1,1.01]);
 assert.notEqual((await f.request('/api/v1/portfolio/report?id='+strategy)).data.report.equity.length,2);assert.equal(f.db.get('SELECT COUNT(*) n FROM portfolio_runs').n,0);assert.equal(f.broker.posts().length,0);
});

test('completed sell phase follows its receipts, then buys without repricing and resending exits',async t=>{
 const f=await fixture(t);await start(f,signal(strategy,[{symbol:'NVDA',weight:.1}],2));await f.request('/api/v1/portfolio/tick',{market:'US'});fill(f);await f.request('/api/v1/portfolio/tick',{market:'US'});
 const next=signal(strategy,[{symbol:'NVDA',weight:.05},{symbol:'GOOGL',weight:.1}],1);assert.equal((await f.request('/api/v1/portfolio/signals',next)).status,200);
 let r=await f.request('/api/v1/portfolio/tick',{market:'US'});assert.equal(r.data.outcome,'submitted',JSON.stringify(r.data));const sells=f.broker.posts().filter(o=>o.payload.side==='sell').length;assert.equal(sells,1);
 fill(f);f.broker.quote.latestQuote.ap=200.02;f.broker.quote.latestQuote.bp=199.98;
 r=await f.request('/api/v1/portfolio/tick',{market:'US'});assert.equal(r.data.outcome,'submitted',JSON.stringify(r.data));assert.equal(f.broker.posts().filter(o=>o.payload.side==='sell').length,sells);assert.equal(f.broker.posts().at(-1).payload.symbol,'GOOGL');
});

test('replay import retains chronological decisions and rejects mismatched or oversized target weights',async t=>{
 const f=await fixture(t),s=signal(),config=catalog.get(strategy).config,dates=['2026-01-01','2026-01-02'];
 const decisions=dates.map(t=>({t,rebalanced:true,reason:'收盘重新计算目标',targets:[{symbol:'SPY',weight:.3}]}));
 const payload={signal:s,config,dates,backtest:{equity:[1,1.01],full:{cagr_pct:5,max_drawdown_pct:-1,total_return_pct:1},decisions}};
 assert.equal((await f.request('/api/v1/portfolio/backtests',payload)).status,200);
 const saved=await f.request('/api/v1/portfolio/report?id='+strategy+'&source=latest');assert.deepEqual(saved.data.report.decisions,decisions.map(d=>({...d,holdings:[]})));
 for(const mutate of [p=>p.backtest.decisions[0].t='2026-01-03',p=>p.backtest.decisions[0].targets[0].weight=2,p=>p.backtest.decisions.pop()]){const bad=structuredClone(payload);mutate(bad);assert.equal((await f.request('/api/v1/portfolio/backtests',bad)).status,400);}
 assert.equal(f.broker.posts().length,0);
});


test('existing same-symbol shares stay outside preview, allocation and liquidation',async t=>{
 const f=await fixture(t);f.broker.positions=[{symbol:'NVDA',qty:'7',market_value:'700'},{symbol:'SPY',qty:'3',market_value:'300'}];fill(f);
 const latest=signal();await f.request('/api/v1/portfolio/signals',latest);
 const preview=await f.request('/api/v1/portfolio/preview?id='+strategy+'&budget=10000');
 assert.equal(preview.status,200);assert.equal(preview.data.rows.find(r=>r.symbol==='NVDA').held,0);assert.ok(!preview.data.rows.some(r=>r.symbol==='SPY'));assert.equal(preview.data.protected_positions.length,2);
 await start(f,latest);assert.equal((await f.request('/api/v1/portfolio/tick',{market:'US'})).data.outcome,'submitted');
 const purchased=Number(f.broker.posts().find(o=>o.payload.symbol==='NVDA').payload.qty);fill(f);
 assert.equal(Number(f.broker.positions.find(p=>p.symbol==='NVDA').qty),7+purchased);
 await f.request('/api/v1/portfolio/pause',{market:'US'});
 await f.request('/api/v1/portfolio/liquidate',{market:'US',confirm:'平仓并停止组合'});
 assert.equal((await f.request('/api/v1/portfolio/tick',{market:'US'})).data.outcome,'submitted');
 const sells=f.broker.posts().filter(o=>o.payload.side==='sell');assert.equal(Number(sells.find(o=>o.payload.symbol==='NVDA').payload.qty),purchased);assert.ok(!sells.some(o=>o.payload.symbol==='SPY'));
 fill(f);assert.equal((await f.request('/api/v1/portfolio/tick',{market:'US'})).data.outcome,'no_order');
 assert.equal((await f.request('/api/v1/portfolio/release',{market:'US'})).status,200);
 assert.equal(Number(f.broker.positions.find(p=>p.symbol==='NVDA').qty),7);assert.equal(Number(f.broker.positions.find(p=>p.symbol==='SPY').qty),3);
});

test('existing pending orders can finish before the baseline is sealed without cancellation or takeover',async t=>{
 const f=await fixture(t),old=f.broker.put({symbol:'NVDA',side:'buy',qty:'4',limit_price:'100',client_order_id:'manual-before-start'});
 await start(f);let r=await f.request('/api/v1/portfolio/tick',{market:'US'});assert.equal(r.data.outcome,'waiting_existing_orders');assert.equal(f.broker.posts().length,0);assert.equal(old.status,'new');
 // A partial fill remains external, even over repeated scheduler checks.
 old.filled_qty='2';old.filled_avg_price='100';old.status='partially_filled';f.broker.positions=[{symbol:'NVDA',qty:'2',market_value:'200'}];f.broker.account.cash='99800';f.broker.account.long_market_value='200';
 assert.equal((await f.request('/api/v1/portfolio/tick',{market:'US'})).data.outcome,'waiting_existing_orders');
 old.filled_qty='4';old.status='filled';f.broker.positions[0].qty='4';f.broker.positions[0].market_value='400';f.broker.account.cash='99600';f.broker.account.long_market_value='400';
 r=await f.request('/api/v1/portfolio/tick',{market:'US'});assert.equal(r.data.outcome,'submitted',JSON.stringify(r.data));
 const record=JSON.parse(f.db.get("SELECT payload FROM artifacts WHERE kind='portfolio_ownership'").payload);assert.equal(record.positions.NVDA,4);assert.equal(record.awaiting_orders,false);
 assert.equal(Number(f.broker.posts().find(o=>o.payload.symbol==='NVDA').payload.qty),10);assert.ok(!f.broker.calls.some(c=>c.method==='DELETE'));
});

test('an untraded waiting strategy can be released without touching manual pending orders',async t=>{
 const f=await fixture(t);const old=f.broker.put({symbol:'NVDA',side:'buy',qty:'4',limit_price:'100',client_order_id:'manual-wait'});await start(f);
 await f.request('/api/v1/portfolio/pause',{market:'US'});assert.equal((await f.request('/api/v1/portfolio/release',{market:'US'})).status,200);assert.equal(old.status,'new');assert.equal(f.broker.posts().length,0);
});

test('startup atomically saves the run and baseline; storage failures cannot leave an unprotected run',async t=>{
 const f=await fixture(t);await f.request('/api/v1/portfolio/signals',signal());f.db.fail=sql=>sql.startsWith('INSERT INTO artifacts');
 assert.equal((await f.request('/api/v1/portfolio/start',{strategy_id:strategy,budget:10000,confirm:'启动组合自动模拟交易'})).status,503);
 assert.equal(f.db.get('SELECT COUNT(*) n FROM portfolio_runs').n,0);assert.equal(f.broker.posts().length,0);
});


test('explicit retirement keeps filled shares as manual holdings for a new strategy, never bypasses pending orders',async t=>{
 const f=await fixture(t),s=signal();await start(f,s);await f.request('/api/v1/portfolio/tick',{market:'US'});await f.request('/api/v1/portfolio/pause',{market:'US'});
 const keep={market:'US',keep_positions:true,confirm:'结束策略并保留持仓'};
 assert.equal((await f.request('/api/v1/portfolio/release',keep)).data.code,'NEEDS_FLAT');fill(f);
 assert.equal((await f.request('/api/v1/portfolio/release',{...keep,confirm:''})).data.code,'KEEP_POSITIONS_CONFIRM');
 const before=structuredClone(f.broker.positions),posts=f.broker.posts().length;
 assert.equal((await f.request('/api/v1/portfolio/release',keep)).status,200);assert.deepEqual(f.broker.positions,before);assert.equal(f.broker.posts().length,posts);
 const audit=f.db.get("SELECT details FROM events WHERE kind='portfolio_released' ORDER BY timestamp DESC LIMIT 1");assert.equal(JSON.parse(audit.details).ownership_transfer,'manual');
 await start(f,s);const state=(await f.request('/api/v1/portfolio')).data;assert.equal(state.runs[0].ownership.positions.NVDA,Number(before.find(p=>p.symbol==='NVDA').qty));
});

for(const action of ['release','resume'])test(`stale ${action} cannot mutate a replacement run with the same revision`,async t=>{
 const f=await fixture(t);await start(f);await f.request('/api/v1/portfolio/pause',{market:'US'});let replaced=false;
 f.broker.onGet=async()=>{if(!replaced){replaced=true;f.db.sqlite.exec("UPDATE portfolio_runs SET run_id='replacement-run' WHERE market='US'");}return null;};
 const r=await f.request('/api/v1/portfolio/'+action,{market:'US',confirm:'启动组合自动模拟交易'});
 assert.equal(r.status,409,JSON.stringify(r.data));assert.equal(r.data.code,'PORTFOLIO_CHANGED');
 const saved=f.db.get("SELECT * FROM portfolio_runs WHERE market='US'");assert.equal(saved.run_id,'replacement-run');assert.equal(saved.enabled,0);
 assert.equal(f.db.get("SELECT COUNT(*) n FROM events WHERE kind=?",action==='release'?'portfolio_released':'portfolio_resumed').n,0);assert.equal(f.broker.posts().length,0);
});

test('release reports conflict when a concurrent operator changes the revision',async t=>{
 const f=await fixture(t);await start(f);await f.request('/api/v1/portfolio/pause',{market:'US'});let changed=false;
 f.broker.onGet=async()=>{if(!changed){changed=true;f.db.sqlite.exec("UPDATE portfolio_runs SET revision=revision+1 WHERE market='US'");}return null;};
 const r=await f.request('/api/v1/portfolio/release',{market:'US'});assert.equal(r.status,409);assert.equal(r.data.code,'PORTFOLIO_CHANGED');assert.equal(f.db.get('SELECT COUNT(*) n FROM portfolio_runs').n,1);assert.equal(f.db.get("SELECT COUNT(*) n FROM events WHERE kind='portfolio_released'").n,0);
});

for(const change of ["run_id='new-run'", "lease_id='scheduler-lease',lease_until=9999999999999"])test(`liquidation refuses a concurrent change: ${change}`,async t=>{
 const f=await fixture(t);await start(f);await f.request('/api/v1/portfolio/pause',{market:'US'});
 const {createPortfolio}=await import('../src/portfolio.mjs');const events=[];
 const p=createPortfolio({catalog,adapters:{US:{available:async()=>{f.db.sqlite.exec("UPDATE portfolio_runs SET "+change+" WHERE market='US'");}}},audit:async(...args)=>events.push(args)});
 await assert.rejects(p.liquidate(f.env,f.db,{id:'tester'},{market:'US',confirm:'平仓并停止组合'}),e=>e.code==='PORTFOLIO_CHANGED');
 const row=f.db.get("SELECT * FROM portfolio_runs WHERE market='US'");assert.equal(row.enabled,0);assert.ok(!row.exit_requested);assert.equal(events.length,0);assert.equal(f.broker.posts().length,0);
});

test('portfolio status exposes latest signal expiry so the page can disable expired starts',async t=>{
 const f=await fixture(t),s=signal();await f.request('/api/v1/portfolio/signals',s);
 let state=(await f.request('/api/v1/portfolio')).data;assert.equal(state.signals.find(x=>x.strategy_id===strategy).expires_at,s.expires_at);
 s.expires_at='2020-01-01T00:00:00Z';f.db.sqlite.prepare('UPDATE portfolio_signals SET payload=? WHERE strategy_id=?').run(JSON.stringify(s),strategy);
 state=(await f.request('/api/v1/portfolio')).data;assert.equal(state.signals.find(x=>x.strategy_id===strategy).expires_at,s.expires_at);
 assert.notEqual((await f.request('/api/v1/portfolio/start',{strategy_id:strategy,budget:10000,confirm:'启动组合自动模拟交易'})).status,200);assert.equal(f.broker.posts().length,0);
});
