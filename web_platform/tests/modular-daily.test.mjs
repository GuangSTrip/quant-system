import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {drawdownSeries,periodSlice,curveStory} from '../src/daily-workbench.mjs';
import {refinementPoints} from '../src/daily-refinement.mjs';

test('refinement curves share an origin and published experiments include cost and delay checks',async()=>{
  const points=refinementPoints(['a','b','c'],[2,2.5,2],[3,3,3.3],'drawdown');
  assert.ok(Math.abs(points[2].current+20)<1e-10);
  assert.equal(points[2].previous,0);
  const data=JSON.parse(await readFile(new URL('../src/daily-refinement.json',import.meta.url),'utf8'));
  assert.equal(Object.values(data.markets).reduce((n,m)=>n+m.experiments.length,0),34);
  for(const m of Object.values(data.markets)){
    for(const r of [...m.experiments,m.selected,m.previous,m.double_cost,m.delayed_open]){
      assert.equal(r.equity.length,m.dates.length);
      assert.ok(r.equity.every(v=>Number.isFinite(v)&&v>0));
      const actual=(r.equity.at(-1)/r.equity[0]-1)*100;
      assert.ok(Math.abs(actual-r.full.total_return_pct)<.001);
    }
  }
});

test('review-period chart retains the preceding close and recovery comes after the trough',()=>{
  const dates=['2025-12-30','2025-12-31','2026-01-02','2026-01-05'];
  assert.deepEqual(periodSlice(dates,'review'),{start:2,end:4,anchor:1});
  assert.deepEqual(drawdownSeries([1,1.25,1,1.3]),[0,0,-.19999999999999996,0]);
  assert.deepEqual(curveStory(dates,[1,1.25,1,1.3]),{depth:-.19999999999999996,from:dates[1],trough:dates[2],recovery:dates[3]});
});

test('each market exposes the complete independently selectable rule product and matching curves',async()=>{
  const data=JSON.parse(await readFile(new URL('../src/modular-daily-results.json',import.meta.url),'utf8'));
  assert.deepEqual(Object.keys(data.markets).sort(),['CN','HK','US']);
  for(const market of Object.values(data.markets)){
    assert.equal(market.combinations.length,48);
    assert.equal(new Set(market.combinations.map(r=>r.id)).size,48);
    const selected=market.combinations.find(r=>r.id===market.development_choice.id);
    assert.ok(selected);
    const eligible=market.combinations.filter(r=>r.development.cagr_pct>=8&&r.development.max_drawdown_pct>=-10);
    const pool=eligible.length?eligible:market.combinations;
    assert.equal(selected.development.sharpe,Math.max(...pool.map(r=>r.development.sharpe)));
    for(const r of [...market.combinations,market.benchmark,market.cost_stress]){
      assert.equal(r.equity.length,market.dates.length);
      assert.equal(r.exposure.length,market.dates.length);
      assert.ok(r.equity.every(x=>Number.isFinite(x)&&x>0));
      assert.ok(r.exposure.every(x=>Number.isFinite(x)&&x>=-1e-6&&x<=1.00001));
      const cumulative=(r.equity.at(-1)/r.equity[0]-1)*100;
      assert.ok(Math.abs(cumulative-r.full.total_return_pct)<.001);
      for(const p of ['development','review'])assert.ok(Number.isFinite(r[p].cagr_pct)&&Number.isFinite(r[p].max_drawdown_pct));
    }
  }
});
