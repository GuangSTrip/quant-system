import {mkdir,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const url='https://query1.finance.yahoo.com/v8/finance/chart/SPY?interval=1m&range=5d&includePrePost=false';
const response=await fetch(url,{headers:{'User-Agent':'quant-system-course-demo/1.0'},signal:AbortSignal.timeout(30000)});
if(!response.ok)throw Error(`Historical data request failed: ${response.status}`);
const json=await response.json(),series=json.chart?.result?.[0],quote=series?.indicators?.quote?.[0];
if(!series||!quote)throw Error('Historical data response has no minute bars');
const bars=series.timestamp.map((seconds,i)=>({t:new Date(seconds*1000).toISOString(),o:quote.open[i],h:quote.high[i],l:quote.low[i],c:quote.close[i],v:quote.volume[i]})).filter(b=>[b.o,b.h,b.l,b.c,b.v].every(Number.isFinite));
if(bars.length<100)throw Error('Historical data response is too short');
const folder=resolve(fileURLToPath(new URL('..',import.meta.url)),'demo-data');await mkdir(folder,{recursive:true});
const path=resolve(folder,'SPY-1Min-snapshot.json');
await writeFile(path,JSON.stringify({source:'Yahoo Finance Chart',source_url:url,fetched_at:new Date().toISOString(),symbol:'SPY',timeframe:'1Min',bars},null,2)+'\n');
console.log(JSON.stringify({path,rows:bars.length,from:bars[0].t,to:bars.at(-1).t}));
