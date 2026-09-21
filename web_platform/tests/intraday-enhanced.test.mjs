import test from 'node:test';
import assert from 'node:assert/strict';
import {backtest,strategyConfig,marketMinute} from '../src/engine.mjs';
import {enhancedDecision,enhancedSession,momentumGuardOk,ENHANCED_DEFAULTS} from '../src/intraday-kernel.mjs';
import worker from '../worker/index.js';
import {setup} from './helpers.mjs';

const start=Date.parse('2026-09-14T13:30:00Z'); // 9:30 Eastern (daylight)
const bar=(base,i,c,v=1000)=>({t:new Date(base+i*60000).toISOString(),o:c,h:c+.02,l:c-.02,c,v});
// day shape: 30 stable bars ~100, a dip at minute 600 (index 30), then a chosen tail
function day(base,tail){return [...Array.from({length:30},(_,i)=>bar(base,i,i%2?100.02:100)),bar(base,30,99.0),...tail.map((p,i)=>bar(base,31+i,p))];}
const config=()=>strategyConfig({symbol:'SPY',type:'enhanced_reversion',days:5,budget:1000,threshold_bps:60,time_stop_bars:60});

test('kernel: entry needs deviation, opening window, and a calm tape',()=>{
  const base=start;
  const calm=day(base,[99.0,99.0]);
  // evaluate ON the dip bar (index 30): its 20-bar lookback is still the calm tape
  const decision=enhancedDecision(enhancedSession([...calm],30),{qty:0,entriesToday:0,entryTime:null},config());
  assert.equal(decision.action,'buy');
  assert.match(decision.reason,/低于VWAP/);
  // same dip but the tape was already collapsing: guard rejects
  const falling=[...Array.from({length:30},(_,i)=>bar(base,i,100*(1-0.002*i))),bar(base,30,90)];
  assert.equal(enhancedDecision(enhancedSession(falling,30),{qty:0,entriesToday:0,entryTime:null},config()).action,'hold');
  // inside the opening window: no entry
  const early=enhancedSession([...Array.from({length:20},(_,i)=>bar(base,i,100)),bar(base,20,99.0)],20);
  assert.equal(enhancedDecision(early,{qty:0,entriesToday:0,entryTime:null},config()).action,'hold'); // minute 590 < 600
  assert.ok(momentumGuardOk(enhancedSession(calm,30),31,20,1.5));
});

test('kernel: exits are VWAP recovery, time stop, and the last-15-minute window',()=>{
  const base=start,c=config();
  // recovery above vwap
  const recover=day(base,[99.0,100.2]);
  assert.equal(enhancedDecision(enhancedSession(recover,32),{qty:10,entriesToday:1,entryTime:null},c).action,'sell');
  // time stop: entered on the dip bar (index 30), evaluated 60 bars later without recovery
  const flatTail=day(base,Array.from({length:61},(_,i)=>99.0));
  const stop=enhancedDecision(enhancedSession(flatTail,91),{qty:10,entriesToday:1,entryTime:flatTail[30].t},{...c,time_stop_bars:60});
  assert.equal(stop.action,'sell');assert.match(stop.reason,/时间止损/);
  // last window always flattens
  const late=enhancedSession([bar(start+375*60000,0,99.0)],0); // 9:30 + 375min = 15:45 ET
  assert.equal(enhancedDecision(late,{qty:10,entriesToday:1,entryTime:null},c).action,'sell');
});

test('backtest: kernel entry fills at the next open, one entry per day, flat by close',()=>{
  const dayBars=day(start,Array.from({length:70},(_,i)=>99.0)); // dip then no recovery -> time stop
  const second=day(start+86400000,[99.0,100.3,100.3]);          // dip then recovery
  const bars=[...dayBars,...second],c=config(),report=backtest(bars,c);
  assert.deepEqual(report,backtest(bars,c)); // deterministic
  assert.ok(report.trades.length>=2);
  const buys=report.trades.filter(t=>t.side==='buy');
  assert.equal(buys.length,2); // one entry per session
  assert.equal(report.trades[0].signal_t,dayBars[30].t); // decided on the dip bar...
  assert.equal(report.trades[0].t,dayBars[31].t);        // ...filled at the next open
  for(const day of ['2026-09-14','2026-09-15']){
    const trades=report.trades.filter(t=>marketMinute(t.t).day===day);
    assert.equal(trades.reduce((q,t)=>q+(t.side==='buy'?t.qty:-t.qty),0),0,'flat by close each day');
  }
  const day1Sell=report.trades.find(t=>t.side==='sell'&&marketMinute(t.t).day==='2026-09-14');
  assert.ok(day1Sell,'day 1 must exit before close');
  assert.ok(report.decisions.some(d=>/时间止损/.test(d.reason)),'time stop must appear in decisions');
  // no lookahead: mutating the final bar cannot change earlier trades
  const changed=bars.map(b=>({...b}));changed.at(-1).c*=1.02;changed.at(-1).h=changed.at(-1).c+.02;
  assert.deepEqual(report.trades.slice(0,-1),backtest(changed,c).trades.slice(0,-1));
});

test('strategyConfig validates the enhanced params and the extended symbol whitelist',()=>{
  assert.equal(config().time_stop_bars,60);
  assert.throws(()=>strategyConfig({...config(),time_stop_bars:4}),/时间止损/);
  assert.throws(()=>strategyConfig({...config(),max_entries_per_day:6}),/每日入场/);
  assert.equal(strategyConfig({...config(),symbol:'TSLA',budget:2500}).symbol,'TSLA');
  assert.throws(()=>strategyConfig({...config(),symbol:'IWM'}),/分钟策略仅允许/);
});

test('worker: backtest + automation run the kernel through the shared engine',async t=>{
  const h=setup(t);
  const dayBars=day(start,Array.from({length:70},(_,i)=>99.0));
  // day 2 ENDS on the dip bar itself: the 20-bar guard window is still the calm
  // tape, so the last completed bar is a valid entry trigger for the tick
  h.broker.historical=[...dayBars,...day(start+86400000,[])];
  h.broker.clock.timestamp=new Date(Date.parse(h.broker.historical.at(-1).t)+2*60000).toISOString();
  h.broker.quote.latestQuote.t=h.broker.clock.timestamp;
  await h.resume();
  const report=await h.request('/api/v1/backtests',{config:{...config(),budget:1000}});
  assert.equal(report.status,200,JSON.stringify(report.data));
  assert.equal(report.data.engine,'course-intraday-2.0.0');
  assert.ok(report.data.trades.some(x=>x.side==='buy'));
  const startAttempt=await h.request('/api/v1/automation/start',{backtest_id:report.data.id,budget:2000,confirm:'启动自动模拟交易'});
  assert.equal(startAttempt.data.code,'BUDGET_MISMATCH'); // budget must equal the backtest
  const approved=await h.request('/api/v1/automation/start',{backtest_id:report.data.id,budget:1000,confirm:'启动自动模拟交易'});
  assert.equal(approved.data.state.enabled,1,JSON.stringify(approved.data));
  const tick=await h.request('/api/v1/automation/tick',{});
  assert.equal(tick.data.outcome,'submitted',JSON.stringify(tick.data));
  assert.equal(h.broker.posts()[0].payload.side,'buy');
  assert.match(tick.data.signal_reason,/低于VWAP|护栏|阈值/);
  const state=await h.request('/api/v1/automation');
  assert.ok(state.data.decisions.length>=1);
});
