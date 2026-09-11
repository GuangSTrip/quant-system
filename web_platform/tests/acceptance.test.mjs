import test from 'node:test';
import assert from 'node:assert/strict';
import {setup} from './helpers.mjs';

async function prepare(f){
  const r=await f.request('/api/v1/acceptance/prepare',{symbol:'SPY'});
  assert.equal(r.status,200,JSON.stringify(r.data));
  return r.data.run;
}
const clientId=key=>'qs_'+key.replaceAll('-','');
const submit=(f,run,extra={})=>f.request('/api/v1/acceptance/submit',{id:run.id,confirm:true,...extra});
const inspect=(f,run)=>f.request('/api/v1/acceptance/inspect',{id:run.id});
const cancelCheck=(f,run,extra={})=>f.request('/api/v1/acceptance/cancel-check',{id:run.id,confirm:true,...extra});
function fill(f,run){
  Object.assign(f.broker.orders.get(clientId(run.id)),{status:'filled',filled_qty:'1',filled_avg_price:'100',filled_at:new Date().toISOString()});
  f.broker.positions=[{symbol:'SPY',qty:'1',market_value:'100'}];
  Object.assign(f.broker.account,{cash:'99900',long_market_value:'100'});
}

test('acceptance preparation saves actual-read checks and reproducible data without submitting orders',async t=>{
  const f=setup(t);
  assert.equal((await f.request('/api/v1/acceptance/prepare',{symbol:'SPY'},{auth:false})).status,401);
  const run=await prepare(f);
  assert.equal(run.checks.length,4);
  assert.ok(run.checks.every(c=>c.status==='passed'));
  assert.equal(run.risk_error.code,'HALTED');
  assert.equal(f.broker.posts().length,0);
  const loaded=await f.request('/api/v1/acceptance/report?id='+run.id);
  assert.deepEqual(loaded.data.run,run);
  assert.equal(loaded.data.latest,null);
  assert.equal((await inspect(f,run)).data.latest.complete,false);
  assert.equal(f.broker.posts().length,0);
});

test('closed-market acceptance requires queue consent and never treats an accepted order as a fill',async t=>{
  const f=setup(t);await f.resume();f.broker.clock.is_open=false;
  const run=await prepare(f);
  assert.equal((await submit(f,run)).data.code,'MARKET_CLOSED');
  const accepted=await submit(f,run,{allow_queued:true});
  assert.equal(accepted.status,200);
  assert.equal(accepted.data.order.status,'new');
  const repeated=await submit(f,run,{allow_queued:true});
  assert.equal(repeated.data.reused,true);
  assert.equal(f.broker.posts().length,1);
  const report=(await inspect(f,run)).data.latest;
  assert.equal(report.complete,false);
  assert.equal(report.checks.find(c=>c.name==='1 股实际模拟成交').status,'pending');
  assert.equal(report.checks.find(c=>c.name==='成交后账户与订单对账').status,'pending');
  f.broker.orders.get(clientId(run.id)).status='rejected';
  assert.equal((await submit(f,run,{allow_queued:true})).data.ok,false);
  assert.equal(f.broker.posts().length,1);
});

test('acceptance requires filled receipt, separate confirmed cancellation, holdings and reconciliation; report persists',async t=>{
  const logs=[],originalInfo=console.info;console.info=value=>logs.push(JSON.parse(value));t.after(()=>{console.info=originalInfo;});
  const f=setup(t);await f.resume();const run=await prepare(f);
  assert.equal((await submit(f,run)).data.ok,true);fill(f,run);
  assert.equal((await inspect(f,run)).data.latest.complete,false);
  assert.equal((await cancelCheck(f,run)).status,200);
  assert.equal((await cancelCheck(f,run)).status,200);
  assert.equal(f.broker.posts().length,2);
  const result=await inspect(f,run);
  assert.equal(result.status,200);
  assert.equal(result.data.latest.complete,true);
  assert.equal(result.data.latest.checks.length,9);
  assert.equal(result.data.latest.receipts.cancel.status,'canceled');
  assert.equal(result.data.latest.positions.delta,1);
  const saved=await f.request('/api/v1/acceptance/report?id='+run.id,undefined,{auth:false});
  assert.deepEqual(saved.data.latest,result.data.latest);
  assert.equal(f.db.get("SELECT COUNT(*) n FROM artifacts WHERE kind='acceptance_result' AND name=?",run.id).n,2);
  assert.ok(logs.some(e=>e.event==='paper_order_receipt'&&e.status==='filled'&&e.filled_avg_price==='100'&&e.filled_at));
  assert.ok(logs.some(e=>e.event==='paper_acceptance_result'&&e.run_id===run.id&&e.complete===true&&e.position_delta===1&&e.checks.length===9));
});

test('acceptance refuses incomplete fill evidence, holdings mismatch and cash-equity mismatch',async t=>{
  const f=setup(t);await f.resume();const run=await prepare(f);
  await submit(f,run);fill(f,run);await cancelCheck(f,run);
  const receipt=f.broker.orders.get(clientId(run.id)),time=receipt.filled_at;
  receipt.filled_at=null;
  assert.equal((await inspect(f,run)).data.latest.complete,false);
  receipt.filled_at=time;receipt.filled_avg_price=null;
  assert.equal((await inspect(f,run)).data.latest.complete,false);
  receipt.filled_avg_price='100';f.broker.positions[0].qty='2';
  assert.equal((await inspect(f,run)).data.latest.complete,false);
  f.broker.positions[0].qty='1';f.broker.account.cash='99800';
  const mismatch=(await inspect(f,run)).data.latest;
  assert.equal(mismatch.complete,false);
  assert.equal(mismatch.reconciliation.ok,false);
  assert.equal(f.db.get('SELECT halted FROM control').halted,1);
});

test('acceptance blocks expired or changed-holdings plans before broker submission',async t=>{
  const f=setup(t);await f.resume();const run=await prepare(f);
  f.db.sqlite.prepare('UPDATE artifacts SET payload=? WHERE id=?').run(JSON.stringify({...run,expires_at:'2000-01-01T00:00:00Z'}),run.id);
  assert.equal((await submit(f,run)).data.code,'PLAN_EXPIRED');
  f.db.sqlite.prepare('UPDATE artifacts SET payload=? WHERE id=?').run(JSON.stringify(run),run.id);
  f.broker.positions=[{symbol:'SPY',qty:'1',market_value:'100'}];
  assert.equal((await submit(f,run)).data.code,'PLAN_STALE');
  assert.equal(f.broker.posts().length,0);
});

test('acceptance cannot return a successful report if saving the evidence fails',async t=>{
  const logs=[],originalInfo=console.info;console.info=value=>logs.push(JSON.parse(value));t.after(()=>{console.info=originalInfo;});
  const f=setup(t);await f.resume();const run=await prepare(f);
  await submit(f,run);fill(f,run);await cancelCheck(f,run);
  f.db.fail=sql=>sql.startsWith('INSERT INTO artifacts');
  const result=await inspect(f,run);
  assert.equal(result.status,503);
  assert.equal(result.data.ok,false);
  f.db.fail=null;
  assert.equal((await f.request('/api/v1/acceptance/report?id='+run.id)).data.latest,null);
  assert.equal(logs.filter(e=>e.event==='paper_acceptance_result').length,0);
});

test('cancel acceptance recovery remains idempotent across market opening and changed queue consent',async t=>{
  const f=setup(t);await f.resume();f.broker.clock.is_open=false;const run=await prepare(f);
  assert.equal((await cancelCheck(f,run,{allow_queued:true})).status,200);
  f.broker.clock.is_open=true;
  const recovered=await cancelCheck(f,run,{allow_queued:false});
  assert.equal(recovered.status,200);
  assert.equal(recovered.data.results[0].status,'canceled');
  assert.equal(f.broker.posts().length,1);
  assert.equal((await cancelCheck(f,run,{confirm:false})).status,400);
});
