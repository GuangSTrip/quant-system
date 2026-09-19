// Research-only minute strategies. This module never submits broker orders.
export const LIBRARY_STRATEGIES=[
  {id:'opening_range',name:'① 开盘区间突破',level:'基础',rule:'观察开盘前 15 根分钟线；收盘价突破区间上沿买入，跌破区间中点退出。'},
  {id:'vwap_reversion',name:'② VWAP 均值回归',level:'进阶',rule:'价格比当日成交量加权均价低 0.15% 买入，回到 VWAP 退出。'},
  {id:'adaptive_momentum',name:'③ 波动率自适应动量',level:'高级',rule:'最近 20 根分钟线涨幅超过其波动阈值、且成交量超过此前均值 1.2 倍时买入；动量转负退出。'}
];
// Experimental candidate. Kept out of the default three-strategy teaching library.
export const ADVANCED_MINUTE_STRATEGY={id:'volume_vwap_breakout',name:'成交量与 VWAP 确认的开盘突破',rule:'开盘 15 分钟区间上沿突破，同时价格高于当日 VWAP、上一分钟量高于前 20 分钟均量 1.2 倍；跌回区间中点或 VWAP 退出。'};
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
  if(type===ADVANCED_MINUTE_STRATEGY.id){
    const opening=dayBars.slice(0,15),recent=dayBars.slice(index-20,index);
    const high=Math.max(...opening.map(x=>x.h)),low=Math.min(...opening.map(x=>x.l));
    const history=dayBars.slice(0,index+1),volume=history.reduce((sum,x)=>sum+x.v,0);
    if(!volume)return 0;
    const vwap=history.reduce((sum,x)=>sum+x.c*x.v,0)/volume;
    if(b.c<(high+low)/2||b.c<vwap)return -1;
    return b.c>high&&b.c>vwap&&b.v>average(recent.map(x=>x.v))*1.2?1:0;
  }
  const recent=dayBars.slice(index-20,index),returns=recent.slice(1).map((x,i)=>x.c/recent[i].c-1);
  const sigma=Math.sqrt(average(returns.map(x=>x*x))),rise=b.c/recent[0].c-1;
  return rise>Math.max(.0015,sigma*2)&&b.v>average(recent.map(x=>x.v))*1.2?1:rise<0?-1:0;
}
function evidence(bars,i,type){
  if(i<20)return `已有 ${i+1} 根分钟线`;
  const b=bars[i],f=n=>n.toFixed(3);
  if(type==='opening_range'){const first=bars.slice(0,15),high=Math.max(...first.map(b=>b.h)),low=Math.min(...first.map(b=>b.l));return `收盘 ${f(b.c)} / 区间上沿 ${f(high)} / 中点 ${f((high+low)/2)}`;}
  if(type==='vwap_reversion'){const history=bars.slice(0,i+1),v=history.reduce((a,b)=>a+b.v,0),vwap=v?history.reduce((a,b)=>a+b.c*b.v,0)/v:0;return `收盘 ${f(b.c)} / VWAP ${f(vwap)} / 买入线 ${f(vwap*.9985)}`;}
  const recent=bars.slice(i-20,i),r=recent.slice(1).map((x,j)=>x.c/recent[j].c-1),sigma=Math.sqrt(average(r.map(x=>x*x))),rise=b.c/recent[0].c-1;
  return `20 分钟涨幅 ${f(rise*100)}% / 波动阈值 ${f(Math.max(.0015,sigma*2)*100)}% / 本分钟量 ${b.v} / 量门槛 ${f(average(recent.map(x=>x.v))*1.2)}`;
}
export function runMinuteResearch(raw,{market,type,symbol,budget=100000,costMultiplier=1}={}){
  const spec=LIBRARY_MARKETS[market];if(!spec||![...LIBRARY_STRATEGIES,ADVANCED_MINUTE_STRATEGY].some(x=>x.id===type))throw Error('未知市场或策略');
  if(!Number.isFinite(costMultiplier)||costMultiplier<0)throw Error('成本倍数必须为非负有限数');
  if(!Array.isArray(raw))throw Error('分钟行情为空');
  const bars=raw.map(x=>({...x,o:Number(x.o),h:Number(x.h),l:Number(x.l),c:Number(x.c),v:Number(x.v),time:localTime(x.t,market)}))
    .filter(x=>Number.isFinite(Date.parse(x.t))&&[x.o,x.h,x.l,x.c,x.v].every(Number.isFinite)&&x.o>0&&x.h>=Math.max(x.o,x.c)&&x.l<=Math.min(x.o,x.c)&&x.v>=0&&sessions[market].some(([a,z])=>x.time.minute>=a&&x.time.minute<z))
    .sort((a,b)=>a.t.localeCompare(b.t));
  const days=[];for(const b of bars){if(days.at(-1)?.day!==b.time.day)days.push({day:b.time.day,bars:[]});days.at(-1).bars.push(b);}
  if(days.length<2||days.some(d=>d.bars.length<40))throw Error('每个样本日需至少 40 根分钟线，且至少两个交易日');
  let cash=budget,qty=0,boughtDay='',cost=0,baseline=budget,baselineQty=0,baselineCost=0,peak=budget,maxDrawdown=0;
  const fee=spec.costBps*costMultiplier/10000,orders=[],curve=[],equityCurve=[],decisions=[];
  function record(bar,save,decision=null){
    const equity=cash+qty*bar.c,benchmark=baseline+baselineQty*bar.c;
    peak=Math.max(peak,equity);const drawdown=equity/peak-1;maxDrawdown=Math.min(maxDrawdown,drawdown);
    if(decision){decisions.push({t:bar.t,price:bar.c,cash,qty,signal:decision.signal,reason:decision.reason});}
    if(save){const point={t:bar.t,equity,benchmark,drawdown,price:bar.c};if(equityCurve.at(-1)?.t===bar.t)equityCurve[equityCurve.length-1]=point;else equityCurve.push(point);}
  }
  function execute(side,price,bar,reason,signalTime=null){
    const amount=side==='buy'?Math.floor(cash/(price*(1+fee)*spec.lot))*spec.lot:qty;
    if(amount<=0)return;
    const delta=side==='buy'?amount:-amount,charge=amount*price*fee;
    cash-=delta*price+charge;qty+=delta;cost+=charge;
    if(side==='buy')boughtDay=bar.time.day;
    orders.push({t:bar.t,signal_t:signalTime,side,qty:amount,price,cost:charge,reason});
  }
  for(const [dayIndex,day] of days.entries()){
    const first=day.bars[0],last=day.bars.at(-1);
    if(spec.tplus&&qty&&boughtDay!==day.day)execute('sell',first.o,first,'T+1：次日开盘退出昨日仓位');
    // The benchmark obeys the same market-specific settlement rule.
    if(spec.tplus&&baselineQty){baseline+=baselineQty*first.o*(1-fee);baselineCost+=baselineQty*first.o*fee;baselineQty=0;}
    if(!baselineQty){baselineQty=Math.floor(baseline/(first.o*(1+fee)*spec.lot))*spec.lot;baseline-=baselineQty*first.o*(1+fee);baselineCost+=baselineQty*first.o*fee;}
    record(first,true,{signal:0,reason:'新交易日；等待 20 根分钟线预热'+(spec.tplus?'；昨日持仓在今日开盘退出':'')});
    for(let i=1;i<day.bars.length;i++){
      const previous=i-1,decision=signal(day.bars,previous,type),bar=day.bars[i];
      if(!qty&&decision===1&&(spec.tplus||i<day.bars.length-1))execute('buy',bar.o,bar,([...LIBRARY_STRATEGIES,ADVANCED_MINUTE_STRATEGY].find(x=>x.id===type)).name+'触发',day.bars[previous].t);
      else if(qty&&decision===-1&&(!spec.tplus||boughtDay!==day.day))execute('sell',bar.o,bar,'上一根完整分钟线发出退出信号',day.bars[previous].t);
      if(!spec.tplus&&i===day.bars.length-1){
        if(qty)execute('sell',bar.o,bar,'末根分钟线开盘强制平仓');
        baseline+=baselineQty*bar.o*(1-fee);baselineCost+=baselineQty*bar.o*fee;baselineQty=0;
      }
      const next=signal(day.bars,i,type),why=i<20?'等待 20 根分钟线预热':next===1?'满足入场条件':next===-1?'满足退出条件':'未触发买卖条件，维持仓位';
      record(bar,true,{signal:next,reason:why+'；'+evidence(day.bars,i,type)+(spec.tplus&&qty&&boughtDay===day.day?'；T+1 当日持仓不可卖出':'')+(!spec.tplus&&i===day.bars.length-1?'；末根开盘已强制平仓':'')});
    }
    // The final minute's close is unknown before that bar completes; forced
    // liquidation above occurs at its open before equity is marked.
    record(last,true);
    curve.push({day:day.day,equity:cash+qty*last.c,baseline:baseline+baselineQty*last.c});
  }
  const last=days.at(-1).bars.at(-1);return {market,symbol,type,currency:spec.currency,budget,days:days.length,rows:bars.length,from:bars[0].t,to:last.t,tplus:spec.tplus,lot:spec.lot,costBps:spec.costBps*costMultiplier,net:cash+qty*last.c-budget,baselineNet:baseline+baselineQty*last.c-budget,totalCost:cost,baselineCost,openQty:qty,maxDrawdown,orders,curve,equityCurve,decisions};
}
