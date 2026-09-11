import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import worker from '../worker/index.js';
import {setup,orderInput} from './helpers.mjs';

test('packaged interface, help and scripts are served independently of broker availability',async()=>{
  for(const [path,type]of [['/','text/html'],['/styles.css','text/css'],['/app.js','text/javascript'],['/research-baseline.json','application/json']]){const r=await worker.fetch(new Request('https://quant.test'+path),{});assert.equal(r.status,200);assert.ok(r.headers.get('content-type').startsWith(type));if(path==='/app.js')new vm.Script(await r.text());if(path==='/'){const html=await r.text();assert.match(html,/id="help-dialog"/);assert.match(html,/id="confirm-dialog"/);assert.match(html,/id="login-dialog"/);assert.ok(!html.includes('/signin-with-chatgpt'));}}
  const source=readFileSync(new URL('../worker/index.js',import.meta.url),'utf8');assert.ok(!source.includes('https://api.alpaca.markets'));assert.ok(!source.includes('test-paper-secret'));
});
test('public readers can inspect live data, but writes require an independent login session and origin',async t=>{
  const {request,broker}=setup(t);const overview=await request('/api/v1/overview',undefined,{auth:false});assert.equal(overview.status,200);assert.equal(overview.data.account.equity,'100000');assert.equal(overview.data.control.halted,true);assert.ok(!JSON.stringify(overview.data).includes('test-paper'));
  for(const [opts,status]of [[{auth:false},401],[{auth:false,headers:{'oai-authenticated-user-id':'old-owner','oai-authenticated-user-email':'owner@example.test'}},401],[{headers:{origin:'https://evil.test'}},403],[{headers:{'x-quant-action':''}},403]])assert.equal((await request('/api/v1/orders',orderInput(),opts)).status,status);
  assert.equal((await request('/api/v1/audit',undefined,{auth:false})).status,401);assert.equal(broker.posts().length,0);
  await request('/api/v1/reconcile',{});assert.equal((await request('/api/v1/control',{halted:true},{auth:false,headers:{'oai-authenticated-user-id':'old-owner'}})).status,401);
});
test('durable halt gates real submission; recovery requires reconciliation',async t=>{
  const {request,resume,broker}=setup(t);let r=await request('/api/v1/orders',orderInput());assert.equal(r.data.code,'HALTED');assert.equal(broker.posts().length,0);await resume();r=await request('/api/v1/orders',orderInput());assert.equal(r.data.order.status,'new');assert.equal(broker.posts().length,1);await request('/api/v1/control',{halted:true});r=await request('/api/v1/orders',orderInput());assert.equal(r.data.code,'HALTED');assert.equal(broker.posts().length,1);
});
test('order intent and audit exist before sending, duplicate UUIDs send exactly once',async t=>{
  const {request,resume,broker,db}=setup(t);await resume();broker.onPost=payload=>{assert.equal(db.get('SELECT status FROM orders WHERE client_id=?',payload.client_order_id).status,'submitting');assert.equal(db.get("SELECT COUNT(*) n FROM events WHERE kind='order_intent' AND subject=?",payload.client_order_id).n,1);return new Response(JSON.stringify(broker.put(payload)));};
  const input=orderInput();const first=await request('/api/v1/orders',input),again=await request('/api/v1/orders',input);assert.equal(first.data.order.id,again.data.order.id);assert.equal(again.data.reused,true);assert.equal(broker.posts().length,1);const conflict=await request('/api/v1/orders',{...input,qty:2});assert.equal(conflict.data.code,'IDEMPOTENCY_CONFLICT');assert.equal(broker.posts().length,1);
});
test('parallel duplicate requests cannot acquire the same trading lease',async t=>{
  const {request,resume,broker}=setup(t);await resume();let reached,finish;const gate=new Promise(r=>finish=r),ready=new Promise(r=>reached=r);broker.onPost=async payload=>{reached();await gate;return new Response(JSON.stringify(broker.put(payload)));};const input=orderInput(),inflight=request('/api/v1/orders',input);await ready;const second=await request('/api/v1/orders',input);assert.equal(second.data.code,'OPERATION_BUSY');finish();assert.equal((await inflight).data.ok,true);assert.equal(broker.posts().length,1);
});
test('lost broker response resolves by client ID without resending',async t=>{
  const {request,resume,broker}=setup(t);await resume();broker.onPost=payload=>{broker.put(payload);throw Error('lost response');};const r=await request('/api/v1/orders',orderInput());assert.equal(r.data.ok,true);assert.equal(r.data.order.status,'new');assert.equal(broker.posts().length,1);
});
test('unresolved submit halts, does not retry, and later reconciles when broker record appears',async t=>{
  const {request,resume,broker,db}=setup(t);await resume();broker.onPost=()=>{throw Error('timeout');};const input=orderInput();const first=await request('/api/v1/orders',input);assert.equal(first.data.order.status,'unknown');assert.equal(db.get('SELECT halted FROM control').halted,1);const again=await request('/api/v1/orders',input);assert.equal(again.data.ok,false);assert.equal(broker.posts().length,1);assert.equal((await request('/api/v1/reconcile',{})).data.ok,false);
  broker.put({...input,client_order_id:first.data.order.client_order_id});assert.equal((await request('/api/v1/reconcile',{})).data.ok,true);await resume();assert.equal(db.get('SELECT halted FROM control').halted,0);assert.equal(broker.posts().length,1);
});
test('storage failure before intent prevents broker side effect and rolls back journal',async t=>{
  const {request,resume,broker,db}=setup(t);await resume();db.fail=sql=>sql.startsWith('INSERT INTO events');const r=await request('/api/v1/orders',orderInput());assert.equal(r.status,503);assert.equal(db.get('SELECT COUNT(*) n FROM orders').n,0);assert.equal(broker.posts().length,0);
});
test('storage failure after broker acceptance remains unresolved and blocks a fresh order',async t=>{
  const {request,resume,broker,db}=setup(t);await resume();db.fail=sql=>sql.startsWith('UPDATE orders SET broker_id');const input=orderInput(),r=await request('/api/v1/orders',input);assert.equal(r.status,503);assert.equal(broker.posts().length,1);db.fail=null;assert.equal((await request('/api/v1/orders',orderInput())).data.code,'UNRESOLVED_ORDER');assert.equal((await request('/api/v1/orders',input)).data.reused,true);assert.equal(broker.posts().length,1);
});
test('closed market requires explicit queue consent and never accepts market order',async t=>{
  const {request,resume,broker}=setup(t);await resume();broker.clock.is_open=false;assert.equal((await request('/api/v1/orders',orderInput())).data.code,'MARKET_CLOSED');assert.equal((await request('/api/v1/orders',orderInput({allow_queued:true,type:'market'}))).data.code,'STALE_QUOTE');assert.equal((await request('/api/v1/orders',orderInput({allow_queued:true}))).data.ok,true);assert.equal(broker.posts().length,1);
});
test('cancel requires an exact platform order; cancellation has a pending state until reconciled',async t=>{
  const {request,resume,broker,db}=setup(t);await resume();const ext=broker.put({client_order_id:'external',symbol:'SPY',side:'buy',qty:'1',limit_price:'50',type:'limit'});const result=await request('/api/v1/orders',orderInput());const id=result.data.order.client_order_id;
  assert.equal((await request('/api/v1/orders/cancel',{})).status,400);assert.equal((await request('/api/v1/orders/cancel',{client_id:'external'})).status,400);assert.equal((await request('/api/v1/orders/cancel',{client_id:id})).data.results[0].status,'pending_cancel');assert.equal(db.get('SELECT status FROM orders WHERE client_id=?',id).status,'pending_cancel');await request('/api/v1/reconcile',{});assert.equal(db.get('SELECT status FROM orders WHERE client_id=?',id).status,'canceled');assert.equal(ext.status,'new');
});
test('kill control saves halt and only cancels locally recorded orders',async t=>{
  const {request,resume,broker,db}=setup(t);await resume();const external=broker.put({client_order_id:'external',symbol:'MSFT',side:'sell',qty:'1',limit_price:'500'});await request('/api/v1/orders',orderInput());const r=await request('/api/v1/control',{halted:true,cancel:true});assert.equal(r.data.control.halted,true);assert.equal(r.data.canceled.results.length,1);assert.equal(external.status,'new');assert.equal(db.get('SELECT halted FROM control').halted,1);
});
test('halt racing broker acceptance requests cancellation and prevents later submissions',async t=>{
  const {request,resume,broker}=setup(t);await resume();broker.onPost=async payload=>{await request('/api/v1/control',{halted:true});return new Response(JSON.stringify(broker.put(payload)));};const r=await request('/api/v1/orders',orderInput());assert.equal(broker.orders.get(r.data.order.client_order_id).status,'canceled');assert.equal((await request('/api/v1/orders',orderInput())).data.code,'HALTED');
});
test('account mismatch or daily loss prevents resuming and is recorded',async t=>{
  const {request,broker,db}=setup(t);broker.account.cash='90000';const r=await request('/api/v1/control',{halted:false,confirm:'恢复模拟盘'});assert.equal(r.data.code,'RECONCILIATION_FAILED');assert.equal(db.get('SELECT halted FROM control').halted,1);broker.account.equity='90000';assert.equal((await request('/api/v1/control',{halted:false,confirm:'恢复模拟盘'})).data.code,'DAILY_LOSS');
});
test('real-history backtest persists an immutable snapshot and replays without downloading bars',async t=>{
  const {request,broker,db}=setup(t),config={symbol:'SPY',type:'sma',allocation:.01,fast:5,slow:20};const one=await request('/api/v1/backtests',{config});assert.equal(one.data.ok,true);const count=broker.calls.filter(c=>c.url.pathname==='/v2/stocks/bars').length;const two=await request('/api/v1/backtests',{config,snapshot_id:one.data.snapshot_id});assert.deepEqual(two.data.metrics,one.data.metrics);assert.deepEqual(two.data.curve,one.data.curve);assert.equal(broker.calls.filter(c=>c.url.pathname==='/v2/stocks/bars').length,count);assert.equal(db.get("SELECT COUNT(*) n FROM artifacts WHERE kind='dataset'").n,1);assert.equal(db.get("SELECT COUNT(*) n FROM artifacts WHERE kind='backtest'").n,2);assert.equal((await request('/api/v1/artifacts?kind=backtest')).data.items.length,2);
});
test('plan rechecks holdings and expiry; successful plan retries remain idempotent after expiry',async t=>{
  const {request,resume,broker,db}=setup(t);await resume();const report=await request('/api/v1/backtests',{config:{symbol:'SPY',type:'buy_hold',allocation:.01}});const p=(await request('/api/v1/plans',{backtest_id:report.data.id})).data;assert.equal(p.order.qty,10);broker.positions=[{symbol:'SPY',qty:'1',market_value:'100'}];assert.equal((await request('/api/v1/plans/submit',{plan_id:p.id,confirm:true})).data.code,'PLAN_STALE');broker.positions=[];const done=await request('/api/v1/plans/submit',{plan_id:p.id,confirm:true});assert.equal(done.data.ok,true);const row=JSON.parse(db.get('SELECT payload FROM artifacts WHERE id=?',p.id).payload);row.expires_at='2020-01-01';db.sqlite.prepare('UPDATE artifacts SET payload=? WHERE id=?').run(JSON.stringify(row),p.id);assert.equal((await request('/api/v1/plans/submit',{plan_id:p.id,confirm:true})).data.reused,true);assert.equal(broker.posts().length,1);
  const other=(await request('/api/v1/plans',{backtest_id:report.data.id})).data;const payload=JSON.parse(db.get('SELECT payload FROM artifacts WHERE id=?',other.id).payload);payload.expires_at='2020-01-01';db.sqlite.prepare('UPDATE artifacts SET payload=? WHERE id=?').run(JSON.stringify(payload),other.id);assert.equal((await request('/api/v1/plans/submit',{plan_id:other.id,confirm:true})).data.code,'PLAN_EXPIRED');
});
test('audit digest detects content changes and broker errors do not expose credentials',async t=>{
  const {request,resume,broker,db}=setup(t);await resume();assert.equal((await request('/api/v1/audit')).data.integrity,true);db.sqlite.prepare("UPDATE events SET details='{}' WHERE id=1").run();assert.equal((await request('/api/v1/audit')).data.integrity,false);
  broker.onGet=u=>u.pathname==='/v2/account'?new Response(JSON.stringify({message:'test-paper-secret test-paper-key'}),{status:401}):null;const overview=await request('/api/v1/overview');assert.equal(overview.data.ok,false);assert.equal(overview.data.account,null);assert.ok(!JSON.stringify(overview.data).includes('test-paper'));
});
test('missing persistent database and invalid CSRF never reach broker',async t=>{
  const {request,broker,env}=setup(t);const r=await request('/api/v1/orders',orderInput(),{env:{...env,DB:null}});assert.equal(r.data.code,'STORAGE_UNAVAILABLE');assert.equal(broker.calls.length,0);
});
