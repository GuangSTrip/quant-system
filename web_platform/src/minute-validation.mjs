import {runMinuteResearch} from './minute-library.mjs';
import {validateBars} from './engine.mjs';
export function validateMinuteSnapshot(value){
 if(!value||!['US','HK','CN'].includes(value.market)||value.timeframe!=='1Min'||!['historical','synthetic'].includes(value.sample_kind)||typeof value.source!=='string'||!value.source.trim())throw Error('快照须包含 market、timeframe=1Min、sample_kind、source 和 bars');
 const pattern={US:/^[A-Z.]{1,10}$/,HK:/^\d{4,5}\.HK$/,CN:/^\d{6}\.(SH|SZ)$/};if(!pattern[value.market].test(value.symbol))throw Error('标的代码与市场不匹配');
 if(!Array.isArray(value.bars)||value.bars.length>60000)throw Error('每份快照最多 60000 根分钟线');
 if(value.bars.some(b=>typeof b.t!=='string'||!/(Z|[+-]\d{2}:\d{2})$/.test(b.t)))throw Error('分钟时间必须明确标注 Z 或时区偏移');
 const normalized=value.bars.map(b=>({...b,t:new Date(b.t).toISOString()}));
 return {...value,bars:validateBars(normalized)};
}
export function minuteValidation(snapshot,params){
 const zone={US:'America/New_York',HK:'Asia/Hong_Kong',CN:'Asia/Shanghai'}[snapshot.market],fmt=new Intl.DateTimeFormat('en-CA',{timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit'}),day=t=>fmt.format(new Date(t));
 const days=[...new Set(snapshot.bars.map(b=>day(b.t)))],cut=Math.floor(days.length*.6),train=new Set(days.slice(0,cut)),test=new Set(days.slice(cut));
 const run=(bars,multiplier=1)=>{if(new Set(bars.map(b=>day(b.t))).size<2)return null;const r=runMinuteResearch(bars,{...params,market:snapshot.market,symbol:snapshot.symbol,costMultiplier:multiplier});return {days:r.days,return_pct:100*r.net/r.initialCapital,drawdown_pct:100*r.maxDrawdown,trades:r.orders.length,cost:r.totalCost};};
 return {status:snapshot.sample_kind!=='historical'?'合成样本不能验证历史有效性':cut>=10&&days.length-cut>=10?'已作时间切分检验；仍是探索性结果，不代表未来有效':'样本不足：开发段和检验段均须至少 10 个交易日',full:run(snapshot.bars),development:run(snapshot.bars.filter(b=>train.has(day(b.t)))),holdout:run(snapshot.bars.filter(b=>test.has(day(b.t)))),double_cost:(params.cost_bps??10)<=50?run(snapshot.bars,2):{status:'双倍成本超过 100 基点引擎上限，未计算'}};
}
