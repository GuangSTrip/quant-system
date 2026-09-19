import {describeMinuteRule} from '../src/minute-rules.mjs';
import {minuteQuality} from '../src/minute-quality.mjs';
import {readFile,readdir,writeFile} from 'node:fs/promises';
import {runMinuteResearch,LIBRARY_STRATEGIES} from '../src/minute-library.mjs';

const spy=JSON.parse(await readFile(new URL('../demo-data/SPY-1Min-snapshot.json',import.meta.url),'utf8'));
const inputs=[
  {market:'US',symbol:'SPY',bars:spy.bars,source:'Yahoo Finance Chart 公开历史快照',note:'真实短样本；仅 5 个交易日，不足以判断长期表现。',sampleKind:'historical',fetchedAt:spy.fetched_at},
  ...await Promise.all(['HK','CN'].map(async market=>{const s=JSON.parse(await readFile(new URL('../demo-data/'+market+'-1Min-snapshot.json',import.meta.url),'utf8'));return {market,symbol:s.symbol,bars:s.bars,source:s.source,note:'真实短样本；缺失分钟可能来自无成交、停牌或供应商缺口，不填造行情。',sampleKind:s.sample_kind,fetchedAt:s.fetched_at};}))
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
  reports.push({...result,dataQuality:minuteQuality(input.bars,market),strategyName:strategy.name,level:strategy.level,rule:describeMinuteRule(result.config),source:input.source,note:input.note,sampleKind:input.sampleKind,simulationSeed:input.seed??null,dataFetchedAt:input.fetchedAt||null});
}
const output={version:3,reports};
await writeFile(new URL('../src/library-demo.json',import.meta.url),JSON.stringify(output)+'\n');
console.log('Built three-market library demo: '+reports.length+' reports; '+reports.filter(x=>x.sampleKind==='historical').length+' historical, '+reports.filter(x=>x.sampleKind==='synthetic').length+' synthetic.');
