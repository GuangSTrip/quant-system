import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {LIBRARY_STRATEGIES,runMinuteResearch} from '../src/minute-library.mjs';

const demo=JSON.parse(readFileSync(new URL('../src/library-demo.json',import.meta.url),'utf8'));
test('all three strategies run for each market and preserve sample provenance',()=>{
  assert.equal(demo.reports.length,9);
  for(const market of ['US','HK','CN'])for(const strategy of LIBRARY_STRATEGIES){
    const report=demo.reports.find(x=>x.market===market&&x.type===strategy.id);
    assert.ok(report);assert.equal(report.days,5);assert.ok(report.rows>=1000);
    assert.equal(report.sampleKind,market==='US'?'historical':'synthetic');
    assert.ok(Number.isFinite(report.net));assert.ok(Number.isFinite(report.baselineNet));
    assert.ok(report.equityCurve.length>100);
    assert.ok(Math.abs(report.equityCurve.at(-1).equity-(report.budget+report.net))<1e-8);
    assert.ok(Math.abs(report.equityCurve.at(-1).benchmark-(report.budget+report.baselineNet))<1e-8);
    assert.ok(report.maxDrawdown<=0);
    assert.ok(report.orders.every(order=>report.equityCurve.some(point=>point.t===order.t)));
    if(market!=='US')assert.ok(Number.isInteger(report.simulationSeed));
  }
});
test('A-share simulation never sells shares purchased on the same day',()=>{
  for(const report of demo.reports.filter(x=>x.market==='CN')){
    let boughtDay='';
    for(const order of report.orders){
      if(order.side==='buy')boughtDay=order.t.slice(0,10);
      else assert.notEqual(order.t.slice(0,10),boughtDay);
      assert.equal(order.qty%100,0);
    }
  }
});
test('the saved real short sample reproduces its research result',()=>{
  const raw=JSON.parse(readFileSync(new URL('../demo-data/SPY-1Min-snapshot.json',import.meta.url),'utf8'));
  const report=demo.reports.find(x=>x.market==='US'&&x.type==='opening_range');
  const rerun=runMinuteResearch(raw.bars,{market:'US',symbol:'SPY',type:'opening_range',budget:2000});
  assert.equal(rerun.net,report.net);assert.deepEqual(rerun.orders,report.orders);
});
