// Offline comparison only; no broker calls and no parameter optimization.
import {readFile,readdir,writeFile,mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {ADVANCED_MINUTE_STRATEGY,LIBRARY_STRATEGIES,LIBRARY_MARKETS,runMinuteResearch} from '../src/minute-library.mjs';

const inputs=[{market:'US',symbol:'SPY',path:new URL('../demo-data/SPY-1Min-snapshot.json',import.meta.url)}];
const local=new URL('../demo-data/library-inputs/',import.meta.url);
try{for(const name of (await readdir(local)).filter(x=>x.endsWith('.json')).sort()){
  const path=new URL(name,local),input=JSON.parse(await readFile(path,'utf8'));
  if(!['US','HK','CN'].includes(input.market)||input.timeframe!=='1Min'||input.sample_kind!=='historical')continue;
  const old=inputs.findIndex(x=>x.market===input.market&&x.symbol===input.symbol);
  if(old>=0)inputs[old]={market:input.market,symbol:input.symbol,path};else inputs.push({market:input.market,symbol:input.symbol,path});
}}catch(error){if(error.code!=='ENOENT')throw error;}

const output=[];
for(const entry of inputs){
  const bytes=await readFile(entry.path),snapshot=JSON.parse(bytes.toString());
  const zone=LIBRARY_MARKETS[entry.market].zone;
  const format=new Intl.DateTimeFormat('en-CA',{timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit'});
  const days=[...new Set(snapshot.bars.map(b=>format.format(new Date(b.t))))].sort();
  const split=Math.floor(days.length*.6),devDays=new Set(days.slice(0,split)),holdDays=new Set(days.slice(split));
  const partition=set=>snapshot.bars.filter(b=>set.has(format.format(new Date(b.t))));
  const researchStatus=days.length>=20&&split>=10&&days.length-split>=10?'exploratory_holdout':'insufficient_history_for_validation';
  for(const strategy of [...LIBRARY_STRATEGIES,ADVANCED_MINUTE_STRATEGY]){
    const args={market:entry.market,symbol:entry.symbol,type:strategy.id,budget:entry.market==='US'?2000:100000};
    const summarize=(bars,costMultiplier=1)=>{
      if(new Set(bars.map(b=>format.format(new Date(b.t)))).size<2)return null;
      const r=runMinuteResearch(bars,{...args,costMultiplier});
      return {days:r.days,rows:r.rows,returnPct:100*r.net/r.budget,benchmarkPct:100*r.baselineNet/r.budget,
        maxDrawdownPct:100*r.maxDrawdown,trades:r.orders.length,totalCost:r.totalCost,openQty:r.openQty};
    };
    try{output.push({market:entry.market,symbol:entry.symbol,strategy:strategy.id,
      source:snapshot.source,sha256:createHash('sha256').update(bytes).digest('hex'),
      dataFrom:snapshot.bars[0]?.t,dataTo:snapshot.bars.at(-1)?.t,dayCount:days.length,
      status:researchStatus,full:summarize(snapshot.bars),development:summarize(partition(devDays)),
      holdout:summarize(partition(holdDays)),doubleCosts:summarize(snapshot.bars,2)});
    }catch(error){output.push({market:entry.market,symbol:entry.symbol,strategy:strategy.id,
      status:'backtest_failed',error:String(error)});}
  }
}
const directory=new URL('../../reports/minute_research/',import.meta.url);
await mkdir(directory,{recursive:true});
await writeFile(new URL('comparison.json',directory),JSON.stringify({generatedAt:new Date().toISOString(),results:output},null,2)+'\n');
console.table(output.map(x=>({market:x.market,symbol:x.symbol,strategy:x.strategy,days:x.dayCount,
  fullPct:x.full?.returnPct.toFixed(2),holdoutPct:x.holdout?.returnPct.toFixed(2),
  ddPct:x.full?.maxDrawdownPct.toFixed(2),trades:x.full?.trades,status:x.status})));
console.log('Saved reports/minute_research/comparison.json');
