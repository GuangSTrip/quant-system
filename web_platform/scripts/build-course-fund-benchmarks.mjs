import {readFileSync,writeFileSync} from 'node:fs';

const read=name=>JSON.parse(readFileSync(new URL('../src/'+name,import.meta.url),'utf8'));
const snapshot=read('classroom-snapshot.json'),research=read('modular-daily-results.json'),regional=read('course-regional-fund-inputs.json');
if(snapshot.symbol!=='SPY'||!String(snapshot.adjustment).includes('分红复权'))throw Error('SPY snapshot provenance changed');
const usDates=research.markets.US.dates.filter(date=>date<=snapshot.bars.at(-1).t),byDate=new Map(snapshot.bars.map(bar=>[bar.t,bar]));
if(usDates.length<250||usDates.some(date=>!byDate.has(date)))throw Error('SPY snapshot does not fully cover the selected US interval');
const us={market:'US',symbol:'SPY',name:'SPDR S&P 500 ETF Trust',source:snapshot.source,source_url:snapshot.source_url,
  source_sha256:snapshot.source_sha256,adjustment:snapshot.adjustment,
  bars:usDates.map(date=>{const bar=byDate.get(date);return {t:date,o:bar.o,c:bar.c,turnover:bar.o*bar.v};})};
const inputs={...regional.markets,US:us};
function simulate(market,input){
  const dates=research.markets[market].dates.slice(0,input.bars.length);
  if(input.market!==market||input.bars.length<250||input.bars.some((bar,i)=>bar.t!==dates[i]||![bar.o,bar.c,bar.turnover].every(v=>Number.isFinite(v)&&v>0)))throw Error(market+' fund dates or prices do not match the archived research');
  const initial=1_000_000,fee={CN:.0015,HK:.002,US:.001}[market],first=input.bars[1];
  const requested=initial*.8/(1+fee),capacity=input.bars[0].turnover*.01,notional=Math.min(requested,capacity);
  const units=notional/first.o,cost=notional*fee,cash=initial-notional-cost;
  const raw=dates.map((_,i)=>i===0?1:(cash+units*input.bars[i].c)/initial);
  let peak=1,drawdown=0;for(const value of raw){peak=Math.max(peak,value);drawdown=Math.min(drawdown,value/peak-1);}
  const years=(Date.parse(dates.at(-1))-Date.parse(dates[0]))/(365.25*86400000);
  const full={from:dates[0],to:dates.at(-1),sessions:dates.length,total_return_pct:(raw.at(-1)-1)*100,
    cagr_pct:(raw.at(-1)**(1/years)-1)*100,max_drawdown_pct:drawdown*100};
  const {bars,...source}=input;
  return {...source,fee_bps:fee*10_000,initial_capital:initial,initial_target_pct:80,
    initial_liquidity_cap_pct:1,initial_filled_pct:notional/initial*100,
    note:'Buy once at the second research-date open, aim for 80% ETF with a 1% previous-day turnover cap, retain remaining cash without interest; adjusted prices and a proportional purchase fee. No rebalance or final sale.',
    dates,equity:raw.map(value=>Number(value.toFixed(6))),full,cost:Number(cost.toFixed(2)),trade_count:1};
}
const result={markets:Object.fromEntries(Object.entries(inputs).map(([market,input])=>[market,simulate(market,input)]))};
writeFileSync(new URL('../src/course-fund-benchmarks.json',import.meta.url),JSON.stringify(result));
for(const [market,item] of Object.entries(result.markets))console.log(market,item.symbol,item.dates[0],item.dates.at(-1),item.dates.length,'sessions');
