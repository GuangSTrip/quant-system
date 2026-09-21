import {requireValue,numeric} from './engine.mjs';
export const PORTFOLIO_VERSION='modular-close-1';
export const MARKETS=Object.freeze({US:{currency:'USD',broker:'alpaca'},HK:{currency:'HKD',broker:'longbridge'},CN:{currency:'CNY',broker:'myquant'}});
export function instrumentSymbol(value,market){
 const s=String(value||'').toUpperCase();
 if(market==='US'){requireValue(/^[A-Z][A-Z0-9.-]{0,14}$/.test(s),'美股证券代码无效');return s;}
 if(market==='HK'){requireValue(/^\d{1,5}\.HK$/.test(s)&&parseInt(s)>0,'港股证券代码无效');return parseInt(s)+'.HK';}
 requireValue(/^\d{6}\.(SH|SZ|BJ)$/.test(s),'A 股证券代码无效');return s;
}
export function strategyId(market,r){return [market,r.selection,r.timing,r.allocation,r.risk_policy||'base'].join(':');}
export function buildPortfolioCatalog(original,refined){
 const result=new Map();
 for(const [market,m] of Object.entries(original.markets)){
  const extra=refined.markets[market];
  for(const r of [...m.combinations,...(extra?.experiments||[])]){
   const id=strategyId(market,r),config={selection:r.selection,timing:r.timing,allocation:r.allocation,risk_policy:r.risk_policy||null};
   result.set(id,{id,market,currency:MARKETS[market].currency,version:PORTFOLIO_VERSION,config,
    name:r.label||['selection','timing','allocation'].map(k=>original.rules[k][r[k]].label).join(' × '),
    recommended:extra?.selected&&strategyId(market,extra.selected)===id,
    execution:MARKETS[market].broker?'signal_required':'adapter_required',broker:MARKETS[market].broker,
    report:{...r,dates:m.dates,selection_history:m.metadata?.selection_history?.[r.selection]||[]},source:'历史研究；信号需用最新完整日线重放，收益不等于模拟盘成交'});
  }
 }
 return result;
}
export function validateSignal(input,entry,now=Date.now()){
 requireValue(input.schema_version===1&&input.strategy_version===entry.version,'信号格式或策略版本不匹配',409,'SIGNAL_VERSION');
 requireValue(input.strategy_id===entry.id&&input.market===entry.market&&input.currency===entry.currency,'策略、市场或币种不匹配',409,'SIGNAL_MARKET');
 requireValue(input.available===true,'行情不完整，不能用空目标清仓',409,'SIGNAL_UNAVAILABLE');
 for(const k of ['signal_date','rebalance_date'])requireValue(/^\d{4}-\d{2}-\d{2}$/.test(input[k])&&Number.isFinite(Date.parse(input[k])),k+' 无效');
 const asof=Date.parse(input.data_asof),start=Date.parse(input.execute_after),end=Date.parse(input.expires_at);
 requireValue(Number.isFinite(asof)&&Number.isFinite(start)&&Number.isFinite(end)&&asof<start&&start<end&&end>now&&asof<=now&&now-asof<=7*86400000&&end-start<=24*3600000&&start-asof<=7*86400000,'信号过期或交易时段无效',409,'SIGNAL_EXPIRED');
 requireValue(input.rebalance_date<=input.signal_date&&input.signal_date<=input.data_asof.slice(0,10),'信号日期不一致');
 requireValue(/^[a-f0-9]{64}$/.test(input.data_digest||'')&&typeof input.origin==='string'&&input.origin.length>0&&input.origin.length<=100,'缺少可重放数据摘要或预热起点');
 requireValue(Array.isArray(input.targets)&&input.targets.length<=100,'目标持仓过多');
 const seen=new Set(),targets=input.targets.map(t=>{const symbol=instrumentSymbol(t.symbol,entry.market);requireValue(!seen.has(symbol),'目标证券重复');seen.add(symbol);requireValue(typeof t.weight==='number','目标权重须为数值');return {symbol,weight:numeric(t.weight,'目标权重',0,entry.config.allocation==='equal'?.8:.1)};});
 const caps=input.liquidity_caps;requireValue(caps&&typeof caps==='object'&&!Array.isArray(caps)&&Object.keys(caps).length<=10000,'缺少前一交易日流动性限额');const liquidity_caps={};for(const [symbol,amount] of Object.entries(caps)){const key=instrumentSymbol(symbol,entry.market);requireValue(!Object.hasOwn(liquidity_caps,key),'重复流动性记录');liquidity_caps[key]=numeric(amount,'成交额 1% 上限',0,1e15);}
 requireValue(targets.every(t=>Object.hasOwn(liquidity_caps,t.symbol)),'目标证券缺少流动性限额');
 const total=targets.reduce((a,t)=>a+t.weight,0),cash=numeric(input.cash_weight,'现金权重',.2-1e-8,1);
 requireValue(total<=.8+1e-8&&Math.abs(total+cash-1)<1e-8,'组合权重必须合计 1，股票最多 80%');
 return {schema_version:1,strategy_id:entry.id,strategy_version:entry.version,market:entry.market,currency:entry.currency,available:true,signal_date:input.signal_date,rebalance_date:input.rebalance_date,data_asof:input.data_asof,execute_after:input.execute_after,expires_at:input.expires_at,data_digest:input.data_digest,origin:input.origin,targets,liquidity_caps,cash_weight:cash};
}
export function deltaOrders(signal,owned,quotes,equity,cash,market,sellsComplete=false){
 requireValue(Number.isFinite(equity)&&equity>0&&Number.isFinite(cash)&&cash>=0,'策略资金无效');
 const targets=new Map(signal.targets.map(t=>[t.symbol,t.weight])),orders=[];
 for(const symbol of new Set([...targets.keys(),...Object.keys(owned)])){
  const q=quotes[symbol];requireValue(q&&q.tradable===true&&Number.isSafeInteger(q.lot)&&q.lot>0&&q.price>0&&Number.isFinite(q.price),'缺少可交易价格或每手资料：'+symbol,409,'INSTRUMENT_UNAVAILABLE');
  const current=owned[symbol]||0,target=Math.floor(equity*(targets.get(symbol)||0)/(q.price*q.lot))*q.lot,delta=target-current;
  requireValue(Number.isSafeInteger(current)&&current>=0&&current%q.lot===0,'持仓发生拆股或出现碎股，请人工核对',409,'POSITION_DRIFT');
  if(Math.abs(delta)*q.price<equity*.0005||delta===0)continue;
  const price=market==='US'?Number((q.price*(delta>0?1.001:.999)).toFixed(2)):q.price;
  const cap=signal.liquidity_caps?.[symbol];requireValue(Number.isFinite(cap)&&cap>=0,'缺少落选或持有证券的流动性限额：'+symbol,409,'INSTRUMENT_UNAVAILABLE');
  const qty=Math.min(Math.abs(delta),Math.floor(cap/(price*q.lot))*q.lot);
  if(market==='CN'&&delta<0&&qty>0)requireValue(Number.isSafeInteger(q.available)&&q.available>=qty,'A股持仓尚不可卖，等待T+1交收',409,'CN_T1');
  if(qty>0)orders.push({symbol,side:delta>0?'buy':'sell',qty,price,lot_size:q.lot});
 }
 // Buys never assume unconfirmed sales have released cash. The next tick follows receipts first.
 const sells=orders.filter(o=>o.side==='sell');if(sells.length&&!sellsComplete)return sells;
 let available=cash*.99;
 return orders.filter(o=>o.side==='buy').map(o=>{const qty=Math.min(o.qty,Math.floor(available/(o.price*1.01*o.lot_size))*o.lot_size);available-=qty*o.price*1.01;return {...o,qty};}).filter(o=>o.qty>0);
}
