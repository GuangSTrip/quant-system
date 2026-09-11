import test from 'node:test';
import assert from 'node:assert/strict';
import {backtest,normalizeOrder,riskCheck,strategyConfig,validateBars} from '../src/engine.mjs';
import {bars} from './helpers.mjs';

function context(overrides={}){const time=new Date().toISOString();return {account:{status:'ACTIVE',equity:'10000',last_equity:'10000',cash:'10000',buying_power:'10000'},clock:{is_open:true,timestamp:time},positions:[],openOrders:[],quote:{t:time,ap:100.01,bp:99.99,reference:100,reference_at:time},control:{halted:false,max_order:2500,max_daily:10000,max_position:.25,max_loss:.05},dailyNotional:0,...overrides};}
const order=(extra={})=>normalizeOrder({symbol:'SPY',side:'buy',type:'limit',limit_price:100,qty:1,...extra});
test('backtest uses prior complete bar and is deterministic when replaying a snapshot',()=>{
  const b=bars(),c={symbol:'SPY',type:'sma',fast:5,slow:20,allocation:.2,cost_bps:10};const a=backtest(b,c),again=backtest(b,c);assert.deepEqual(a,again);assert.ok(a.trades.length>0);assert.ok(a.trades.every(t=>Date.parse(t.signal_t)<Date.parse(t.t)));const mutated=b.map(x=>({...x}));mutated.at(-1).c*=3;mutated.at(-1).h=mutated.at(-1).c+1;const altered=backtest(mutated,c);assert.deepEqual(a.curve.slice(0,-1),altered.curve.slice(0,-1));assert.deepEqual(a.trades,altered.trades);
});
test('backtest accounts for costs and supports each strategy template',()=>{
  for(const type of ['sma','momentum','buy_hold']){const c={symbol:'SPY',type,allocation:.2};const free=backtest(bars(),{...c,cost_bps:0}),paid=backtest(bars(),{...c,cost_bps:25});assert.ok(paid.metrics.total_cost>0);assert.ok(paid.curve.at(-1).equity<free.curve.at(-1).equity);assert.ok(paid.metrics.max_drawdown<=0);assert.ok(Number.isFinite(paid.metrics.sharpe));}
});
test('malformed and insufficient datasets cannot produce a research result',()=>{
  const b=bars();assert.throws(()=>validateBars([b[0],b[0]]),/重复/);assert.throws(()=>validateBars([{...b[0],l:b[0].h+1}]),/不一致/);assert.throws(()=>backtest(b.slice(0,10),{symbol:'SPY'}),/不足/);assert.throws(()=>strategyConfig({symbol:'SPY',fast:50,slow:20}),/周期/);
});
test('order contract rejects fractional stocks, unsupported symbols and invalid stop limits',()=>{
  assert.throws(()=>order({qty:1.2}),/整数/);assert.throws(()=>order({symbol:'BTC/USD'}),/请选择/);assert.throws(()=>order({type:'stop_limit',stop_price:110,limit_price:100}),/覆盖/);assert.throws(()=>order({qty:NaN}),/范围/);assert.equal(order({type:'market'}).limit_price,undefined);
});
test('server halt, account loss, order and daily caps fail closed',()=>{
  const c=context();for(const [patch,code]of [[{control:{...c.control,halted:true}},'HALTED'],[{account:{...c.account,equity:'9400'}},'DAILY_LOSS'],[{control:{...c.control,max_order:50}},'ORDER_LIMIT'],[{dailyNotional:9950},'DAILY_LIMIT']])assert.throws(()=>riskCheck(order(),{...c,...patch}),e=>e.code===code);
});
test('fresh IEX data required during market hours; closed-market reference has a bounded age',()=>{
  const c=context();assert.throws(()=>riskCheck(order(),{...c,quote:{...c.quote,t:'2020-01-01'}}),e=>e.code==='STALE_QUOTE');const closed={...c,clock:{...c.clock,is_open:false},quote:{...c.quote,t:'2020-01-01'}};assert.equal(riskCheck(order(),closed).queued,true);assert.throws(()=>riskCheck(order({type:'market'}),closed),e=>e.code==='STALE_QUOTE');assert.throws(()=>riskCheck(order(),{...closed,quote:{...closed.quote,reference_at:'2020-01-01'}}),e=>e.code==='STALE_QUOTE');
});
test('pending sell orders reserve shares and prevent accidental short sales',()=>{
  const c=context({positions:[{symbol:'SPY',qty:'5',market_value:'500'}],openOrders:[{symbol:'SPY',side:'sell',qty:'4',filled_qty:'0'}]});assert.throws(()=>riskCheck(order({side:'sell',qty:2}),c),e=>e.code==='POSITION_LIMIT');assert.equal(riskCheck(order({side:'sell',qty:1}),c).notional,100);
});
test('pending buys reserve cash and concentration; unpriced external orders block buys',()=>{
  const c=context(),pending={symbol:'SPY',side:'buy',qty:'24',filled_qty:'0',limit_price:'100'};assert.throws(()=>riskCheck(order({qty:2}),{...c,openOrders:[pending]}),e=>e.code==='CONCENTRATION_LIMIT');assert.throws(()=>riskCheck(order(),{...c,account:{...c.account,cash:'100'},openOrders:[{...pending,qty:'1'}]}),e=>e.code==='CASH_LIMIT');assert.throws(()=>riskCheck(order(),{...c,openOrders:[{...pending,symbol:'MSFT',limit_price:null}]}),e=>e.code==='OPEN_ORDER_UNPRICED');
});
