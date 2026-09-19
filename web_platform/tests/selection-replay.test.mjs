import test from 'node:test';
import assert from 'node:assert/strict';
import {portfolioReplay,eventIndices} from '../src/replay-model.mjs';
test('archived candidates remain selection evidence, never reconstructed fills or holdings',()=>{
 const r={name:'sample',report:{dates:['2025-01-01','2025-01-02'],equity:[1,1.01],full:{total_return_pct:1,max_drawdown_pct:0},selection_history:[{date:'2025-01-02',symbols:['ABC']}]}};
 const m=portfolioReplay(r);assert.deepEqual(eventIndices(m),[1]);assert.equal(m.decisions[0].selection_only,true);assert.equal(m.decisions[0].targets,undefined);assert.equal(m.trades.length,0);
 r.report.decisions=[{t:'2025-01-01',reason:'kernel',holdings:[]}];assert.equal(portfolioReplay(r).decisions[0].reason,'kernel');
});
