// Intraday enhanced-reversion kernel: a faithful JS port of the Python
// quant_system/intraday.py decide() so research (backtest) and the automation
// tick share one rule set. Entry: price below session VWAP by threshold_bps
// with a free-fall guard, at most max_entries_per_day times, after the opening
// window. Exits: close back above VWAP, a time stop in bars, or the final
// 15-minute window. Always flat by close; long only.
import {marketMinute,validateBars,ENGINE_VERSION} from './engine.mjs';

export const SESSION_OPEN=570,SESSION_CLOSE=960;
export const ENHANCED_DEFAULTS={threshold_bps:60,time_stop_bars:60,entry_start_minute:600,max_entries_per_day:1,guard_sigma:1.5,lookback:20};

export function enhancedSession(bars,index){
  // Bars of the same Eastern regular session up to `index` (inclusive), chronological.
  const current=marketMinute(bars[index].t),session=[];
  for(let j=index;j>=0;j--){const m=marketMinute(bars[j].t);if(m.day!==current.day)break;if(m.minute>=SESSION_OPEN&&m.minute<SESSION_CLOSE)session.push(bars[j]);}
  return session.reverse();
}
function vwapUpto(session,upto){
  let volume=0,tpv=0;
  for(let i=0;i<upto;i++){const b=session[i];volume+=b.v;tpv+=(b.h+b.l+b.c)/3*b.v;}
  return volume>0?tpv/volume:null;
}
export function momentumGuardOk(session,upto,lookback,guardSigma){
  // Block only when the bars BEFORE the evaluated bar are already in free fall;
  // the evaluated bar itself is the dip being priced. Flat tape (sigma=rise=0) passes.
  if(upto<=lookback)return false;
  const recent=session.slice(upto-1-lookback,upto-1);
  const rets=[];for(let i=1;i<recent.length;i++)rets.push(recent[i].c/recent[i-1].c-1);
  const sigma=Math.sqrt(rets.reduce((s,x)=>s+x*x,0)/rets.length);
  const rise=recent.at(-1).c/recent[0].c-1;
  return rise>=-guardSigma*sigma;
}
export function enhancedDecision(session,state,c){
  // Decide on the LAST bar of `session` (all bars are completed). State carries
  // qty, entriesToday and entryTime (the entry decision bar's timestamp).
  if(!session.length)return {action:'hold',reason:'无行情'};
  const upto=session.length,b=session.at(-1),minute=marketMinute(b.t).minute;
  const stop=Math.min(c.time_stop_bars??ENHANCED_DEFAULTS.time_stop_bars,390);
  if(minute>=SESSION_CLOSE-15)
    return state.qty>0?{action:'sell',reason:'收盘前15分钟窗口:强制离场'}:{action:'hold',reason:'收盘前窗口,空仓等待收盘'};
  if(state.qty>0){
    const vwap=vwapUpto(session,upto);
    if(vwap!==null&&b.c>=vwap)return {action:'sell',reason:'回归VWAP:止盈'};
    const held=heldBars(session,state.entryTime);
    if(held!==null&&held>=stop)return {action:'sell',reason:'时间止损:持仓 '+held+' 棒未回归'};
    return {action:'hold',reason:'持有中',held_bars:held};
  }
  if(state.entriesToday>= (c.max_entries_per_day??ENHANCED_DEFAULTS.max_entries_per_day))
    return {action:'hold',reason:'当日入场次数已用尽'};
  if(minute< (c.entry_start_minute??ENHANCED_DEFAULTS.entry_start_minute))
    return {action:'hold',reason:'开盘观察窗口'};
  const vwap=vwapUpto(session,upto);
  if(vwap===null)return {action:'hold',reason:'无成交量'};
  const deviation=(vwap-b.c)/vwap,threshold=(c.threshold_bps??ENHANCED_DEFAULTS.threshold_bps)/10000;
  if(deviation>=threshold){
    if(momentumGuardOk(session,upto,c.lookback??ENHANCED_DEFAULTS.lookback,c.guard_sigma??ENHANCED_DEFAULTS.guard_sigma))
      return {action:'buy',reason:'低于VWAP '+(deviation*1e4).toFixed(0)+'bp(阈值 '+(threshold*1e4).toFixed(0)+'bp)且非自由落体'};
    return {action:'hold',reason:'偏差达标但前'+(c.lookback??ENHANCED_DEFAULTS.lookback)+'棒自由落体,放弃'};
  }
  return {action:'hold',reason:'偏差 '+(deviation>0?(deviation*1e4).toFixed(0):0)+'bp 未达阈值'};
}
function heldBars(session,entryTime){
  if(!entryTime)return null;
  for(let i=0;i<session.length;i++)if(session[i].t===entryTime)return session.length-1-i;
  return null;
}
export function heldBarsFor(bars,entryTime){
  // Same count over raw bars (used by the automation tick where session was rebuilt).
  return heldBars(bars,entryTime);
}

export function backtestEnhanced(raw,c){
  // Same accounting as engine backtestIntraday: decide on bar i-1 close, fill at
  // bar i open, benchmark = same-budget open->close round trip, flat by close.
  const bars=validateBars(raw).filter(b=>{const m=marketMinute(b.t).minute;return m>=SESSION_OPEN&&m<SESSION_CLOSE;});
  if(bars.length<60||new Set(bars.map(b=>marketMinute(b.t).day)).size<2)
    throw Object.assign(new Error('分钟行情不足：需要至少两个交易日、60 根常规时段分钟线'),{status:422,code:'INSUFFICIENT_DATA'});
  let cash=100000,peak=cash,costTotal=0,turnover=0,benchCash=100000,benchQty=0,benchCost=0;
  const curve=[],trades=[],decisions=[],daily=[],fee=c.cost_bps/10000;
  const execute=(delta,price,time,signalTime)=>{if(!delta)return;const gross=Math.abs(delta)*price,cost=gross*fee;cash-=delta*price+cost;costTotal+=cost;turnover+=gross;trades.push({t:time,signal_t:signalTime,side:delta>0?'buy':'sell',qty:Math.abs(delta),price,cost});};
  let qty=0,entryTime=null,entriesToday=0,day='';
  for(let i=0;i<bars.length;i++){
    const b=bars[i],today=marketMinute(b.t).day;
    if(today!==day){ // new session: benchmark buys at the first open, strategy state resets
      day=today;qty=0;entryTime=null;entriesToday=0;
      benchQty=Math.floor(c.budget/(b.o*(1+fee)));const cost=benchQty*b.o*fee;benchCash-=benchQty*b.o+cost;benchCost+=cost;
    }
    if(i&&marketMinute(bars[i-1].t).day===today){
      // decide on the last COMPLETED bar (i-1); fill at bar i's open — no lookahead
      const session=enhancedSession(bars,i-1),prev=session.at(-1);
      const d=enhancedDecision(session,{qty,entriesToday,entryTime:entryTime},c);
      if(d.action==='buy'&&!qty){
        const target=Math.min(Math.floor(c.budget/b.o),Math.floor(cash/(b.o*(1+fee)))+qty);
        execute(target-qty,b.o,b.t,prev.t);qty=target;entryTime=prev.t;entriesToday++;
      }else if(d.action==='sell'&&qty){
        execute(-qty,b.o,b.t,prev.t);qty=0;entryTime=null;
      }
    }
    const endDay=i===bars.length-1||marketMinute(bars[i+1].t).day!==today;
    if(endDay){execute(-qty,b.c,b.t,b.t);qty=0;entryTime=null;const cost=benchQty*b.c*fee;benchCash+=benchQty*b.c-cost;benchCost+=cost;benchQty=0;daily.push(cash/100000);}
    const sessionNow=enhancedSession(bars,i),live=enhancedDecision(sessionNow,{qty,entriesToday,entryTime},c);
    decisions.push({t:b.t,price:b.c,cash,qty,signal:live.action==='buy'?1:live.action==='sell'?0:null,reason:live.reason+(endDay?'；样本日末已按收盘价平仓':'')});
    const equity=cash+qty*b.c;peak=Math.max(peak,equity);curve.push({t:b.t,equity,drawdown:equity/peak-1,benchmark:benchCash+benchQty*b.c});
  }
  const returns=daily.map((e,i)=>e/(i?daily[i-1]:1)-1),n=returns.length,mean=returns.reduce((s,x)=>s+x,0)/n,sd=Math.sqrt(returns.reduce((s,x)=>s+(x-mean)**2,0)/Math.max(n-1,1));
  const sorted=[...returns].sort((a,b)=>a-b),var95=sorted[Math.floor(n*.05)],tail=sorted.filter(x=>x<=var95),elapsed=(Date.parse(bars.at(-1).t)-Date.parse(bars[0].t))/86400000;
  const decision=enhancedDecision(enhancedSession(bars,bars.length-1),{qty:0,entriesToday,entryTime:null},c);
  return {kernel_revision:'own-enhanced-1',engine:ENGINE_VERSION,config:c,signal:decision.action==='buy'?1:0,signal_reason:decision.reason,signal_value:null,signal_timestamp:bars.at(-1).t,metrics:{total_return:cash/100000-1,benchmark_return:benchCash/100000-1,benchmark_cost:benchCost,cagr:elapsed>0?(cash/100000)**(365.25/elapsed)-1:0,sharpe:sd?mean/sd*Math.sqrt(252):0,max_drawdown:Math.min(...curve.map(x=>x.drawdown)),volatility:sd*Math.sqrt(252),var95,cvar95:tail.reduce((s,x)=>s+x,0)/tail.length,turnover:turnover/100000,total_cost:costTotal,trade_count:trades.length},curve,trades,decisions,quality:{rows:bars.length,from:bars[0].t,to:bars.at(-1).t,duplicates:0,invalid:0},limitations:['分钟历史行情、只做多；收盘前平仓，未模拟股息、税费、冲击和部分成交。','增强回归内核与 Python quant_system/intraday.py 共用同一决策规则;默认参数是待验证的研究设定；未附原参数搜索证据，净收益对成本敏感。','前一根完整分钟线产生信号，下一根开盘价模拟成交；每日最后一根按收盘价强制平仓。','蓝线是同预算、首根开盘买入和末根收盘卖出的日内基准，按同样单边成本计算。','100,000 美元初始账户中仅使用策略预算。样本少时年化指标仅供演示。']};
}
