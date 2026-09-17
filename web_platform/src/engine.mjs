export const ENGINE_VERSION = 'course-intraday-1.2.0';
export const SYMBOLS = ['SPY','QQQ','IWM','EFA','EEM','TLT','IEF','GLD','DBC','SHY','AAPL','MSFT'];
export const INTRADAY_TYPES = ['opening_range_breakout','vwap_reversion'];
export const INTRADAY_SYMBOLS = ['SPY','QQQ','AAPL','MSFT'];
export const isIntraday = type => INTRADAY_TYPES.includes(type);
export class AppError extends Error {
  constructor(message,status=400,code='INVALID_REQUEST'){super(message);this.status=status;this.code=code;}
}
export function requireValue(condition,message,status=400,code='INVALID_REQUEST'){if(!condition)throw new AppError(message,status,code);}
export const nowISO=()=>new Date().toISOString();
export async function digest(value){return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(typeof value==='string'?value:JSON.stringify(value))))).map(x=>x.toString(16).padStart(2,'0')).join('');}
export function numeric(value,name,min,max){const n=Number(value);requireValue(value!==null&&value!==''&&Number.isFinite(n)&&n>=min&&n<=max,name+' 超出允许范围');return n;}
export function symbol(value){const v=String(value||'').toUpperCase();requireValue(SYMBOLS.includes(v),'请选择课程允许的股票或 ETF');return v;}
export function strategyConfig(input={}){
  if(isIntraday(input.type)){
    const c={name:String(input.name||'分钟策略').trim().slice(0,60),symbol:symbol(input.symbol),type:String(input.type),days:numeric(input.days??5,'历史天数',2,30),budget:numeric(input.budget??1000,'策略预算',100,100000),opening_minutes:numeric(input.opening_minutes??15,'开盘观察分钟',5,60),threshold_bps:numeric(input.threshold_bps??20,'触发阈值基点',0,200),cost_bps:numeric(input.cost_bps??10,'单边成本基点',0,100)};
    requireValue(INTRADAY_SYMBOLS.includes(c.symbol),'分钟策略仅允许 SPY、QQQ、AAPL、MSFT；请先固定可交易范围');
    requireValue(Number.isInteger(c.days)&&Number.isInteger(c.budget)&&Number.isInteger(c.opening_minutes),'天数、预算和开盘观察分钟须为整数');return c;
  }
  const c={name:String(input.name||'课程策略').trim().slice(0,60),symbol:symbol(input.symbol),type:String(input.type||'sma'),fast:numeric(input.fast??10,'快周期',2,100),slow:numeric(input.slow??30,'慢周期',5,200),allocation:numeric(input.allocation??0.1,'目标仓位',0.01,0.5),days:numeric(input.days??365,'历史天数',90,1095),cost_bps:numeric(input.cost_bps??10,'单边成本基点',0,100)};
  requireValue(['sma','momentum','buy_hold'].includes(c.type),'未知策略模板');
  requireValue(Number.isInteger(c.fast)&&Number.isInteger(c.slow)&&Number.isInteger(c.days)&&c.fast<c.slow,'周期必须为整数且快周期小于慢周期');
  return c;
}
export function validateBars(raw){
  requireValue(Array.isArray(raw)&&raw.length>0,'历史行情为空',422,'DATA_EMPTY');
  let previous='';
  return raw.map(r=>{requireValue(typeof r.t==='string'&&Number.isFinite(Date.parse(r.t))&&r.t>previous,'行情重复或时间乱序',422,'DATA_QUALITY');previous=r.t;
    for(const k of ['o','h','l','c'])requireValue(Number.isFinite(Number(r[k]))&&Number(r[k])>0,'行情价格无效',422,'DATA_QUALITY');
    requireValue(r.h>=Math.max(r.o,r.c)&&r.l<=Math.min(r.o,r.c)&&r.h>=r.l&&Number(r.v)>=0,'OHLCV 数据不一致',422,'DATA_QUALITY');
    return {t:r.t,o:Number(r.o),h:Number(r.h),l:Number(r.l),c:Number(r.c),v:Number(r.v)};
  });
}
export function signalAt(bars,i,c){
  if(c.type==='buy_hold')return 1;
  if(i<c.slow-1)return 0;
  if(c.type==='momentum')return bars[i].c>bars[i-c.slow+1].c?1:0;
  const avg=n=>bars.slice(i-n+1,i+1).reduce((s,b)=>s+b.c,0)/n;
  return avg(c.fast)>avg(c.slow)?1:0;
}
const nyParts=new Intl.DateTimeFormat('en-US',{timeZone:'America/New_York',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'});
const minuteCache=new Map();
export function marketMinute(timestamp){
  if(minuteCache.has(timestamp))return minuteCache.get(timestamp);
  const p=Object.fromEntries(nyParts.formatToParts(new Date(timestamp)).map(x=>[x.type,x.value]));
  const value={day:`${p.year}-${p.month}-${p.day}`,minute:Number(p.hour)*60+Number(p.minute)};
  if(minuteCache.size>10000)minuteCache.clear();minuteCache.set(timestamp,value);return value;
}
export function intradayDecision(bars,i,c){
  const current=marketMinute(bars[i].t),session=[];
  for(let j=i;j>=0;j--){const p=marketMinute(bars[j].t);if(p.day!==current.day)break;if(p.minute>=570&&p.minute<960)session.push(bars[j]);}
  session.reverse();
  if(current.minute<570||current.minute>=960)return {signal:0,reason:'常规交易时段外',value:null};
  if(current.minute>=945)return {signal:0,reason:'15:45 后日内平仓',value:null};
  if(current.minute<570+c.opening_minutes||session.length<3)return {signal:0,reason:'等待开盘观察区间',value:null};
  if(c.type==='opening_range_breakout'){
    const range=session.filter(b=>marketMinute(b.t).minute<570+c.opening_minutes);
    if(range.length<3)return {signal:0,reason:'开盘区间有效分钟线不足',value:null};
    const high=Math.max(...range.map(b=>b.h)),mid=(high+Math.min(...range.map(b=>b.l)))/2;
    const signal=bars[i].c>high*(1+c.threshold_bps/10000)?1:bars[i].c<mid?0:null;
    return {signal,reason:signal===1?'收盘价突破开盘区间上沿':signal===0?'收盘价跌破开盘区间中点':'保持当前仓位',value:high};
  }
  const volume=session.reduce((s,b)=>s+b.v,0);
  if(volume<=0)return {signal:0,reason:'成交量不足',value:null};
  const vwap=session.reduce((s,b)=>s+((b.h+b.l+b.c)/3)*b.v,0)/volume;
  const signal=bars[i].c<=vwap*(1-c.threshold_bps/10000)?1:bars[i].c>=vwap?0:null;
  return {signal,reason:signal===1?'收盘价低于当日 VWAP 触发线':signal===0?'收盘价回到 VWAP':'保持当前仓位',value:vwap};
}
function backtestIntraday(raw,c){
  const bars=validateBars(raw).filter(b=>{const m=marketMinute(b.t).minute;return m>=570&&m<960;});
  requireValue(bars.length>=60&&new Set(bars.map(b=>marketMinute(b.t).day)).size>=2,'分钟行情不足：需要至少两个交易日、60 根常规时段分钟线',422,'INSUFFICIENT_DATA');
  let cash=100000,qty=0,peak=cash,costTotal=0,turnover=0,benchCash=100000,benchQty=0,benchCost=0;
  const curve=[],trades=[],daily=[],fee=c.cost_bps/10000;
  const execute=(delta,price,time,signalTime)=>{if(!delta)return;const gross=Math.abs(delta)*price,cost=gross*fee;cash-=delta*price+cost;qty+=delta;costTotal+=cost;turnover+=gross;trades.push({t:time,signal_t:signalTime,side:delta>0?'buy':'sell',qty:Math.abs(delta),price,cost});};
  for(let i=0;i<bars.length;i++){
    const b=bars[i],day=marketMinute(b.t).day,prev=i?marketMinute(bars[i-1].t).day:null;
    if(day!==prev){benchQty=Math.floor(c.budget/(b.o*(1+fee)));const cost=benchQty*b.o*fee;benchCash-=benchQty*b.o+cost;benchCost+=cost;}
    if(i&&day===prev){const decision=intradayDecision(bars,i-1,c),signal=decision.signal;
      if(signal!==null){const target=signal?Math.min(Math.floor(c.budget/b.o),Math.floor(cash/(b.o*(1+fee)))+qty):0;execute(target-qty,b.o,b.t,bars[i-1].t);}
    }
    const endDay=i===bars.length-1||marketMinute(bars[i+1].t).day!==day;
    if(endDay){execute(-qty,b.c,b.t,b.t);const cost=benchQty*b.c*fee;benchCash+=benchQty*b.c-cost;benchCost+=cost;benchQty=0;daily.push(cash/100000);}
    const equity=cash+qty*b.c;peak=Math.max(peak,equity);curve.push({t:b.t,equity,drawdown:equity/peak-1,benchmark:benchCash+benchQty*b.c});
  }
  const returns=daily.map((e,i)=>e/(i?daily[i-1]:1)-1),n=returns.length,mean=returns.reduce((s,x)=>s+x,0)/n,sd=Math.sqrt(returns.reduce((s,x)=>s+(x-mean)**2,0)/Math.max(n-1,1));
  const sorted=[...returns].sort((a,b)=>a-b),var95=sorted[Math.floor(n*.05)],tail=sorted.filter(x=>x<=var95),elapsed=(Date.parse(bars.at(-1).t)-Date.parse(bars[0].t))/86400000;
  const decision=intradayDecision(bars,bars.length-1,c);
  return {engine:ENGINE_VERSION,config:c,signal:decision.signal??0,signal_reason:decision.reason,signal_value:decision.value,signal_timestamp:bars.at(-1).t,metrics:{total_return:cash/100000-1,benchmark_return:benchCash/100000-1,benchmark_cost:benchCost,cagr:elapsed>0?(cash/100000)**(365.25/elapsed)-1:0,sharpe:sd?mean/sd*Math.sqrt(252):0,max_drawdown:Math.min(...curve.map(x=>x.drawdown)),volatility:sd*Math.sqrt(252),var95,cvar95:tail.reduce((s,x)=>s+x,0)/tail.length,turnover:turnover/100000,total_cost:costTotal,trade_count:trades.length},curve,trades,quality:{rows:bars.length,from:bars[0].t,to:bars.at(-1).t,duplicates:0,invalid:0},limitations:['分钟历史行情、只做多；收盘前平仓，未模拟股息、税费、冲击和部分成交。','前一根完整分钟线产生信号，下一根开盘价模拟成交；数据中每日最后一根按收盘价强制平仓。','蓝线是同预算、首根开盘买入和末根收盘卖出的日内基准，按同样单边成本计算；它不是跨夜持有。','100,000 美元初始账户中仅使用策略预算。样本少时年化指标仅供演示。']};
}
export function backtest(raw,input){
  const c=strategyConfig(input);if(isIntraday(c.type))return backtestIntraday(raw,c);
  const bars=validateBars(raw),warmup=c.type==='buy_hold'?1:c.slow;
  requireValue(bars.length>warmup+20,'历史数据不足：需要慢周期之外至少 20 根完整日线',422,'INSUFFICIENT_DATA');
  let cash=100000,qty=0,peak=cash,priorEquity=cash,priorSignal=0,totalCost=0,turnover=0;
  const curve=[],trades=[],returns=[]; const fee=c.cost_bps/10000;
  for(let i=warmup;i<bars.length;i++){
    const b=bars[i],signal=signalAt(bars,i-1,c);
    if(signal!==priorSignal){
      const equity=cash+qty*b.o;
      let target=signal?Math.floor(equity*c.allocation/b.o):0;
      if(target>qty)target=Math.min(target,qty+Math.floor(cash/(b.o*(1+fee))));
      const delta=target-qty;
      if(delta){const gross=Math.abs(delta)*b.o,cost=gross*fee;cash-=delta*b.o+cost;qty=target;totalCost+=cost;turnover+=gross;trades.push({t:b.t,signal_t:bars[i-1].t,side:delta>0?'buy':'sell',qty:Math.abs(delta),price:b.o,cost});}
      priorSignal=signal;
    }
    const equity=cash+qty*b.c;peak=Math.max(peak,equity);returns.push(equity/priorEquity-1);priorEquity=equity;
    curve.push({t:b.t,equity,drawdown:equity/peak-1,benchmark:100000*(1-c.allocation+c.allocation*b.c/bars[warmup].o)});
  }
  const n=returns.length,mean=returns.reduce((s,x)=>s+x,0)/n,sd=Math.sqrt(returns.reduce((s,x)=>s+(x-mean)**2,0)/Math.max(n-1,1));
  const sorted=[...returns].sort((a,b)=>a-b),var95=sorted[Math.floor(n*.05)],tail=sorted.filter(x=>x<=var95);
  const last=curve.at(-1),elapsed=(Date.parse(last.t)-Date.parse(curve[0].t))/86400000;
  return {engine:ENGINE_VERSION,config:c,signal:signalAt(bars,bars.length-1,c),signal_timestamp:bars.at(-1).t,metrics:{total_return:last.equity/100000-1,cagr:elapsed>0?(last.equity/100000)**(365.25/elapsed)-1:0,sharpe:sd?mean/sd*Math.sqrt(252):0,max_drawdown:Math.min(...curve.map(x=>x.drawdown)),volatility:sd*Math.sqrt(252),var95,cvar95:tail.reduce((s,x)=>s+x,0)/tail.length,turnover:turnover/100000,total_cost:totalCost,trade_count:trades.length},curve,trades,quality:{rows:bars.length,from:bars[0].t,to:bars.at(-1).t,duplicates:0,invalid:0},limitations:['单标的日频、只做多；不模拟股息、税费、市场冲击与部分成交。','信号只读取前一根完整日线，下一根开盘成交；市场休市、停牌和跳空由输入数据决定。','IEX 单交易所行情与券商实际撮合行情可能不同；成本为可配置的单边比例成本。']};
}
export function normalizeOrder(input){
  const o={symbol:symbol(input.symbol),side:String(input.side),type:String(input.type),qty:String(numeric(input.qty,'股数',1,10000)),time_in_force:String(input.time_in_force||'day')};
  requireValue(Number.isInteger(Number(o.qty)),'课程版订单使用整数股');
  requireValue(['buy','sell'].includes(o.side),'方向无效');
  requireValue(['market','limit','stop','stop_limit'].includes(o.type),'订单类型无效');
  requireValue(['day','gtc'].includes(o.time_in_force),'有效期无效');
  if(o.type.includes('limit'))o.limit_price=numeric(input.limit_price,'限价',0.01,100000).toFixed(2);
  if(o.type.startsWith('stop'))o.stop_price=numeric(input.stop_price,'止损触发价',0.01,100000).toFixed(2);
  if(o.type==='stop_limit')requireValue(o.side==='buy'?Number(o.limit_price)>=Number(o.stop_price):Number(o.limit_price)<=Number(o.stop_price),'止损限价需覆盖触发价：买单限价不低于触发价，卖单反之');
  return o;
}
export function riskCheck(o,{account,clock,positions,openOrders,quote,control,dailyNotional}){
  requireValue(!control.halted,'服务器已暂停新增订单，请先对账并恢复',409,'HALTED');
  requireValue(account.status==='ACTIVE'&&!account.trading_blocked&&!account.account_blocked,'Alpaca 账户不可交易',409,'ACCOUNT_BLOCKED');
  const equity=Number(account.equity),cash=Number(account.cash),last=Number(account.last_equity);
  requireValue(equity>0&&Number.isFinite(cash),'账户资金数据无效',503,'ACCOUNT_INVALID');
  requireValue(!(last>0&&(last-equity)/last>=control.max_loss),'已触发当日亏损限额',409,'DAILY_LOSS');
  const age=(Date.parse(clock.timestamp)-Date.parse(quote.t))/1000;
  const ask=Number(quote.ap),bid=Number(quote.bp);
  const live=ask>0&&bid>0&&ask>=bid&&age>=-5&&age<=120;
  if(o.type==='market'||o.type.startsWith('stop'))requireValue(clock.is_open&&live,'市价／止损单需正常开市且报价在 120 秒内；休市可使用限价单排队',409,'STALE_QUOTE');
  if(o.type==='limit'&&clock.is_open)requireValue(live,'报价已过期，开市时暂不接收新订单',409,'STALE_QUOTE');
  const referenceAge=(Date.parse(clock.timestamp)-Date.parse(quote.reference_at))/1000;
  requireValue(live||(referenceAge>=-5&&referenceAge<=7*86400),'最近参考价格超过 7 天或时间无效',409,'STALE_QUOTE');
  const reference=live?(ask+bid)/2:Number(quote.reference);
  requireValue(Number.isFinite(reference)&&reference>0,'缺少可用参考价格',503,'PRICE_MISSING');
  const price=o.type==='market'?reference*1.02:Math.max(Number(o.limit_price||o.stop_price),reference);
  const notional=price*Number(o.qty),position=positions.find(p=>p.symbol===o.symbol);
  requireValue(notional<=control.max_order,'超过单笔名义金额限额',409,'ORDER_LIMIT');
  requireValue(dailyNotional+notional<=control.max_daily,'超过当日累计提交金额限额',409,'DAILY_LIMIT');
  function remaining(x){const q=Number(x.qty),f=Number(x.filled_qty);requireValue(x.qty!==null&&q>0&&Number.isFinite(q)&&Number.isFinite(f)&&f>=0&&f<=q,'券商未完成订单的数量不完整，请先处理并对账',409,'OPEN_ORDER_UNPRICED');return q-f;}
  function reserved(x){const q=remaining(x),p=Number(x.limit_price||x.stop_price||(x.symbol===o.symbol?price:0));requireValue(p>0&&Number.isFinite(p),'其他标的存在无法估值的未完成买单，请先处理并对账',409,'OPEN_ORDER_UNPRICED');return q*p*(x.limit_price?1:1.02);}
  const same=openOrders.filter(x=>x.symbol===o.symbol),reservedSell=same.filter(x=>x.side==='sell').reduce((s,x)=>s+remaining(x),0);
  if(o.side==='sell')requireValue(Number(o.qty)<=Math.max(0,Number(position?.qty||0)-reservedSell),'可卖股数不足，或已被未完成卖单占用；课程版不做空',409,'POSITION_LIMIT');
  else {
    const reservedBuy=openOrders.filter(x=>x.side==='buy').reduce((s,x)=>s+reserved(x),0);
    requireValue(notional+reservedBuy<=Math.min(cash,Number(account.buying_power)),'现金不足或已有未完成买单占用资金；课程版不使用融资',409,'CASH_LIMIT');
    const sameBuy=same.filter(x=>x.side==='buy').reduce((s,x)=>s+reserved(x),0);
    requireValue(Math.max(0,Number(position?.market_value||0))+sameBuy+notional<=equity*control.max_position,'超过单标的集中度限额',409,'CONCENTRATION_LIMIT');
  }
  return {notional,reference,quote_age_seconds:age,queued:!clock.is_open,checks:['账户有效','服务器运行','每日亏损','金额限额','现金／持仓','集中度','行情时效']};
}
