// Research-only minute strategies. This module never submits broker orders.
export const LIBRARY_STRATEGIES=[
  {id:'opening_range',name:'① 开盘区间突破',level:'基础',rule:'观察开盘前 15 根分钟线；收盘价突破区间上沿买入，跌破区间中点退出。'},
  {id:'vwap_reversion',name:'② VWAP 均值回归',level:'进阶',rule:'价格比当日成交量加权均价低 0.15% 买入，回到 VWAP 退出。'},
  {id:'adaptive_momentum',name:'③ 波动率自适应动量',level:'高级',rule:'最近 20 根分钟线涨幅超过其波动阈值、且成交量超过此前均值 1.2 倍时买入；动量转负退出。'}
];
export const LIBRARY_MARKETS={
  US:{name:'美股',zone:'America/New_York',open:570,close:960,tplus:0,lot:1,currency:'USD',costBps:10},
  HK:{name:'港股',zone:'Asia/Hong_Kong',open:570,close:960,tplus:0,lot:100,currency:'HKD',costBps:20},
  CN:{name:'A股普通股票',zone:'Asia/Shanghai',open:570,close:900,tplus:1,lot:100,currency:'CNY',costBps:15}
};
const sessions={US:[[570,960]],HK:[[570,720],[780,960]],CN:[[570,690],[780,900]]};
const formatters=Object.fromEntries(Object.entries(LIBRARY_MARKETS).map(([key,value])=>[key,new Intl.DateTimeFormat('en-US',{timeZone:value.zone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'})]));
function localTime(t,market){const p=Object.fromEntries(formatters[market].formatToParts(new Date(t)).map(x=>[x.type,x.value]));return {day:`${p.year}-${p.month}-${p.day}`,minute:Number(p.hour)*60+Number(p.minute)};}
function average(a){return a.reduce((s,x)=>s+x,0)/a.length;}
function signal(dayBars,index,type){
  const b=dayBars[index];if(index<20)return 0;
  if(type==='opening_range'){
    const open=dayBars.slice(0,15);const high=Math.max(...open.map(x=>x.h)),low=Math.min(...open.map(x=>x.l));
    return b.c>high?1:b.c<(high+low)/2?-1:0;
  }
  if(type==='vwap_reversion'){
    const volume=dayBars.slice(0,index+1).reduce((s,x)=>s+x.v,0);
    if(!volume)return 0;
    const vwap=dayBars.slice(0,index+1).reduce((s,x)=>s+x.c*x.v,0)/volume;
    return b.c<vwap*.9985?1:b.c>=vwap?-1:0;
  }
  const recent=dayBars.slice(index-20,index),returns=recent.slice(1).map((x,i)=>x.c/recent[i].c-1);
  const sigma=Math.sqrt(average(returns.map(x=>x*x))),rise=b.c/recent[0].c-1;
  return rise>Math.max(.0015,sigma*2)&&b.v>average(recent.map(x=>x.v))*1.2?1:rise<0?-1:0;
}
export function runMinuteResearch(raw,{market,type,symbol,budget=100000}={}){
  const spec=LIBRARY_MARKETS[market];if(!spec||!LIBRARY_STRATEGIES.some(x=>x.id===type))throw Error('未知市场或策略');
  if(!Array.isArray(raw))throw Error('分钟行情为空');
  const bars=raw.map(x=>({...x,o:Number(x.o),h:Number(x.h),l:Number(x.l),c:Number(x.c),v:Number(x.v),time:localTime(x.t,market)}))
    .filter(x=>Number.isFinite(Date.parse(x.t))&&[x.o,x.h,x.l,x.c,x.v].every(Number.isFinite)&&x.o>0&&x.h>=Math.max(x.o,x.c)&&x.l<=Math.min(x.o,x.c)&&x.v>=0&&sessions[market].some(([a,z])=>x.time.minute>=a&&x.time.minute<z))
    .sort((a,b)=>a.t.localeCompare(b.t));
  const days=[];for(const b of bars){if(days.at(-1)?.day!==b.time.day)days.push({day:b.time.day,bars:[]});days.at(-1).bars.push(b);}
  if(days.length<2||days.some(d=>d.bars.length<40))throw Error('每个样本日需至少 40 根分钟线，且至少两个交易日');
  let cash=budget,qty=0,boughtDay='',cost=0,baseline=budget,baselineQty=0,baselineCost=0,peak=budget,maxDrawdown=0;
  const fee=spec.costBps/10000,orders=[],curve=[],equityCurve=[];
  function record(bar,save){
    const equity=cash+qty*bar.c,benchmark=baseline+baselineQty*bar.c;
    peak=Math.max(peak,equity);const drawdown=equity/peak-1;maxDrawdown=Math.min(maxDrawdown,drawdown);
    if(save){const point={t:bar.t,equity,benchmark,drawdown,price:bar.c};if(equityCurve.at(-1)?.t===bar.t)equityCurve[equityCurve.length-1]=point;else equityCurve.push(point);}
  }
  function execute(side,price,bar,reason){
    const amount=side==='buy'?Math.floor(cash/(price*(1+fee)*spec.lot))*spec.lot:qty;
    if(amount<=0)return;
    const delta=side==='buy'?amount:-amount,charge=amount*price*fee;
    cash-=delta*price+charge;qty+=delta;cost+=charge;
    if(side==='buy')boughtDay=bar.time.day;
    orders.push({t:bar.t,side,qty:amount,price,cost:charge,reason});
  }
  for(const [dayIndex,day] of days.entries()){
    const first=day.bars[0],last=day.bars.at(-1);
    if(spec.tplus&&qty&&boughtDay!==day.day)execute('sell',first.o,first,'T+1：次日开盘退出昨日仓位');
    // The benchmark obeys the same market-specific settlement rule.
    if(spec.tplus&&baselineQty){baseline+=baselineQty*first.o*(1-fee);baselineCost+=baselineQty*first.o*fee;baselineQty=0;}
    if(!baselineQty){baselineQty=Math.floor(baseline/(first.o*(1+fee)*spec.lot))*spec.lot;baseline-=baselineQty*first.o*(1+fee);baselineCost+=baselineQty*first.o*fee;}
    record(first,true);
    for(let i=1;i<day.bars.length;i++){
      const previous=i-1,decision=signal(day.bars,previous,type),bar=day.bars[i];
      if(!qty&&decision===1)execute('buy',bar.o,bar,LIBRARY_STRATEGIES.find(x=>x.id===type).name+'触发');
      else if(qty&&decision===-1&&(!spec.tplus||boughtDay!==day.day))execute('sell',bar.o,bar,'上一根完整分钟线发出退出信号');
      record(bar,i%5===0||orders.at(-1)?.t===bar.t);
    }
    if(!spec.tplus&&qty)execute('sell',last.c,last,'收盘平仓');
    if(!spec.tplus){baseline+=baselineQty*last.c*(1-fee);baselineCost+=baselineQty*last.c*fee;baselineQty=0;}
    record(last,true);
    curve.push({day:day.day,equity:cash+qty*last.c,baseline:baseline+baselineQty*last.c});
  }
  const last=days.at(-1).bars.at(-1);return {market,symbol,type,currency:spec.currency,budget,days:days.length,rows:bars.length,from:bars[0].t,to:last.t,tplus:spec.tplus,lot:spec.lot,costBps:spec.costBps,net:cash+qty*last.c-budget,baselineNet:baseline+baselineQty*last.c-budget,totalCost:cost,baselineCost,openQty:qty,maxDrawdown,orders,curve,equityCurve};
}
