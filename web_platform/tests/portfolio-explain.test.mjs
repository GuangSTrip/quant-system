import test from 'node:test';
import assert from 'node:assert/strict';
import {budgetPreview,describeStrategy} from '../src/portfolio-explain.mjs';
const signal={targets:[{symbol:'600000.SH',weight:.1}],cash_weight:.9,execute_after:'2026-09-21T01:30:00Z',expires_at:'2026-09-21T07:00:00Z'};
const now=Date.parse('2026-09-21T02:00:00Z');
test('missing quotes never fabricate quantities; monetary targets remain visible',()=>{
 const r=budgetPreview(signal,10000,null,now);assert.equal(r.rows[0].amount,1000);assert.equal(r.rows[0].target_qty,null);assert.equal(r.rows[0].held,null);assert.equal(r.cash_amount,9000);
});
test('preview rounds lots and distinguishes held shares, buys and non-target sells',()=>{
 const r=budgetPreview(signal,10000,{cash:10000,is_open:true,pending:false,positions:[{symbol:'600000.SH',qty:200},{symbol:'600036.SH',qty:100}],quotes:{'600000.SH':{price:8,lot:100,tradable:true}}},now);
 assert.equal(r.rows[0].target_qty,100);assert.equal(r.rows[0].delta,-100);assert.equal(r.rows[1].weight,0);assert.equal(r.rows[1].delta,-100);assert.equal(r.rows[1].price,null);
});
test('expired signals and pending orders remain explicit blockers',()=>{
 const r=budgetPreview(signal,10000,{cash:1,is_open:false,pending:true,positions:[],quotes:{}},Date.parse('2026-09-22'));
 assert.ok(r.blockers.some(x=>x.includes('已过期')));assert.ok(r.blockers.some(x=>x.includes('休市')));assert.ok(r.blockers.some(x=>x.includes('未完成委托')));
});
test('empty target is explicit cash allocation, missing signal is not interpreted as liquidation',()=>{
 assert.equal(budgetPreview({...signal,targets:[],cash_weight:1},10000,null,now).cash_amount,10000);
 assert.equal(budgetPreview(null,10000,null,now).cash_amount,null);
});
test('extended China strategies describe implemented ranks instead of generic momentum',()=>{
 const r=describeStrategy({config:{selection:'smooth_momentum',timing:'trend',allocation:'vol08'}});assert.match(r.selection,/120/);assert.match(r.selection,/30/);assert.match(r.timing,/120/);assert.match(r.allocation,/不是收益保证/);
});


test('novice preview explains when budget cannot buy any board lot',()=>{
 const r=budgetPreview(signal,100,{cash:10000,is_open:true,pending:false,positions:[],quotes:{'600000.SH':{price:8,lot:100,tradable:true}}},now);
 assert.equal(r.rows[0].target_qty,0);assert.ok(r.minimum_budget>=8000);assert.ok(r.blockers.some(x=>x.includes('不足一手')));
});
