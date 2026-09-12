import test from 'node:test';
import assert from 'node:assert/strict';
import {teachingBars,inspectSignal} from '../src/strategy-lab.mjs';
import {backtest,strategyConfig,validateBars} from '../src/engine.mjs';

test('visual explanation uses trailing averages and cannot inspect future prices',()=>{
 const bars=teachingBars(),c=strategyConfig({symbol:'SPY',fast:10,slow:30});
 const before=inspectSignal(bars,c,70),expected=bars.slice(61,71).reduce((n,b)=>n+b.c,0)/10;
 assert.equal(before.fast,expected);assert.equal(before.signal,before.fast>before.slow?1:0);
 bars[71].c=999999;assert.deepEqual(inspectSignal(bars,c,70),before);
 assert.equal(inspectSignal(bars,c,28).ready,false);assert.equal(inspectSignal(bars,c,28).signal,0);
});
test('momentum explanation uses exactly the configured window and equality means flat',()=>{
 const bars=teachingBars(),c=strategyConfig({symbol:'SPY',type:'momentum',slow:30});
 bars[70].c=bars[41].c;const o=inspectSignal(bars,c,70);
 assert.equal(o.reference,bars[41].c);assert.equal(o.signal,0);assert.equal(o.fast,null);
 bars[70].c+=1;assert.equal(inspectSignal(bars,c,70).signal,1);
});
test('parameter exploration changes trades while keeping next-day causal execution',()=>{
 const bars=validateBars(teachingBars()),a=backtest(bars,{symbol:'SPY',fast:10,slow:30}),b=backtest(bars,{symbol:'SPY',fast:5,slow:60});
 assert.notDeepEqual(a.trades,b.trades);assert.ok(a.trades.some(t=>t.side==='sell'));
 for(const t of a.trades){const i=bars.findIndex(b=>b.t===t.t);assert.equal(t.signal_t,bars[i-1].t);assert.equal(t.price,bars[i].o);}
 const hold=backtest(bars,{symbol:'SPY',type:'buy_hold'});assert.equal(hold.trades.length,1);assert.equal(hold.trades[0].side,'buy');
});
