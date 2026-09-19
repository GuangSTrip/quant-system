import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,createHmac} from 'node:crypto';
import {setup} from './helpers.mjs';
import {seal,signedHeaders} from '../src/longbridge.mjs';
import {normalizeHK,hkWindow} from '../src/longbridge-trading.mjs';
const creds={app_key:'fixture-key',app_secret:'fixture-secret',access_token:'fixture-token'};
async function fixture(t){
 const base=setup(t);base.env.BROKER_CREDENTIAL_KEY=Buffer.alloc(32,9).toString('base64');base.env.SCHEDULER_REPOSITORY_ID='fixture';
 base.db.sqlite.prepare('INSERT INTO longbridge_connection(id,ciphertext,updated_at,actor) VALUES(1,?,?,?)').run(await seal(base.env,creds),'2026-09-18','test');
 const broker={posts:[],orders:new Map(),quantity:0,cash:100000,onPost:null,cancelled:false};
 globalThis.fetch=async(url,options={})=>{
 const u=new URL(url),method=options.method||'GET';if(u.hostname!=='openapi.longbridge.com')return base.broker.fetch(url,options);assert.equal(options.headers['X-Papertrading'],'true');
 const ok=data=>Response.json({code:0,data});
 if(method==='POST'){const p=JSON.parse(options.body);broker.posts.push(p);const id=String(100+broker.posts.length),o={order_id:id,symbol:p.symbol,side:p.side,quantity:p.submitted_quantity,price:p.submitted_price,status:'NewStatus',executed_quantity:'0',executed_price:'0',remark:p.remark};broker.orders.set(id,o);if(broker.onPost)return broker.onPost(o);return ok({order_id:id});}
 if(method==='DELETE'){const o=broker.orders.get(u.searchParams.get('order_id'));o.status=Number(o.executed_quantity)>0?'PartialWithdrawal':'CanceledStatus';broker.cancelled=true;return ok({});}
 if(u.pathname==='/v1/asset/account')return ok({list:[{currency:'HKD',net_assets:String(broker.cash),cash_infos:[{currency:'HKD',available_cash:String(broker.cash)}]}]});
 if(u.pathname==='/v1/asset/stock')return ok({list:[{stock_info:broker.quantity?[{market:'HK',symbol:'2800.HK',quantity:String(broker.quantity),available_quantity:String(broker.quantity)}]:[]}]});
 if(u.pathname==='/v1/trade/order/today')return ok({orders:[...broker.orders.values()]});
 if(u.pathname==='/v1/trade/order')return ok(broker.orders.get(u.searchParams.get('order_id')));
 if(u.pathname==='/v1/trade/execution/today'){const o=broker.orders.get(u.searchParams.get('order_id'));return ok({trades:Number(o.executed_quantity)?[{trade_id:'trade-'+o.order_id,order_id:o.order_id,symbol:o.symbol,quantity:o.executed_quantity,price:o.executed_price}]:[]});}
 throw Error('Unexpected endpoint '+u.pathname);
 };
 const enable=()=>base.request('/api/v1/longbridge/control',{enabled:true,confirm:'确认长桥模拟账户',max_order:2000,max_daily:5000});
 const order=(extra={})=>({symbol:'2800.HK',side:'Buy',quantity:100,lot_size:100,price:10,client_id:crypto.randomUUID(),confirm:true,allow_queued:true,...extra});
 return {...base,lb:broker,enable,order};
}
test('POST signing includes exact body hash and DELETE signs its query with no body',async()=>{
 for(const [method,query,body]of [['POST','',JSON.stringify({symbol:'2800.HK'})],['DELETE','order_id=123',undefined]]){
 const raw=method+'|/v1/trade/order|'+query+'|authorization:fixture-token\nx-api-key:fixture-key\nx-timestamp:1\n|authorization;x-api-key;x-timestamp|'+(body?createHash('sha1').update(body).digest('hex'):'');
 const expected=createHmac('sha256','fixture-secret').update('HMAC-SHA256|'+createHash('sha1').update(raw).digest('hex')).digest('hex');const h=await signedHeaders(creds,'/v1/trade/order',query,'1',method,body);assert.ok(h['X-Api-Signature'].endsWith(expected));}
});
test('HK normalization rejects other markets and invalid lots; time gate excludes lunch and weekends',()=>{
 assert.equal(normalizeHK({symbol:'HK.00700',quantity:100,lot_size:100,price:10,side:'Buy'}).symbol,'700.HK');
 for(const extra of [{symbol:'AAPL.US'},{quantity:101},{price:0},{side:'short'}])assert.throws(()=>normalizeHK({symbol:'2800.HK',quantity:100,lot_size:100,price:10,side:'Buy',...extra}));
 assert.equal(hkWindow(Date.parse('2026-09-18T10:00:00+08:00')),true);assert.equal(hkWindow(Date.parse('2026-09-18T12:30:00+08:00')),false);assert.equal(hkWindow(Date.parse('2026-09-19T10:00:00+08:00')),false);
});
test('disabled, unauthenticated, CSRF, cash and notional limits prevent dispatch',async t=>{
 const f=await fixture(t),p=f.order();assert.equal((await f.request('/api/v1/longbridge/orders/submit',p)).status,409);await f.enable();
 assert.equal((await f.request('/api/v1/longbridge/orders/submit',p,{auth:false})).status,401);
 assert.equal((await f.request('/api/v1/longbridge/orders/submit',p,{headers:{origin:'https://evil.test'}})).status,403);
 assert.equal((await f.request('/api/v1/longbridge/orders/submit',f.order({quantity:1000}))).data.code,'LB_ORDER_LIMIT');
 assert.equal((await f.request('/api/v1/longbridge/orders/submit',f.order({side:'Sell'}))).data.code,'LB_POSITION');
 f.lb.cash=999;assert.equal((await f.request('/api/v1/longbridge/orders/submit',p)).data.code,'LB_CASH');assert.equal(f.lb.posts.length,0);
});
test('duplicate submit produces one broker order; different payload with same id is rejected',async t=>{
 const f=await fixture(t);await f.enable();const p=f.order();let r=await f.request('/api/v1/longbridge/orders/submit',p);assert.equal(r.data.ok,true);assert.equal(r.data.order.broker_id,'101');
 r=await f.request('/api/v1/longbridge/orders/submit',p);assert.equal(r.data.reused,true);assert.equal(f.lb.posts.length,1);
 r=await f.request('/api/v1/longbridge/orders/submit',{...p,price:9});assert.equal(r.data.code,'LB_ID_CONFLICT');
 assert.equal((await f.request('/api/v1/longbridge/disconnect',{confirm:true})).status,409);
});
test('timeout after broker accept stays unknown, blocks new orders, then recovers by remark without resubmitting',async t=>{
 const f=await fixture(t);await f.enable();f.lb.onPost=()=>{throw Error('timeout');};const p=f.order();let r=await f.request('/api/v1/longbridge/orders/submit',p);assert.equal(r.data.order.status,'unknown');
 r=await f.request('/api/v1/longbridge/orders/submit',f.order());assert.equal(r.data.code,'LB_UNRESOLVED');
 r=await f.request('/api/v1/longbridge/orders/inspect',{client_id:p.client_id});assert.equal(r.data.receipt.order_id,'101');assert.equal(r.data.checks.filled,false);assert.equal(f.lb.posts.length,1);
});
test('fill evidence matches executions and position; drift is detected; cancel request awaits final broker state',async t=>{
 const f=await fixture(t);await f.enable();const p=f.order();await f.request('/api/v1/longbridge/orders/submit',p);
 let r=await f.request('/api/v1/longbridge/orders/cancel',{client_id:p.client_id,confirm:true});assert.equal(r.data.ok,true);assert.equal(f.db.get('SELECT status FROM lb_orders').status,'cancel_pending');
 r=await f.request('/api/v1/longbridge/orders/inspect',{client_id:p.client_id});assert.equal(r.data.checks.cancelled,true);assert.equal(r.data.checks.filled,false);
 const p2=f.order();await f.request('/api/v1/longbridge/orders/submit',p2);Object.assign(f.lb.orders.get('102'),{status:'FilledStatus',executed_quantity:'100',executed_price:'9.9'});f.lb.quantity=100;
 r=await f.request('/api/v1/longbridge/orders/inspect',{client_id:p2.client_id});assert.equal(r.data.checks.filled,true);assert.equal(r.data.checks.execution_details,true);assert.equal(r.data.checks.position_matches,true);
 f.lb.quantity=200;r=await f.request('/api/v1/longbridge/orders/inspect',{client_id:p2.client_id});assert.equal(r.data.checks.position_matches,false);
});
test('concurrent submits are serialized before the network side effect',async t=>{
 const f=await fixture(t);await f.enable();let unblock,entered;const gate=new Promise(r=>unblock=r),ready=new Promise(r=>entered=r);f.lb.onPost=async o=>{entered();await gate;return Response.json({code:0,data:{order_id:o.order_id}});};
 const first=f.request('/api/v1/longbridge/orders/submit',f.order());await ready;
 const second=await f.request('/api/v1/longbridge/orders/submit',f.order());assert.equal(second.data.code,'LB_BUSY');unblock();await first;assert.equal(f.lb.posts.length,1);
});
test('automation submits once, waits for fills and interval, stops at total budget and respects pause',async t=>{
 const f=await fixture(t);await f.enable();let time=Date.parse(new Date().toISOString().slice(0,10)+'T10:00:00+08:00');while(!hkWindow(time))time+=86400000;const old=Date.now;Date.now=()=>time;t.after(()=>Date.now=old);f.db.sqlite.prepare('UPDATE auth_sessions SET expires_at=?').run(Date.now()+8*3600000);
 const start=await f.request('/api/v1/longbridge/auto/start',{...f.order(),budget:1000,interval_minutes:5,confirm:'启动长桥自动模拟交易'});assert.equal(start.status,200);
 let r=await f.request('/api/v1/longbridge/auto/tick',{});assert.equal(r.data.outcome,'submitted');r=await f.request('/api/v1/longbridge/auto/tick',{});assert.equal(r.data.outcome,'pending');assert.equal(f.lb.posts.length,1);
 Object.assign(f.lb.orders.get('101'),{status:'FilledStatus',executed_quantity:'100',executed_price:'10'});f.lb.quantity=100;time+=6*60000;
 r=await f.request('/api/v1/longbridge/auto/tick',{});assert.equal(r.data.outcome,'completed');assert.equal(f.db.get('SELECT enabled FROM lb_auto').enabled,0);assert.equal(f.lb.posts.length,1);
 await f.request('/api/v1/longbridge/auto/pause',{});assert.equal((await f.request('/api/v1/longbridge/auto/tick',{})).data.outcome,'paused');
});
test('automation faults safely on uncertain submit and credential replacement invalidates authorization',async t=>{
 const f=await fixture(t);await f.enable();let time=Date.parse('2026-09-18T10:00:00+08:00');const old=Date.now;Date.now=()=>time;t.after(()=>Date.now=old);f.db.sqlite.prepare('UPDATE auth_sessions SET expires_at=?').run(Date.now()+8*3600000);
 await f.request('/api/v1/longbridge/auto/start',{...f.order(),budget:2000,interval_minutes:5,confirm:'启动长桥自动模拟交易'});f.lb.onPost=()=>{throw Error('timeout');};let r=await f.request('/api/v1/longbridge/auto/tick',{});assert.equal(r.data.outcome,'fault');assert.equal(f.db.get('SELECT enabled FROM lb_auto').enabled,0);
 const changed=await seal(f.env,{...creds,access_token:'new-fixture-token'});f.db.sqlite.prepare('UPDATE longbridge_connection SET ciphertext=?').run(changed);
 r=await f.request('/api/v1/longbridge/trading');assert.equal(r.data.control.enabled,false);assert.equal(r.data.orders.length,0);
});

test('pause during risk checks blocks dispatch and storage failure before intent never submits',async t=>{
 const f=await fixture(t);await f.enable();const prior=globalThis.fetch;let intercepted=false;
 globalThis.fetch=async(url,opts)=>{if(String(url).includes('/v1/asset/account')&&!intercepted){intercepted=true;await f.request('/api/v1/longbridge/control',{enabled:false});}return prior(url,opts);};
 const r=await f.request('/api/v1/longbridge/orders/submit',f.order());assert.equal(r.status,409);assert.equal(f.lb.posts.length,0);
});
test('failed order-intent storage does not dispatch; failed response storage preserves an unresolved barrier',async t=>{
 const f=await fixture(t);await f.enable();f.db.fail=s=>s.startsWith('INSERT INTO lb_orders');let r=await f.request('/api/v1/longbridge/orders/submit',f.order());assert.equal(r.status,503);assert.equal(f.lb.posts.length,0);
 f.db.fail=s=>s.startsWith('UPDATE lb_orders SET broker_id');r=await f.request('/api/v1/longbridge/orders/submit',f.order());assert.equal(r.data.order.status,'unknown');assert.equal(f.lb.posts.length,1);f.db.fail=null;
 assert.equal((await f.request('/api/v1/longbridge/orders/submit',f.order())).data.code,'LB_UNRESOLVED');
});
test('cancelled orders retain daily budget and account-change guards until terminal reconciliation',async t=>{
 const f=await fixture(t);await f.request('/api/v1/longbridge/control',{enabled:true,confirm:'确认长桥模拟账户',max_order:1000,max_daily:1000});const p=f.order();await f.request('/api/v1/longbridge/orders/submit',p);await f.request('/api/v1/longbridge/orders/cancel',{client_id:p.client_id,confirm:true});await f.request('/api/v1/longbridge/orders/inspect',{client_id:p.client_id});assert.equal((await f.request('/api/v1/longbridge/orders/submit',f.order())).data.code,'LB_DAILY_LIMIT');
});
test('native background scheduler advances Longbridge without a browser and updates heartbeat',async t=>{
 const f=await fixture(t);f.env.SCHEDULER_NATIVE='true';await f.enable();const old=Date.now;Date.now=()=>Date.parse('2026-09-18T10:00:00+08:00');t.after(()=>Date.now=old);f.db.sqlite.prepare('UPDATE auth_sessions SET expires_at=?').run(Date.now()+8*3600000);
 await f.request('/api/v1/longbridge/auto/start',{...f.order(),budget:2000,interval_minutes:5,confirm:'启动长桥自动模拟交易'});
 const {default:worker}=await import('../worker/index.js');const r=await worker.scheduled({},f.env);assert.equal(r.longbridge.outcome,'submitted');assert.ok(f.db.get('SELECT heartbeat_at FROM lb_auto').heartbeat_at);assert.equal(f.lb.posts.length,1);
});
test('unknown longbridge receipt cannot be accepted for another symbol or oversize fill',async t=>{
 const f=await fixture(t);await f.enable();const p=f.order();await f.request('/api/v1/longbridge/orders/submit',p);f.lb.orders.get('101').symbol='700.HK';assert.equal((await f.request('/api/v1/longbridge/orders/inspect',{client_id:p.client_id})).data.code,'LB_RECEIPT_MISMATCH');assert.equal(f.db.get('SELECT broker_data FROM lb_orders').broker_data,null);
});

test('resume preserves the original run and spent budget with existing filled positions',async t=>{
 const f=await fixture(t);await f.enable();const old=Date.now;let time=Date.parse('2026-09-18T10:00:00+08:00');Date.now=()=>time;t.after(()=>Date.now=old);f.db.sqlite.prepare('UPDATE auth_sessions SET expires_at=?').run(Date.now()+8*3600000);
 await f.request('/api/v1/longbridge/auto/start',{...f.order(),budget:2000,interval_minutes:5,confirm:'启动长桥自动模拟交易'});const runId=f.db.get('SELECT run_id FROM lb_auto').run_id;
 await f.request('/api/v1/longbridge/auto/tick',{});Object.assign(f.lb.orders.get('101'),{status:'FilledStatus',executed_quantity:'100',executed_price:'10'});f.lb.quantity=100;
 await f.request('/api/v1/longbridge/auto/pause',{});const r=await f.request('/api/v1/longbridge/auto/resume',{confirm:'启动长桥自动模拟交易'});assert.equal(r.status,200);assert.equal(r.data.automation.run_id,runId);assert.equal(r.data.automation.sequence,1);assert.equal(f.lb.posts.length,1);
 time+=6*60000;assert.equal((await f.request('/api/v1/longbridge/auto/tick',{})).data.outcome,'submitted');assert.equal(f.lb.posts.length,2);
});

async function portfolioFixture(t){
 const f=await fixture(t);await f.enable();const real=Date.now;Date.now=()=>Date.parse('2026-09-18T02:00:00Z');t.after(()=>Date.now=real);f.db.sqlite.prepare('UPDATE auth_sessions SET expires_at=?').run(Date.now()+8*3600000);
 const strategy_id='HK:near_high:monthly:inverse_vol:risk06';
 const signal={schema_version:1,strategy_version:'modular-close-1',strategy_id,market:'HK',currency:'HKD',available:true,signal_date:'2026-09-17',rebalance_date:'2026-09-17',data_asof:'2026-09-17T08:00:00Z',execute_after:'2026-09-18T01:30:00Z',expires_at:'2026-09-18T08:00:00Z',liquidity_caps:{'2800.HK':1e9},origin:'2024-01-02',data_digest:'a'.repeat(64),targets:[{symbol:'2800.HK',weight:.1}],cash_weight:.9};
 assert.equal((await f.request('/api/v1/portfolio/signals',signal)).status,200);
 assert.equal((await f.request('/api/v1/portfolio/start',{strategy_id,budget:10000,confirm:'启动组合自动模拟交易'})).status,200);
 const quote=()=>f.request('/api/v1/portfolio/quotes',{market:'HK',asof:new Date(Date.now()).toISOString(),is_open:true,instruments:[{symbol:'2800.HK',price:10,lot:100,tradable:true,asof:new Date(Date.now()).toISOString()}]});
 return {...f,quote};
}
test('HK registered portfolio uses dynamic lots, Longbridge receipts and retains management when paused',async t=>{
 const f=await portfolioFixture(t);assert.equal((await f.request('/api/v1/portfolio/tick',{market:'HK'})).data.outcome,'waiting_data');assert.equal(f.lb.posts.length,0);
 await f.quote();let r=await f.request('/api/v1/portfolio/tick',{market:'HK'});assert.equal(r.data.outcome,'submitted',JSON.stringify(r.data));assert.equal(f.lb.posts[0].submitted_quantity,'100');
 assert.equal((await f.request('/api/v1/portfolio/tick',{market:'HK'})).data.outcome,'pending_orders');
 Object.assign(f.lb.orders.get('101'),{status:'FilledStatus',executed_quantity:'100',executed_price:'10'});f.lb.quantity=100;f.lb.cash-=1000;
 assert.equal((await f.request('/api/v1/portfolio/tick',{market:'HK'})).data.outcome,'already_evaluated');assert.equal(f.lb.posts.length,1);
 await f.request('/api/v1/portfolio/pause',{market:'HK'});assert.equal((await f.request('/api/v1/longbridge/orders/submit',f.order())).data.code,'PORTFOLIO_OWNS_ACCOUNT');
 assert.equal((await f.request('/api/v1/longbridge/disconnect',{confirm:true})).data.code,'PORTFOLIO_OWNS_ACCOUNT');
 assert.equal((await f.request('/api/v1/portfolio/release',{market:'HK'})).data.code,'NEEDS_FLAT');
});
test('HK portfolio rejects stale/security-invalid quotes and unknown orders pause without retry',async t=>{
 const f=await portfolioFixture(t);const invalid=await f.request('/api/v1/portfolio/quotes',{market:'HK',asof:'2020-01-01',is_open:true,instruments:[]});assert.equal(invalid.data.code,'STALE_QUOTE');
 await f.quote();f.lb.onPost=()=>{throw Error('uncertain transport');};const r=await f.request('/api/v1/portfolio/tick',{market:'HK'});assert.equal(r.data.code,'ORDER_UNRESOLVED');assert.equal(f.lb.posts.length,1);
 assert.equal((await f.request('/api/v1/portfolio/tick',{market:'HK'})).data.outcome,'paused');assert.equal(f.lb.posts.length,1);
});
test('HK portfolio explicit liquidation sells only owned shares and finishes after broker fill',async t=>{
 const f=await portfolioFixture(t);await f.quote();await f.request('/api/v1/portfolio/tick',{market:'HK'});
 Object.assign(f.lb.orders.get('101'),{status:'FilledStatus',executed_quantity:'100',executed_price:'10'});f.lb.quantity=100;
 await f.request('/api/v1/portfolio/tick',{market:'HK'});await f.request('/api/v1/portfolio/pause',{market:'HK'});
 assert.equal((await f.request('/api/v1/portfolio/liquidate',{market:'HK',confirm:'平仓并停止组合'})).status,200);
 let r=await f.request('/api/v1/portfolio/tick',{market:'HK'});assert.equal(r.data.outcome,'submitted',JSON.stringify(r.data));assert.equal(f.lb.posts[1].side,'Sell');assert.equal(f.lb.posts[1].submitted_quantity,'100');
 Object.assign(f.lb.orders.get('102'),{status:'FilledStatus',executed_quantity:'100',executed_price:'10'});f.lb.quantity=0;
 r=await f.request('/api/v1/portfolio/tick',{market:'HK'});assert.equal(r.data.outcome,'no_order',JSON.stringify(r.data));assert.equal(f.db.get('SELECT enabled FROM portfolio_runs').enabled,0);
 assert.equal((await f.request('/api/v1/portfolio/release',{market:'HK'})).status,200);
});
