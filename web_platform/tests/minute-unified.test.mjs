import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {backtest,intradayDecision,strategyConfig} from '../src/engine.mjs';
import {runMinuteResearch} from '../src/minute-library.mjs';
import {validateMinuteSnapshot,minuteValidation} from '../src/minute-validation.mjs';
const raw=JSON.parse(readFileSync(new URL('../demo-data/SPY-1Min-snapshot.json',import.meta.url)));
for(const type of ['opening_range','vwap_reversion','adaptive_momentum'])test(type+' shares fills, signals, costs and account denominator with parameter backtests',()=>{
 const params={market:'US',symbol:'SPY',type,budget:2000,threshold_bps:25,lookback:30,volume_multiplier:1.5,volatility_multiplier:2.5};
 const library=runMinuteResearch(raw.bars,params),engine=backtest(raw.bars,library.config);
 assert.deepEqual(library.orders,engine.trades);assert.deepEqual(library.decisions,engine.decisions);
 assert.ok(Math.abs(library.net/library.initialCapital-engine.metrics.total_return)<1e-12);
 assert.equal(library.maxDrawdown,engine.metrics.max_drawdown);assert.equal(library.totalCost,engine.metrics.total_cost);
});
test('adaptive parameters are validated and changing thresholds changes actual fills',()=>{
 assert.throws(()=>strategyConfig({type:'adaptive_momentum',symbol:'SPY',lookback:20.5}));
 const a=runMinuteResearch(raw.bars,{market:'US',symbol:'SPY',type:'adaptive_momentum',budget:2000,threshold_bps:0,volume_multiplier:.1});
 const b=runMinuteResearch(raw.bars,{market:'US',symbol:'SPY',type:'adaptive_momentum',budget:2000,threshold_bps:200,volume_multiplier:10});
 assert.notDeepEqual(a.orders,b.orders);assert.deepEqual(b.orders,[]);
});
test('import rejects ambiguous timestamps and duplicate bars; short samples do not pass validation',()=>{
 const s={market:'US',symbol:'SPY',timeframe:'1Min',sample_kind:'historical',source:'test',bars:raw.bars};
 const good=validateMinuteSnapshot(s);assert.ok(good.bars.length);
 assert.throws(()=>validateMinuteSnapshot({...s,bars:[{...raw.bars[0],t:'2026-09-09T09:30:00'}]}),/时区/);
 assert.throws(()=>validateMinuteSnapshot({...s,bars:[raw.bars[0],raw.bars[0]]}),/重复/);
 const report=minuteValidation(s,{type:'adaptive_momentum',budget:2000,cost_bps:10});assert.match(report.status,/样本不足/);assert.ok(report.development&&report.holdout&&report.double_cost);assert.equal(report.development.days+report.holdout.days,report.full.days);
});
test('HK and CN custom costs affect ledger rather than only labels',()=>{
 for(const market of ['HK','CN']){const s=JSON.parse(readFileSync(new URL('../demo-data/'+market+'-1Min-snapshot.json',import.meta.url)));const options={market,symbol:s.symbol,type:'vwap_reversion',budget:100000};const free=runMinuteResearch(s.bars,{...options,cost_bps:0}),paid=runMinuteResearch(s.bars,{...options,cost_bps:20});assert.equal(free.totalCost,0);assert.ok(paid.totalCost>0);assert.equal(paid.costBps,20);assert.ok(paid.net<free.net);}
});
