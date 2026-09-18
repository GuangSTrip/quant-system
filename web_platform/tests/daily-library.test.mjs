import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

const file=new URL('../src/daily-library.json',import.meta.url);

test('daily website snapshot excludes failed assets and matches broad validation',async()=>{
  const raw=await readFile(file,'utf8'),data=JSON.parse(raw);
  assert.equal(data.markets.length,3);
  assert.equal(data.reports.length,9);
  assert.equal(data.coverage.length,85);
  assert.equal(data.universe.assets.length,255);
  assert.equal(data.universe.missing.length,5);
  assert.equal(data.universe.groups.length,12);
  assert.deepEqual(new Set(Object.keys(data.dynamic.markets)),new Set(['US','HK','CN']));
  assert.deepEqual(new Set(data.coverage.map(x=>x.market)),new Set(['US','HK','CN']));
  assert.ok(data.coverage.every(x=>x.qa.accepted_rows>1500&&x.source));
  for(const asset of data.universe.assets){
    assert.ok(Number.isFinite(asset.full_return_pct)&&Number.isFinite(asset.full_benchmark_pct));
    assert.ok(asset.curve.length>1&&asset.curve.at(-1).date===asset.to);
    assert.ok(asset.trades.length<=20&&asset.trades.length<=asset.full_trades);
  }
  for(const group of data.universe.groups){
    assert.equal(group.assets,({US_ETF:10,US_STOCK:20,HK:25,CN:30})[group.segment]);
    assert.ok(group.beat_benchmark_count<=group.assets);
    assert.ok(Number.isFinite(group.median_full_pct)&&Number.isFinite(group.median_full_benchmark_pct));
  }
  for(const market of ['US','HK','CN']){
    const study=data.dynamic.markets[market];
    assert.equal(Object.keys(study.candidates).length,3);
    assert.ok(study.candidates[study.selected_on_development]);
    for(const candidate of Object.values(study.candidates)){
      assert.ok(candidate.latest_selection?.picks.length<=5);
      assert.ok(Number.isFinite(candidate.holdout.total_return_pct));
      assert.ok(candidate.curve.length>100);
    }
    const risk=data.risk_budget.markets[market];
    assert.equal(risk.rule,study.selected_on_development);
    assert.deepEqual(new Set(Object.keys(risk.variants)),new Set(['original','vol_06','vol_10','vol_06_brake','vol_10_brake']));
    for(const result of Object.values(risk.variants)){
      assert.ok(Number.isFinite(result.holdout.cagr_pct));
      assert.ok(Number.isFinite(result.holdout.max_drawdown_pct));
    }
  }
  assert.deepEqual(new Set(data.markets.map(x=>x.market)),new Set(['US','HK','CN']));
  for(const report of data.reports){
    const meta=data.markets.find(x=>x.market===report.market&&x.symbol===report.symbol);
    assert.ok(meta?.source&&meta?.qa.accepted_rows>250);
    for(const segment of ['full','development','holdout','double_costs']){
      const result=report[segment];
      assert.ok(Number.isFinite(result.return_pct));
      assert.ok(Number.isFinite(result.max_drawdown_pct));
      if(segment==='full'){
        assert.ok(result.curve.length>0&&result.curve.at(-1).date===result.to);
        assert.equal(result.trades.length,result.trade_count);
      }
    }
    assert.ok(report.full.from<=report.development.to);
    assert.ok(report.development.to<report.holdout.from);
  }
  assert.ok(!/tushare_token|api_key|access_token/i.test(raw));
});
