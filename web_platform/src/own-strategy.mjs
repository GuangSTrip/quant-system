import rawSample from './own-research.json';
const sample=typeof rawSample==='string'?JSON.parse(rawSample):rawSample;
import {backtest,strategyConfig,requireValue,marketMinute} from './engine.mjs';
import {selectUniverse} from './universe-kernel.mjs';
import {runPerformance} from './portfolio-history.mjs';
export const OWN_ID='US:own-enhanced';
export function ownDataset(symbol){
 const raw=sample.symbols[symbol];requireValue(raw,'本组样本不含该股票',400);
 const bars=raw.map(r=>Object.fromEntries(sample.columns.map((k,i)=>[k,r[i]])));
 return {source:sample.source,adjustment:'raw',fetched_at:null,sample_sha256:sample.sha256,query:{symbols:symbol,timeframe:'1Min',start:bars[0].t,end:bars.at(-1).t,feed:'archived-yahoo'},bars};
}
let cachedResearch;
export function ownResearch(){
 if(cachedResearch)return cachedResearch;
 const pool=Object.keys(sample.symbols),daily={},minutes={};
 for(const symbol of pool){const bars=ownDataset(symbol).bars.filter(b=>{const m=marketMinute(b.t);return m.minute>=570&&m.minute<960;});minutes[symbol]=bars;const days=new Map();for(const b of bars){const key=marketMinute(b.t).day,d=days.get(key)||{t:key,c:b.c,v:0};d.c=b.c;d.v+=b.v;days.set(key,d);}daily[symbol]=[...days.values()];}
 const selection=selectUniverse(pool,daily,minutes,sample.as_of,5);
 const config=strategyConfig({name:'本组自研 · 日内增强均值回归',symbol:'TSLA',type:'enhanced_reversion',days:10,budget:2000,threshold_bps:60,cost_bps:10,lookback:20,time_stop_bars:60,guard_sigma:1.5,max_entries_per_day:1});
 const demo=backtest(ownDataset('TSLA').bars,config);
 return cachedResearch={ok:true,as_of:sample.as_of,source:sample.source,note:sample.note,sha256:sample.sha256,pool,selection,demo:{...demo,data_source:sample.source},scope:'固定股票的历史规则回测；不代表动态选池组合收益。'};
}
export async function ownRuns(db,current){
 const results=(await db.prepare("SELECT * FROM events WHERE kind='strategy_started' ORDER BY timestamp DESC LIMIT 200").all()).results;
 const out=[];
 for(const event of results){const d=JSON.parse(event.details);if(d.config?.type!=='enhanced_reversion')continue;
  const id=event.subject,raw=(await db.prepare('SELECT * FROM orders WHERE actor=? ORDER BY created_at').bind('auto:'+id).all()).results;
  const orders=raw.map(o=>{const p=JSON.parse(o.payload),b=o.broker_data?JSON.parse(o.broker_data):{};return {symbol:p.symbol,side:p.side,qty:Number(p.qty),filled:Number(b.filled_qty||0),price:b.filled_avg_price?Number(b.filled_avg_price):null,status:o.status,submitted_at:o.created_at,filled_at:b.filled_at||null,updated_at:o.updated_at};});
  const cycles=(await db.prepare('SELECT * FROM auto_cycles WHERE run_id=? ORDER BY id DESC LIMIT 30').bind(id).all()).results.map(r=>({...r,details:JSON.parse(r.details)}));
  out.push({id,started_at:event.timestamp,config:d.config,budget:d.budget,state:current.run_id===id?(current.enabled?'运行中':'已暂停'):'历史运行',orders,cycles,metrics:runPerformance(orders,d.budget)});
 }
 return {ok:true,runs:out,notes:'按实际累计成交计算，未扣券商税费。持仓缺少有效报价时不显示合计盈亏。每次最多展示30次检查；更早检查可能已按系统保留策略清理。'};
}
