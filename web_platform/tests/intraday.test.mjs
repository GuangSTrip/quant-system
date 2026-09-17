import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {backtest,intradayDecision,marketMinute,strategyConfig} from '../src/engine.mjs';
import worker from '../worker/index.js';
import {setup} from './helpers.mjs';

const start=Date.parse('2026-09-14T13:30:00Z');
function session(day,mode='breakout'){
  const base=start+day*86400000;
  return Array.from({length:390},(_,i)=>{
    const p=mode==='breakout'?(i<15?100+i*.002:100.1+(i-15)*.002):(i<15?100:99.5+(i-15)*.001);
    return {t:new Date(base+i*60000).toISOString(),o:p,h:p+.02,l:p-.02,c:p,v:1000};
  });
}
const config=type=>({symbol:'SPY',type,days:5,budget:1000,opening_minutes:15,threshold_bps:0,cost_bps:10});

test('local broker fixture is identified in the overview response',async(t)=>{
  const h=setup(t);
  h.env.DEMO_MODE='local-fixture';
  const result=await h.request('/api/v1/overview');
  assert.equal(result.status,200);
  assert.equal(result.data.demo_mode,true);
  assert.match(result.data.source,/本地券商替身/);
});

test('minute strategies share a deterministic rule and never carry simulated positions overnight',()=>{
  for(const [type,mode] of [['opening_range_breakout','breakout'],['vwap_reversion','reversion']]){
    const bars=[...session(0,mode),...session(1,mode)],c=config(type),report=backtest(bars,c);
    assert.deepEqual(report,backtest(bars,c));
    assert.ok(report.trades.some(t=>t.side==='buy'));
    assert.ok(report.trades.some(t=>t.side==='sell'));
    assert.ok(report.trades.every(t=>Date.parse(t.signal_t)<=Date.parse(t.t)));
    assert.equal(report.curve.at(-1).equity,100000*(1+report.metrics.total_return));
    for(const day of ['2026-09-14','2026-09-15']){
      const trades=report.trades.filter(t=>marketMinute(t.t).day===day);
      assert.equal(trades.reduce((q,t)=>q+(t.side==='buy'?t.qty:-t.qty),0),0);
    }
    const fee=c.cost_bps/10000,first=session(0,mode),second=session(1,mode);
    const benchmark=[first,second].reduce((cash,dayBars)=>{const quantity=Math.floor(c.budget/(dayBars[0].o*(1+fee)));return cash+quantity*(dayBars.at(-1).c-dayBars[0].o)-quantity*(dayBars[0].o+dayBars.at(-1).c)*fee;},100000);
    assert.ok(Math.abs(report.curve.at(-1).benchmark-benchmark)<1e-8);
    assert.ok(Math.abs(report.metrics.benchmark_return-(benchmark/100000-1))<1e-12);
  }
});
test('only the previous complete bar can affect an entry at the next open',()=>{
  const bars=[...session(0),...session(1)],c=config('opening_range_breakout'),a=backtest(bars,c);
  const changed=bars.map(b=>({...b}));changed.at(-1).c*=2;changed.at(-1).h=changed.at(-1).c+.02;
  const b=backtest(changed,c);
  assert.deepEqual(a.trades.slice(0,-1),b.trades.slice(0,-1));
});
test('minute configuration, session clock and range warmup reject invalid inputs',()=>{
  assert.throws(()=>strategyConfig({...config('vwap_reversion'),days:90}),/历史天数/);
  assert.equal(strategyConfig({...config('vwap_reversion'),days:30}).days,30);
  assert.throws(()=>strategyConfig({...config('vwap_reversion'),symbol:'IWM'}),/分钟策略仅允许/);
  assert.equal(marketMinute('2026-09-14T13:30:00Z').minute,570);
  assert.equal(intradayDecision(session(0),2,strategyConfig(config('opening_range_breakout'))).signal,0);
});
test('historical minute fetch follows Alpaca page tokens for a longer fixed universe backtest',async t=>{
  const h=setup(t),first=session(0),second=session(1);
  h.broker.onGet=url=>{if(url.pathname!=='/v2/stocks/bars')return null;const next=url.searchParams.get('page_token');return Response.json({bars:{SPY:next?second:first},next_page_token:next?null:'page-two'});};
  await h.resume();const r=await h.request('/api/v1/backtests',{config:{...config('opening_range_breakout'),days:30}});
  assert.equal(r.status,200,JSON.stringify(r.data));assert.equal(r.data.quality.rows,780);
  assert.equal(h.broker.calls.filter(x=>x.url.pathname==='/v2/stocks/bars').length,2);
});
test('web backtest fetches 1Min bars and Paper automation enforces the same budget and signal',async t=>{
  const h=setup(t);h.broker.historical=[...session(0),...session(1).slice(0,40)];
  h.broker.clock.timestamp=new Date(Date.parse(h.broker.historical.at(-1).t)+2*60000).toISOString();
  h.broker.quote.latestQuote.t=h.broker.clock.timestamp;
  await h.resume();
  const report=await h.request('/api/v1/backtests',{config:config('opening_range_breakout')});
  assert.equal(report.status,200,JSON.stringify(report.data));
  assert.equal(report.data.config.budget,1000);
  assert.equal(h.broker.calls.find(x=>x.url.pathname==='/v2/stocks/bars').url.searchParams.get('timeframe'),'1Min');
  const start={backtest_id:report.data.id,budget:2000,confirm:'启动自动模拟交易'};
  assert.equal((await h.request('/api/v1/automation/start',start)).data.code,'BUDGET_MISMATCH');
  const approved=await h.request('/api/v1/automation/start',{...start,budget:1000});
  assert.equal(approved.data.state.enabled,1,JSON.stringify(approved.data));
  const tick=await h.request('/api/v1/automation/tick',{});
  assert.equal(tick.data.outcome,'submitted',JSON.stringify(tick.data));
  assert.equal(h.broker.posts()[0].payload.side,'buy');
  assert.match(tick.data.signal_reason,/突破/);
});
test('saved public SPY minute snapshot reproduces both strategy reports',()=>{
  const snapshot=JSON.parse(readFileSync(new URL('../demo-data/SPY-1Min-snapshot.json',import.meta.url),'utf8'));
  assert.equal(snapshot.symbol,'SPY');assert.equal(snapshot.timeframe,'1Min');assert.ok(snapshot.bars.length>1000);
  for(const type of ['opening_range_breakout','vwap_reversion']){
    const result=backtest(snapshot.bars,{...config(type),budget:2000,threshold_bps:type==='opening_range_breakout'?0:20});
    assert.ok(result.trades.some(x=>x.side==='buy'));
    assert.ok(result.trades.some(x=>x.side==='sell'));
    assert.ok(Number.isFinite(result.metrics.total_return));
  }
});
