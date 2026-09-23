import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {buildPortfolioCatalog} from '../src/portfolio-contract.mjs';
import {courseFrequency,matchingEntries,reportEvidence,dimensions,rankedEntries,balancedScore,optionExplanation,intervalMetrics} from '../src/course-research.mjs';

const read=name=>JSON.parse(readFileSync(new URL('../src/'+name,import.meta.url),'utf8'));
const entries=[...buildPortfolioCatalog(read('modular-daily-results.json'),read('daily-refinement.json')).values()];

test('every archived strategy is reachable by its module choices without crossing markets',()=>{
  for(const e of entries){
    const filters={market:e.market,frequency:courseFrequency(e.config),...Object.fromEntries(dimensions.map(k=>[k,e.config[k]||'base']))};
    assert.deepEqual(matchingEntries(entries,filters).map(x=>x.id),[e.id]);
  }
  assert.equal(matchingEntries(entries,{market:'CN',selection:'does-not-exist'}).length,0);
});
test('course frequency follows decision cadence rather than bar size or lookback',()=>{
  assert.equal(courseFrequency({timing:'trend',allocation:'vol08'}),'daily');
  assert.equal(courseFrequency({timing:'breakout',allocation:'equal'}),'daily');
  assert.equal(courseFrequency({timing:'monthly',allocation:'vol08'}),'longer');
  assert.equal(courseFrequency({timing:'monthly',risk_policy:'cushion07'}),'daily');
});
test('missing costs and transaction records remain unknown instead of zero or fabricated fills',()=>{
  const e=reportEvidence({report:{trade_count:20,selection_history:[{symbols:['A']}],cost:null}});
  assert.equal(e.cost,null);assert.equal(e.costPct,null);assert.equal(e.turnover,null);assert.equal(e.complete,false);
  assert.equal(reportEvidence({report:{cost:10000,traded_notional:2000000}}).costPct,1);
});
test('return, drawdown and balanced ranks stay within one market and frequency',()=>{
  for(const market of ['CN','HK','US'])for(const frequency of ['daily','longer']){
    const rows=matchingEntries(entries,{market,frequency});
    for(const criterion of ['return','total','drawdown','balanced']){
      const ranked=rankedEntries(entries,market,frequency,criterion);
      assert.equal(ranked.length,rows.length);
      assert.ok(ranked.every(e=>e.market===market&&courseFrequency(e.config)===frequency));
      const score=e=>criterion==='return'?e.report.full.cagr_pct:criterion==='total'?e.report.full.total_return_pct:criterion==='drawdown'?-Math.abs(e.report.full.max_drawdown_pct):balancedScore(e);
      for(let i=1;i<ranked.length;i++)assert.ok(score(ranked[i-1])>=score(ranked[i]));
    }
  }
});
test('buy-and-hold references use exactly the archived dates and start at unit net value',()=>{
  const references=read('course-benchmarks.json').markets;
  const original=read('modular-daily-results.json');
  for(const market of ['CN','HK','US']){
    assert.deepEqual(references[market].dates,original.markets[market].dates);
    assert.equal(references[market].equity.length,references[market].dates.length);
    assert.equal(references[market].equity[0],1);
    assert.equal(references[market].initial_symbols.length,100);
  }
});
test('three ETF references use matching market calendars and correctly computed curves',()=>{
  const funds=read('course-fund-benchmarks.json').markets,original=read('modular-daily-results.json').markets;
  for(const market of ['CN','HK','US']){
    const fund=funds[market],dates=original[market].dates;
    assert.equal(fund.market,market);
    assert.deepEqual(fund.dates,dates.slice(0,fund.dates.length));
    assert.ok(fund.initial_filled_pct>0&&fund.initial_filled_pct<=80);
    assert.equal(fund.equity[0],1);
    const m=intervalMetrics(fund.equity,fund.dates);
    assert.ok(Math.abs(m.cagr_pct-fund.full.cagr_pct)<.001);
    assert.ok(Math.abs(m.max_drawdown_pct-fund.full.max_drawdown_pct)<.001);
  }
  assert.equal(funds.US.symbol,'SPY');
  assert.equal(funds.US.dates.at(-1),'2026-05-29');assert.ok(funds.US.dates.length<original.US.dates.length);
  for(const market of ['CN','HK'])assert.deepEqual(funds[market].dates,original[market].dates);
  assert.equal(intervalMetrics([1,1],['2025-01-01']),null);
});
test('every selectable course option has a meaningful explanation and tradeoff',()=>{
  const original=read('modular-daily-results.json');
  for(const market of ['CN','HK','US']){
    for(const e of entries.filter(e=>e.market===market))for(const key of dimensions){
      const explanation=optionExplanation(key,e.config[key]||'base',market,original.rules);
      assert.ok(explanation.length>25,`${market} ${key} ${e.config[key]} lacks explanation`);
    }
    assert.match(optionExplanation('market',market),/股|美股/);
  }
  for(const key of ['frequency','chart-mode','reference','rank-by'])for(const value of {
    frequency:['daily','longer'],'chart-mode':['equity','drawdown'],reference:['buyhold','liquidity','fund','none'],'rank-by':['return','total','drawdown','balanced']
  }[key])assert.ok(optionExplanation(key,value).length>15,`${key} ${value}`);
});
