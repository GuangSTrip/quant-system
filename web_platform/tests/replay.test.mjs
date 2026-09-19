import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {backtest,signalAt,intradayDecision} from '../src/engine.mjs';
import {runMinuteResearch} from '../src/minute-library.mjs';
import {engineReplay,minuteReplay,portfolioReplay,replayAt,eventIndices,reportHTML} from '../src/replay-model.mjs';
const daily=JSON.parse(readFileSync(new URL('../src/classroom-snapshot.json',import.meta.url))),minute=JSON.parse(readFileSync(new URL('../demo-data/SPY-1Min-snapshot.json',import.meta.url)));
for(const type of ['sma','momentum','buy_hold','opening_range_breakout','vwap_reversion'])test(type+' replay records reconcile equity and remain causal',()=>{
 const bars=type.includes('reversion')||type.includes('breakout')?minute.bars:daily.bars;
 const r=backtest(bars,{symbol:'SPY',type,allocation:.3,budget:2000});const model=engineReplay(r);
 assert.equal(r.decisions.length,r.curve.length);
 for(let i=0;i<r.curve.length;i++){const d=r.decisions[i];assert.equal(d.t,r.curve[i].t);assert.ok(Math.abs(d.cash+d.qty*d.price-r.curve[i].equity)<1e-7);assert.equal(replayAt(model,i).decision,d);}
 const changed=structuredClone(bars);changed.at(-1).c*=1.2;changed.at(-1).h=Math.max(changed.at(-1).h,changed.at(-1).c);
 const again=backtest(changed,r.config);assert.deepEqual(again.decisions.slice(0,-1),r.decisions.slice(0,-1));
 assert.ok(eventIndices(model).length);assert.equal(model.points.at(-1).equity/100000-1,model.returnRate);
});
for(const type of ['opening_range','vwap_reversion','adaptive_momentum'])test(type+' minute research replay preserves all observations and fills',()=>{
 const r=runMinuteResearch(minute.bars,{market:'US',symbol:'SPY',type,budget:2000}),m=minuteReplay(r);
 assert.equal(m.points.length,m.decisions.length);assert.ok(m.trades.length);
 m.points.forEach((p,i)=>assert.ok(Math.abs(p.equity-m.decisions[i].cash-m.decisions[i].qty*m.decisions[i].price)<1e-7));
 for(const t of m.trades)assert.ok(m.points.some(p=>p.t===t.t));
 const last=m.points.at(-1);assert.ok(Math.abs(last.equity-r.budget-r.net)<1e-7);
});
test('legacy portfolio reports never fabricate decisions, and exported text is escaped',()=>{
 const m=portfolioReplay({name:'<script>evil()</script>',source:'archive',report:{dates:['2026-01-01','2026-01-02'],equity:[1,1.1],full:{total_return_pct:10,max_drawdown_pct:0}}});
 assert.equal(replayAt(m,0).decision,null);assert.deepEqual(eventIndices(m),[]);
 const html=reportHTML(m,'<svg></svg>');assert.ok(!html.includes('<script>'));assert.ok(html.includes('&lt;script&gt;'));assert.ok(html.includes('未保存逐时点决策'));
});
