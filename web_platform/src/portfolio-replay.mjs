import {requireValue} from './engine.mjs';
export function replayDetails(r,dates){
 const finite=n=>typeof n==='number'&&Number.isFinite(n),symbol=s=>typeof s==='string'&&s.length>0&&s.length<=30;
 const decisions=r.decisions||[],trades=r.trades||[];
 requireValue(Array.isArray(decisions)&&(!decisions.length||decisions.length===dates.length),'逐日决策数量无效');
 const clean=decisions.map((d,i)=>{
  requireValue(d&&d.t===dates[i]&&typeof d.rebalanced==='boolean'&&typeof d.reason==='string'&&d.reason.length<=500&&Array.isArray(d.targets)&&d.targets.length<=500&&d.targets.every(t=>t&&symbol(t.symbol)&&finite(t.weight)&&t.weight>=0&&t.weight<=1)&&d.targets.reduce((a,t)=>a+t.weight,0)<=1.000001,'逐日决策记录无效');
  const holdings=d.holdings||[];
  requireValue(Array.isArray(holdings)&&holdings.length<=500&&holdings.every(h=>h&&symbol(h.symbol)&&finite(h.qty)&&h.qty>=0&&finite(h.price)&&h.price>0)&&(d.cash===undefined||finite(d.cash)&&d.cash>=-0.000001),'逐日持仓或现金无效');
  return {t:d.t,rebalanced:d.rebalanced,reason:d.reason,targets:d.targets.map(t=>({symbol:t.symbol,weight:t.weight})),...(d.cash!==undefined?{cash:d.cash}:{}),holdings:holdings.map(h=>({symbol:h.symbol,qty:h.qty,price:h.price}))};
 });
 const allowed=new Set(dates);
 requireValue(Array.isArray(trades)&&trades.length<=50000&&trades.every((t,i)=>t&&allowed.has(t.t)&&typeof t.signal_t==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(t.signal_t)&&t.signal_t<t.t&&(!i||t.t>=trades[i-1].t)&&symbol(t.symbol)&&['buy','sell'].includes(t.side)&&['qty','price','cost'].every(k=>finite(t[k]))&&t.qty>0&&t.price>0&&t.cost>=0),'逐笔回测成交无效');
 requireValue((r.cost===undefined||finite(r.cost)&&r.cost>=0)&&(r.trade_count===undefined||Number.isInteger(r.trade_count)&&r.trade_count>=0),'成本或成交次数无效');
 if(trades.length&&r.trade_count!==undefined)requireValue(trades.length===r.trade_count,'成交总数与明细不一致');
 return {decisions:clean,trades:trades.map(t=>Object.fromEntries(['t','signal_t','symbol','side','qty','price','cost'].map(k=>[k,t[k]]))),...(r.cost!==undefined?{cost:r.cost}:{}),...(r.trade_count!==undefined?{trade_count:r.trade_count}:{})};
}
