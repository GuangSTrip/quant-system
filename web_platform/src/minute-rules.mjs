// One close-bar signal contract for research, parameter backtests and execution.
// Input contains only this session's observations through the evaluated close.
export function minuteRule(session,c,{minute,open=570,close=960}={}){
 const b=session.at(-1),lookback=c.lookback??20;
 if(!b)return {signal:0,reason:'无完整行情',value:null};
 if(minute<open||minute>=close)return {signal:0,reason:'常规交易时段外',value:null};
 if(minute>=close-15)return {signal:0,reason:'收盘前 15 分钟：目标空仓',value:null};
 if(minute<open+c.opening_minutes||session.length<3)return {signal:0,reason:'等待开盘观察区间',value:null};
 if(c.type==='adaptive_momentum'){
  if(session.length<=lookback)return {signal:0,reason:`等待 ${lookback} 根分钟线预热`,value:null};
  const recent=session.slice(-lookback-1,-1),returns=recent.slice(1).map((x,i)=>x.c/recent[i].c-1);
  const sigma=Math.sqrt(returns.reduce((a,x)=>a+x*x,0)/returns.length),rise=b.c/recent[0].c-1;
  const threshold=Math.max(c.threshold_bps/10000,sigma*(c.volatility_multiplier??2));
  const volume=recent.reduce((a,x)=>a+x.v,0)/recent.length*(c.volume_multiplier??1.2);
  const signal=rise>threshold&&b.v>volume?1:rise<0?0:null;
  return {signal,value:threshold,reason:`${lookback} 分钟动量 ${(rise*100).toFixed(3)}% / 阈值 ${(threshold*100).toFixed(3)}%；成交量 ${b.v} / 门槛 ${volume.toFixed(0)}；${signal===1?'目标持有':signal===0?'目标空仓':'保持仓位'}`};
 }
 if(c.type==='opening_range_breakout'){
  const range=session.filter(x=>x.minute<open+c.opening_minutes);
  if(range.length<3)return {signal:0,reason:'开盘区间有效分钟线不足',value:null};
  const high=Math.max(...range.map(x=>x.h)),mid=(high+Math.min(...range.map(x=>x.l)))/2;
  const signal=b.c>high*(1+c.threshold_bps/10000)?1:b.c<mid?0:null;
  return {signal,value:high,reason:`收盘 ${b.c.toFixed(3)} / 突破线 ${(high*(1+c.threshold_bps/10000)).toFixed(3)} / 区间中点 ${mid.toFixed(3)}；${signal===1?'收盘价突破开盘区间上沿':signal===0?'收盘价跌破开盘区间中点':'保持当前仓位'}`};
 }
 if(c.type!=='vwap_reversion')throw Error('未知分钟策略');
 const volume=session.reduce((a,x)=>a+x.v,0);
 if(volume<=0)return {signal:0,reason:'成交量不足',value:null};
 const vwap=session.reduce((a,x)=>a+(x.h+x.l+x.c)/3*x.v,0)/volume;
 const signal=b.c<=vwap*(1-c.threshold_bps/10000)?1:b.c>=vwap?0:null;
 return {signal,value:vwap,reason:`收盘 ${b.c.toFixed(3)} / VWAP ${vwap.toFixed(3)} / 买入线 ${(vwap*(1-c.threshold_bps/10000)).toFixed(3)}；${signal===1?'收盘价低于当日 VWAP 触发线':signal===0?'收盘价回到 VWAP':'保持当前仓位'}`};
}
export function describeMinuteRule(c){
 const ending='完整分钟收盘决策，随后可执行开盘成交；收盘前 15 分钟目标空仓，A 股当日买入受 T+1 约束。';
 if(c.type==='opening_range_breakout')return `开盘观察 ${c.opening_minutes} 分钟；收盘突破区间上沿 ${c.threshold_bps} 基点买入，跌破中点退出。${ending}`;
 if(c.type==='vwap_reversion')return `典型价格 (H+L+C)/3 按成交量加权；低于当日 VWAP ${c.threshold_bps} 基点买入，回到 VWAP 退出。${ending}`;
 return `回看 ${c.lookback??20} 根分钟线；动量超过 ${c.threshold_bps} 基点和 ${c.volatility_multiplier??2} 倍波动阈值，且成交量超过此前均量 ${c.volume_multiplier??1.2} 倍时买入；动量转负退出。${ending}`;
}
