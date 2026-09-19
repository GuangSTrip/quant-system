import {readFile,readdir,writeFile} from 'node:fs/promises';
import {runMinuteResearch,LIBRARY_STRATEGIES} from '../src/minute-library.mjs';

const spy=JSON.parse(await readFile(new URL('../demo-data/SPY-1Min-snapshot.json',import.meta.url),'utf8'));
const dates=['2026-09-09','2026-09-10','2026-09-11','2026-09-14','2026-09-15'];
function fixture(market){
  const hk=market==='HK',symbol=hk?'0700.HK':'600000.SH',base=hk?600:10,seed=hk?4107:6129,minutes=[];
  let state=seed;const random=()=>{state=(Math.imul(state,1664525)+1013904223)>>>0;return state/4294967296;};
  for(const day of dates)for(const [from,to] of hk?[[570,720],[780,960]]:[[570,690],[780,900]])for(let m=from;m<to;m++)minutes.push({day,m});
  let price=base;
  const bars=minutes.map(({day,m},i)=>{
    const minute=m%60,hour=Math.floor(m/60),date=day+'T'+String(hour).padStart(2,'0')+':'+String(minute).padStart(2,'0')+':00+08:00';
    const previous=price,dayIndex=dates.indexOf(day),shock=(random()+random()+random()+random()-2)*(hk?.0009:.0012);
    const drift=[.00008,-.00009,.00004,-.00005,.00007][dayIndex]+(m<615?.00006:0);
    price=Math.max(base*.5,previous*(1+drift+shock));
    const spread=previous*(.0001+random()*.00015),volume=Math.round((hk?12000:40000)*(0.7+random()*1.2+Math.abs(shock)*150));
    return {t:new Date(date).toISOString(),o:previous,h:Math.max(previous,price)+spread,l:Math.min(previous,price)-spread,c:price,v:volume};
  });
  return {symbol,bars,source:'固定种子伪随机合成样本（seed '+seed+'）',note:'随机路径用于验证策略与市场规则；不是历史行情，收益不能用于评价策略。',seed};
}
const inputs=[
  {market:'US',symbol:'SPY',bars:spy.bars,source:'Yahoo Finance Chart 公开历史快照',note:'真实短样本；仅 5 个交易日，不足以判断长期表现。',sampleKind:'historical',fetchedAt:spy.fetched_at},
  {...fixture('HK'),market:'HK',sampleKind:'synthetic'},
  {...fixture('CN'),market:'CN',sampleKind:'synthetic'}
];
// Optional local snapshots are excluded from Git so licensed data and API credentials stay local.
const folder=new URL('../demo-data/library-inputs/',import.meta.url);
let filenames=[];try{filenames=(await readdir(folder)).filter(x=>x.endsWith('.json')).sort();}catch(error){if(error.code!=='ENOENT')throw error;}
for(const filename of filenames){
  const snapshot=JSON.parse(await readFile(new URL(filename,folder),'utf8'));
  const market=String(snapshot.market||''),symbol=String(snapshot.symbol||'').toUpperCase();
  if(!['US','HK','CN'].includes(market)||snapshot.timeframe!=='1Min'||snapshot.sample_kind!=='historical'||!Array.isArray(snapshot.bars)||!String(snapshot.source||'').trim())throw Error(filename+': expected market, symbol, timeframe=1Min, sample_kind=historical, source and bars');
  if(!(market==='US'&&/^[A-Z.]{1,10}$/.test(symbol)||market==='HK'&&/^\d{4,5}\.HK$/.test(symbol)||market==='CN'&&/^\d{6}\.(SH|SZ)$/.test(symbol)))throw Error(filename+': invalid symbol for market');
  const input={market,symbol,bars:snapshot.bars,source:String(snapshot.source).trim(),note:'导入的真实分钟快照；请核对覆盖时段、复权口径和数据授权。',sampleKind:'historical',fetchedAt:snapshot.fetched_at||null};
  const old=inputs.findIndex(x=>x.market===market&&x.symbol===symbol);
  if(old>=0)inputs[old]=input;else inputs.push(input);
}
const reports=[];
for(const input of inputs)for(const strategy of LIBRARY_STRATEGIES){
  const {market}=input;
  const result=runMinuteResearch(input.bars,{market,symbol:input.symbol,type:strategy.id,budget:market==='US'?2000:100000});
  reports.push({...result,strategyName:strategy.name,level:strategy.level,rule:strategy.rule,source:input.source,note:input.note,sampleKind:input.sampleKind,simulationSeed:input.seed??null,dataFetchedAt:input.fetchedAt||null});
}
const output={version:3,reports};
await writeFile(new URL('../src/library-demo.json',import.meta.url),JSON.stringify(output)+'\n');
console.log('Built three-market library demo: '+reports.length+' reports; '+reports.filter(x=>x.sampleKind==='historical').length+' historical, '+reports.filter(x=>x.sampleKind==='synthetic').length+' synthetic.');
