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
    assert.equal(report.sampleKind,'historical');
    assert.ok(Number.isFinite(report.net));assert.ok(Number.isFinite(report.baselineNet));
    assert.ok(report.equityCurve.length>100);
    assert.ok(Math.abs(report.equityCurve.at(-1).equity-(report.initialCapital+report.net))<1e-8);
    assert.ok(Math.abs(report.equityCurve.at(-1).benchmark-(report.initialCapital+report.baselineNet))<1e-8);
    assert.ok(report.maxDrawdown<=0);
    assert.ok(report.orders.every(order=>report.equityCurve.some(point=>point.t===order.t)));
    assert.equal(report.simulationSeed,null);
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
test('advanced candidate uses the same causal execution and survives cost stress',()=>{
  const raw=JSON.parse(readFileSync(new URL('../demo-data/SPY-1Min-snapshot.json',import.meta.url),'utf8'));
  const basic=runMinuteResearch(raw.bars,{market:'US',symbol:'SPY',type:'volume_vwap_breakout',budget:2000});
  const stressed=runMinuteResearch(raw.bars,{market:'US',symbol:'SPY',type:'volume_vwap_breakout',budget:2000,costMultiplier:2});
  assert.equal(basic.days,5);
  assert.equal(stressed.costBps,20);
  assert.ok(stressed.net<=basic.net);
  for(const order of basic.orders.filter(x=>x.reason.includes('强制平仓'))){
    const bar=raw.bars.find(x=>x.t===order.t);
    assert.equal(order.price,bar.o);
  }
});
