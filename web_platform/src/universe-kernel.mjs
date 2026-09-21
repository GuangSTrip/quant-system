// Trading-universe selection kernel: a faithful JS port of the Python
// scripts/select_trading_universe.py funnel (price -> ADV_N -> Roll spread
// proxy -> vol ratio -> weighted z-score rank). The only hyperparameter is the
// history window N; every other threshold is a constant below. Research only —
// this module never touches orders.
import {marketMinute} from './engine.mjs';

export const U_MIN_HISTORY_DAYS=5,U_MAX_HISTORY_DAYS=20,U_DEFAULT_HISTORY_DAYS=20;
export const SESSION_OPEN=570,SESSION_CLOSE=960;
export const U_CONSTANTS={
  min_price_usd:5,adv_floor_usd:5e8,max_spread_bps:5,vol_ratio_min:.5,vol_ratio_max:2,
  w_liq:.5,w_cost:.3,w_vol:.2,top_n:50,vol_window_bars:30,
  daily_coverage_min:.8,minute_day_min_bars:300,minute_coverage_min:.75,
  spread_min_sessions:2,zscore_min_survivors:3
};

export function inferAsOf(dailyDates,nowMs){
  const sorted=[...new Set(dailyDates)].sort();
  for(let i=sorted.length-1;i>=0;i--)
    if(nowMs>=Date.parse(sorted[i]+'T21:15:00.000Z'))return sorted[i];
  return null;
}
export function splitSessions(bars){
  // Eastern regular-session grouping, chronological within each day.
  const sessions={};
  for(const b of bars){const m=marketMinute(b.t);if(m.minute>=SESSION_OPEN&&m.minute<SESSION_CLOSE)(sessions[m.day]??=[]).push(b);}
  for(const day of Object.keys(sessions))sessions[day].sort((a,b)=>a.t<b.t?-1:1);
  return sessions;
}
export function computeAdv(dailyRows,windowSet,n){
  // dailyRows: [{t:'YYYY-MM-DD',c,v}]; window = the N sessions before as-of.
  const rows=dailyRows.filter(r=>windowSet.has(r.t));
  if(!rows.length)return {adv:null,coverage:0};
  const coverage=rows.length/n;
  return {adv:rows.reduce((s,r)=>s+r.c*r.v,0)/rows.length,coverage};
}
export function rollSpreadBps(closes){
  // Roll (1984) effective-spread proxy from one session's minute closes.
  const deltas=[];for(let i=1;i<closes.length;i++)deltas.push(closes[i]-closes[i-1]);
  const xs=deltas.slice(1),ys=deltas.slice(0,-1);
  const mx=xs.reduce((s,x)=>s+x,0)/xs.length,my=ys.reduce((s,x)=>s+x,0)/ys.length;
  let cov=0;for(let i=0;i<xs.length;i++)cov+=(xs[i]-mx)*(ys[i]-my);
  cov/=xs.length-1;
  if(cov>=0)return 0;
  const level=closes.reduce((s,x)=>s+x,0)/closes.length;
  return 2*Math.sqrt(-cov)/level*1e4;
}
export function sessionTailVol(closes,window=U_CONSTANTS.vol_window_bars){
  const tail=closes.slice(-(window+1));
  if(tail.length<window+1)return null;
  const rets=[];for(let i=1;i<tail.length;i++)rets.push(tail[i]/tail[i-1]-1);
  const mean=rets.reduce((s,x)=>s+x,0)/rets.length;
  const variance=rets.reduce((s,x)=>s+(x-mean)**2,0)/(rets.length-1);
  return Math.sqrt(variance);
}
export function computeVolRatio(sessions,asOf,n){
  const target=Object.keys(sessions).filter(d=>d<=asOf).sort().slice(-(n+1));
  const valid=target.filter(d=>sessions[d].length>=U_CONSTANTS.minute_day_min_bars);
  if(!valid.includes(asOf))return {ratio:null,valid:valid.length,target:target.length};
  const base=valid.filter(d=>d<asOf).map(d=>sessionTailVol(sessions[d].map(b=>b.c))).filter(v=>v!==null);
  if(!base.length)return {ratio:null,valid:valid.length,target:target.length};
  const denominator=base.reduce((s,x)=>s+x,0)/base.length;
  const numerator=sessionTailVol(sessions[asOf].map(b=>b.c));
  if(!numerator||denominator<=0)return {ratio:null,valid:valid.length,target:target.length};
  return {ratio:numerator/denominator,valid:valid.length,target:target.length};
}
function zscore(values){
  if(values.length<U_CONSTANTS.zscore_min_survivors)return {zs:values.map(()=>0),degraded:true};
  // Relative-epsilon zero-variance guard: a left-to-right float sum of identical
  // values can miss exact zero by an ulp, which would otherwise normalize that
  // rounding noise into a constant fake z-score.
  const mean=values.reduce((s,x)=>s+x,0)/values.length;
  const scale=Math.max(1,...values.map(x=>Math.abs(x)));
  const spread=Math.max(...values.map(x=>Math.abs(x-mean)));
  if(spread<=1e-12*scale)return {zs:values.map(()=>0),degraded:true};
  const sd=Math.sqrt(values.reduce((s,x)=>s+(x-mean)**2,0)/(values.length-1));
  return {zs:values.map(x=>(x-mean)/sd),degraded:false};
}

export function selectUniverse(pool,dailyBy,minuteBy,asOf,n){
  // Pure funnel: dailyBy[symbol]=[{t,c,v}], minuteBy[symbol]=[{t,o,h,l,c,v}].
  const allDates=[...new Set(Object.values(dailyBy).flat().map(r=>r.t))].sort();
  const window=allDates.filter(d=>d<asOf).slice(-n);
  const windowSet=new Set(window);
  const exclusions=[],quality={},warnings=[];
  const exclude=(symbol,stage,reason)=>exclusions.push({symbol,stage,reason});
  const funnel={pool:pool.length,after_price:0,after_adv:0,after_spread:0,after_vol:0,selected:0};

  let running=[];
  for(const symbol of pool){
    const rows=(dailyBy[symbol]||[]).filter(r=>r.t<=asOf).sort((a,b)=>a.t<b.t?-1:1);
    if(!rows.length){exclude(symbol,'daily_fetch','无 as-of 前日线数据');continue;}
    const close=rows.at(-1).c;
    quality[symbol]={close_asof:close};
    if(!(close>U_CONSTANTS.min_price_usd)){exclude(symbol,'price',`close=${close.toFixed(4)} 不高于 ${U_CONSTANTS.min_price_usd}`);continue;}
    running.push(symbol);
  }
  funnel.after_price=running.length;

  let stage=[];
  for(const symbol of running){
    const {adv,coverage}=computeAdv(dailyBy[symbol]||[],windowSet,n);
    quality[symbol].daily_coverage=Number(coverage.toFixed(4));
    if(adv===null||coverage<U_CONSTANTS.daily_coverage_min){exclude(symbol,'adv',`日线覆盖率 ${(coverage*100).toFixed(0)}% 低于 ${U_CONSTANTS.daily_coverage_min*100}%`);continue;}
    quality[symbol].adv_usd=Math.round(adv*100)/100;
    if(!(adv>U_CONSTANTS.adv_floor_usd)){exclude(symbol,'adv',`ADV_${n}=${adv.toExponential(2)} 不高于 5.00e+8`);continue;}
    stage.push(symbol);
  }
  running=stage;funnel.after_adv=running.length;

  stage=[];
  for(const symbol of running){
    const sessions=splitSessions(minuteBy[symbol]||[]);
    const base=Object.keys(sessions).filter(d=>d<asOf).sort().slice(-n)
      .filter(d=>sessions[d].length>=U_CONSTANTS.minute_day_min_bars);
    const spreads=base.map(d=>rollSpreadBps(sessions[d].map(b=>b.c)));
    quality[symbol].spread_sessions_used=base.length;
    if(base.length<U_CONSTANTS.spread_min_sessions){exclude(symbol,'spread',`可用分钟会话 ${base.length} 少于 ${U_CONSTANTS.spread_min_sessions}`);continue;}
    const spread=spreads.reduce((s,x)=>s+x,0)/spreads.length;
    quality[symbol].avg_spread_bps=Number(spread.toFixed(4));
    if(!(spread<U_CONSTANTS.max_spread_bps)){exclude(symbol,'spread',`AvgSpread=${spread.toFixed(2)}bp 不低于 ${U_CONSTANTS.max_spread_bps}bp`);continue;}
    stage.push(symbol);
  }
  funnel.after_spread=stage.length;running=stage;

  stage=[];
  for(const symbol of running){
    const sessions=splitSessions(minuteBy[symbol]||[]);
    const {ratio,valid,target}=computeVolRatio(sessions,asOf,n);
    quality[symbol].minute_sessions_valid=valid;quality[symbol].minute_target_sessions=target;
    if(valid<U_CONSTANTS.minute_coverage_min*(n+1)){exclude(symbol,'vol',`有效分钟会话 ${valid}/${target} 低于 ${U_CONSTANTS.minute_coverage_min*100}%`);continue;}
    if(ratio===null){exclude(symbol,'vol','波动比不可计算(as-of 会话无效或基期为零)');continue;}
    quality[symbol].vol_ratio=Number(ratio.toFixed(6));
    if(!(U_CONSTANTS.vol_ratio_min<ratio&&ratio<U_CONSTANTS.vol_ratio_max)){exclude(symbol,'vol',`VolRatio=${ratio.toFixed(3)} 不在 (${U_CONSTANTS.vol_ratio_min}, ${U_CONSTANTS.vol_ratio_max})`);continue;}
    stage.push(symbol);
  }
  funnel.after_vol=stage.length;

  const symbols=[...stage].sort();
  const liq={...zscore(symbols.map(s=>Math.log(quality[s].adv_usd)))};
  const cost={...zscore(symbols.map(s=>quality[s].avg_spread_bps))};
  if(liq.degraded||cost.degraded)warnings.push(`zscore_degraded: 幸存者少于 ${U_CONSTANTS.zscore_min_survivors} 或横截面标准差为零`);
  const ranking=symbols.map((s,i)=>{
    const scoreVol=-Math.abs(quality[s].vol_ratio-1);
    return {ticker:s,close:quality[s].close_asof,adv_usd:quality[s].adv_usd,
      avg_spread_bps:quality[s].avg_spread_bps,vol_ratio:quality[s].vol_ratio,
      z_liq:Number(liq.zs[i].toFixed(6)),z_cost:Number((-cost.zs[i]).toFixed(6)),
      score_vol:Number(scoreVol.toFixed(6)),
      rank_score:Number((U_CONSTANTS.w_liq*liq.zs[i]-U_CONSTANTS.w_cost*cost.zs[i]+U_CONSTANTS.w_vol*scoreVol).toFixed(6)),
      minute_days_used:quality[s].minute_sessions_valid};
  }).sort((a,b)=>a.rank_score!==b.rank_score?b.rank_score-a.rank_score:(a.ticker<b.ticker?-1:1))
    .map((row,i)=>({rank:i+1,...row}));
  const selected=ranking.slice(0,U_CONSTANTS.top_n);
  funnel.selected=selected.length;
  return {as_of:asOf,spread_mode:'roll_minute_proxy',hyperparameters:{history_days:n},
    constants:U_CONSTANTS,funnel,per_symbol_exclusions:exclusions,data_quality:quality,warnings,ranking,selected};
}
