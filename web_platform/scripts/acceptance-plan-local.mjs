import {DatabaseSync} from 'node:sqlite';import {readdirSync} from 'node:fs';
const dir='.wrangler/state/v3/d1/miniflare-D1DatabaseObject/';
for(const file of readdirSync(dir).filter(f=>f.endsWith('.sqlite')&&f!=='metadata.sqlite')){
 const db=new DatabaseSync(dir+file,{readOnly:true});try{
  const feeds=Object.fromEntries(db.prepare('SELECT market,payload FROM portfolio_quotes').all().map(r=>[r.market,JSON.parse(r.payload)]));
  console.log(JSON.stringify({feeds:Object.values(feeds).map(f=>({market:f.market,asof:f.asof,is_open:f.is_open,count:f.instruments.length}))}));
  const candidates=[];
  for(const r of db.prepare('SELECT strategy_id,payload FROM portfolio_signals WHERE strategy_id LIKE ?').all('HK:%')){
   const s=JSON.parse(r.payload),qs=Object.fromEntries((feeds.HK?.instruments||[]).map(q=>[q.symbol,q]));
   if(!s.targets.every(t=>qs[t.symbol]&&Date.now()-Date.parse(qs[t.symbol].asof)<90000))continue;
   const thresholds=s.targets.filter(t=>qs[t.symbol]?.tradable).map(t=>({symbol:t.symbol,min:qs[t.symbol].lot*qs[t.symbol].price/t.weight})).sort((a,b)=>a.min-b.min);if(!thresholds.length)continue;
   const budget=Math.ceil(thresholds[0].min*1.04/100)*100;
   const orders=s.targets.map(t=>({symbol:t.symbol,qty:qs[t.symbol]?Math.floor(budget*t.weight/qs[t.symbol].price/qs[t.symbol].lot)*qs[t.symbol].lot:0,price:qs[t.symbol]?.price})).filter(o=>o.qty>0);
   if(orders.length===1&&orders[0].qty*orders[0].price<7000&&orders[0].symbol!=='288.HK')candidates.push({id:r.strategy_id,budget,orders});
  }
  console.log(JSON.stringify({candidates:candidates.sort((a,b)=>a.budget-b.budget).slice(0,3)}));
 }finally{db.close();}
}
