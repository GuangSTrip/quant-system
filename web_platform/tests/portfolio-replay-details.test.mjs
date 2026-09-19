import test from 'node:test';import assert from 'node:assert/strict';import {replayDetails} from '../src/portfolio-replay.mjs';
test('portfolio replay retains actual holdings and fills, rejects same-day signals and impossible weights',()=>{
 const dates=['2026-01-01','2026-01-02'],decisions=dates.map(t=>({t,rebalanced:true,reason:'test',cash:900,holdings:[{symbol:'SPY',qty:1,price:100}],targets:[{symbol:'SPY',weight:.1}]}));
 const trades=[{t:dates[1],signal_t:dates[0],symbol:'SPY',side:'buy',qty:1,price:100,cost:1}];const r={decisions,trades,cost:1,trade_count:1};assert.deepEqual(replayDetails(r,dates),r);
 assert.throws(()=>replayDetails({...r,trades:[{...trades[0],signal_t:dates[1]}]},dates),/成交/);
 assert.throws(()=>replayDetails({...r,trade_count:2},dates),/总数/);
 assert.throws(()=>replayDetails({...r,decisions:decisions.map(d=>({...d,holdings:[{symbol:'SPY',qty:-1,price:100}]}))},dates),/持仓/);
});
