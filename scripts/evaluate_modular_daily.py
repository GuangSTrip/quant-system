"""Independent selection x entry/exit x allocation daily research, no broker.

Adjusted-price fractional units approximate corporate actions. This is a portfolio
return study, not an executable share ledger. All signals use past observations;
orders use the next available opening observation, with lagged liquidity caps.
"""
from __future__ import annotations
import argparse, json, warnings
from dataclasses import dataclass
from datetime import datetime, timezone
import numpy as np
import pandas as pd
from backtest_cn_point_in_time import load_panel as load_cn
from evaluate_dynamic_stock_selection import Panel, metrics
from fetch_daily_strategy_data import ROOT

START=252
CASH=1_000_000.
SELECTIONS=('momentum','low_vol','near_high','defensive_mix')
TIMINGS=('monthly','trend','breakout')
ALLOCATIONS=('equal','inverse_vol','vol08','vol12')
RULES={
 'selection':{
  'momentum':{'label':'中期动量','description':'按过去约 12 个月涨幅排序，跳过最近 1 个月，选前 20 只。它回答买谁，不单独决定买入时点。','basis':'经典相对动量；借鉴 Jegadeesh–Titman，窗口为本项目设定。'},
  'low_vol':{'label':'低波动','description':'按过去 120 个交易日收益波动从低到高选前 20 只。低波动只是历史特征，仍可能亏损。','basis':'低波动因子，Baker–Bradley–Wurgler。'},
  'near_high':{'label':'接近年内高点','description':'按当前收盘价 / 过去 252 日最高收盘价排序，选前 20 只；不要求直接追涨买入，进出时点由右侧买卖规则决定。','basis':'George–Hwang 的 52 周高点动量研究。'},
  'defensive_mix':{'label':'防御型多因子','description':'A 股：在波动较低的一半股票中，把股息率、低市盈率、动量的百分位等权综合，选 20 只。美港股缺少历史财务快照，改用低波动与动量的价格版，不冒充价值或质量因子。','basis':'参考 Robeco Conservative Formula；股息率替代净派息率，属于本项目改写，非原论文复刻。'}},
 'timing':{
  'monthly':{'label':'每月换股','description':'每 21 个交易日重选一次，下一交易日开盘换仓；两次换股之间继续持有。排名落选则卖出。'},
  'trend':{'label':'均线趋势进出','description':'股票入选且收盘高于过去 120 日均线时持有；跌破均线或排名落选时发出卖出信号，下一交易日开盘执行。'},
  'breakout':{'label':'通道突破进出','description':'入选股票收盘突破此前 55 日最高收盘价才买入；跌破此前 20 日最低收盘价或排名落选就卖出，均在下一交易日开盘执行。可能长时间持有现金。'}},
 'allocation':{
  'equal':{'label':'等权 · 目标80%股票','description':'例如入选 20 只，每只目标 4%，合计目标 80%，余下 20% 是现金；未满足买入条件的部分留现金。两次调整之间价格变动会使实际仓位略高或略低于 80%。仓位就是股票市值占账户总资产的比例。'},
  'inverse_vol':{'label':'波动倒数 · 目标≤80%','description':'历史波动小的股票分得更多，波动大的分得更少；调整时总股票目标仓位最多 80%，单只目标最多 10%。价格变动后实际比例会漂移。它是简化的风险分配，不是完整的风险平价优化器。'},
  'vol08':{'label':'8%波动目标 · 动态仓位','description':'先按波动倒数分配，再根据过去 60 日的组合共同涨跌估计风险；预计年化波动高于 8% 就缩小股票仓位，余钱留现金，不加杠杆。8% 是波动目标，不是收益保证或最大回撤上限。'},
  'vol12':{'label':'12%波动目标 · 动态仓位','description':'计算方式与 8% 波动目标相同，但允许更高波动，因此通常持有更多股票、收益和回撤也可能更大；仍最多 80% 股票。12% 不代表回撤最多 12%。'}}}

@dataclass
class Study:
    market:str
    panel:Panel
    features:dict
    selections:dict
    metadata:dict
    dead:np.ndarray

def load_international(market,end_date='2026-09-17',data_root=None):
    folder=(data_root or ROOT/'data'/'modular_daily')/market
    frames={p.name.removesuffix('.csv.gz'):pd.read_csv(p).set_index('date') for p in sorted(folder.glob('*.csv.gz'))}
    if len(frames)<30: raise ValueError(f'{market}: fewer than 30 accepted histories')
    dates=sorted(set().union(*(set(f.index) for f in frames.values())))
    dates=[d for d in dates if '2024-01-01'<=d<=end_date]
    def col(key):return np.column_stack([f.reindex(dates)[key].to_numpy(float) for f in frames.values()])
    c=col('close'); o=col('open'); v=col('volume')
    return Panel(dates,list(frames),o,c,pd.DataFrame(c).ffill().to_numpy(),v,c*v)

def fundamental_rankings(panel):
    n=len(panel.symbols); lookup={s:i for i,s in enumerate(panel.symbols)}
    snapshots=[]
    for path in sorted((ROOT/'data'/'modular_daily'/'CN_basic').glob('*.csv.gz')):
        df=pd.read_csv(path); dividend=np.full(n,np.nan); value=np.full(n,np.nan)
        ids=df.ts_code.map(lookup); keep=ids.notna(); ids=ids[keep].to_numpy(int); df=df[keep]
        dividend[ids]=df.dv_ttm.to_numpy(float)
        pe=df.pe_ttm.to_numpy(float)
        value[ids]=np.where(pe>0,1/np.maximum(pe,1e-8),np.nan)
        snapshots.append((path.name[:8],dividend,value))
    return snapshots

def rank(values,valid):
    out=np.zeros(len(values)); ids=np.flatnonzero(valid & np.isfinite(values))
    out[ids]=pd.Series(values[ids]).rank(pct=True,method='average').to_numpy()
    return out

def prepare(market,end_date='2026-09-17',data_root=None):
    warnings.filterwarnings('ignore',category=RuntimeWarning)
    if market=='CN':
        panel,list_dates,manifest=load_cn()
        access=json.loads((ROOT/'data'/'universe_access.json').read_text(encoding='utf8'))['lists']
        recs={r['ts_code']:r for r in access['CN_listed']+access['CN_delisted']}
        dead=np.array([int(str(recs[s].get('delist_date') or '99991231')) for s in panel.symbols])
    else:
        panel=load_international(market,end_date,data_root); list_dates=None; dead=np.full(len(panel.symbols),99991231)
    c=pd.DataFrame(panel.valuation)
    returns=c.pct_change(fill_method=None).replace([np.inf,-np.inf],np.nan)
    f={'vol':returns.rolling(120,min_periods=100).std().to_numpy()*np.sqrt(252),
       'sma':c.rolling(120,min_periods=120).mean().to_numpy(),
       'high':c.rolling(252,min_periods=240).max().to_numpy(),
       'entry':c.rolling(55,min_periods=55).max().shift(1).to_numpy(),
       'exit':c.rolling(20,min_periods=20).min().shift(1).to_numpy(),
       'momentum':(c.shift(21)/c.shift(252)-1).to_numpy(),
       'liquidity':pd.DataFrame(panel.turnover).rolling(20,min_periods=15).median().to_numpy(),
       'observations':np.cumsum(np.isfinite(panel.closes),axis=0),
       'returns':returns.fillna(0).to_numpy()}
    fundamental=fundamental_rankings(panel) if market=='CN' else []
    selected={s:{} for s in (*SELECTIONS,'benchmark')}
    selection_info={s:[] for s in SELECTIONS}
    for day in range(START,len(panel.dates),21):
        valid=np.isfinite(panel.closes[day]) & (panel.volumes[day]>0) & (f['observations'][day]>=240)
        valid &= np.isfinite(f['momentum'][day]) & np.isfinite(f['vol'][day]) & (f['vol'][day]>.01)
        if market=='CN':
            valid &= (np.datetime64(panel.dates[day])-list_dates).astype('timedelta64[D]').astype(int)>=365
            valid &= np.array([s.startswith(('000','001','002','003','300','301','600','601','603','605','688','689')) for s in panel.symbols])
        floor={'CN':20_000_000,'HK':2_000_000,'US':1_000_000}[market]
        valid &= f['liquidity'][day]>=floor
        ids=np.flatnonzero(valid)
        ids=sorted(ids,key=lambda i:(-f['liquidity'][day,i],panel.symbols[i]))[:1000]
        valid[:]=False; valid[ids]=True
        selected['benchmark'][day]=np.array(ids[:100],dtype=int)
        score_map={'momentum':f['momentum'][day], 'low_vol':-f['vol'][day],
                   'near_high':panel.valuation[day]/f['high'][day]}
        defensive=valid & (f['vol'][day]<=np.nanmedian(f['vol'][day,ids]) if ids else False)
        if market=='CN':
            available=[snap for snap in fundamental if snap[0]<panel.dates[day].replace('-','')]
            if available and (pd.Timestamp(panel.dates[day])-pd.Timestamp(available[-1][0])).days<=62:
                _,dividend,value=available[-1]
                defensive &= np.isfinite(dividend) & (dividend>0) & np.isfinite(value)
                score_map['defensive_mix']=(rank(dividend,defensive)+rank(value,defensive)+rank(f['momentum'][day],defensive))/3
            else: defensive[:]=False; score_map['defensive_mix']=np.zeros(len(valid))
        else:
            score_map['defensive_mix']=(rank(f['momentum'][day],defensive)+rank(-f['vol'][day],defensive))/2
        for name in SELECTIONS:
            eligible=defensive if name=='defensive_mix' else valid
            chosen=sorted(np.flatnonzero(eligible),key=lambda i:(-score_map[name][i],panel.symbols[i]))[:20]
            selected[name][day]=np.array(chosen,dtype=int)
            selection_info[name].append({'date':panel.dates[day],'eligible':int(valid.sum()),
                'symbols':[panel.symbols[i] for i in chosen]})
    meta={'from':panel.dates[0],'to':panel.dates[-1],'sessions':len(panel.dates),'symbols':len(panel.symbols),
          'currency':{'CN':'CNY','HK':'HKD','US':'USD'}[market],
          'scope':'全市场日线缓存；本次选股覆盖沪深 A 股，北交所未纳入' if market=='CN' else '当前交易所清单的自动抽样；有存续、下载成功及价格质量筛选偏差，非全市场验证',
          'selection_history':selection_info,
          'fundamental_snapshots':len(fundamental)}
    if market!='CN':
        manifest=json.loads(((data_root or ROOT/'data'/'modular_daily')/(market+'_manifest.json')).read_text(encoding='utf8'))
        meta.update(listed_candidates=manifest['listed_candidates'],requested=manifest['requested'])
    print('prepared',market,meta['symbols'],meta['sessions'],flush=True)
    return Study(market,panel,f,selected,meta,dead)

def allocate(study,day,ids,active,allocation):
    w=np.zeros(len(study.panel.symbols))
    if not len(ids):return w
    if allocation=='equal':base=np.full(len(ids),.8/len(ids))
    else:
        inverse=1/np.maximum(study.features['vol'][day,ids],.05)
        base=np.minimum(inverse/inverse.sum()*.8,.10)
    base=base*active[ids]
    if allocation.startswith('vol') and base.sum()>0:
        portfolio=study.features['returns'][max(0,day-59):day+1,ids]@base
        risk=np.std(portfolio,ddof=1)*np.sqrt(252)
        target=.08 if allocation=='vol08' else .12
        base*=min(1.,target/risk) if risk>0 else 1.
    w[ids]=base
    return w

def execute(study,day,target,cash,units,fee):
    """Opening-price fills; budgets and liquidity available before this session only."""
    p=study.panel
    price=np.where(np.isfinite(p.opens[day]) & (p.opens[day]>0),p.opens[day],p.valuation[day-1])
    price=np.nan_to_num(price,nan=0.)
    value=units*price; equity=cash+value.sum(); delta=equity*target-value
    available=np.isfinite(p.opens[day]) & (p.opens[day]>0)
    # Conservative opening-gap guard covers ST-like limits without pretending historical ST is known.
    gap=np.divide(p.opens[day],p.valuation[day-1],out=np.ones(len(units)),where=p.valuation[day-1]>0)-1
    allowed=available & ((study.market!='CN') | (((delta<=0)|(gap<.048)) & ((delta>=0)|(gap>-.048))))
    delta=np.where(allowed,delta,0.)
    cap=np.nan_to_num(p.turnover[day-1],nan=0.)*.01
    delta=np.clip(delta,-cap,cap)
    delta=np.where(np.abs(delta)>=equity*.0005,delta,0.)  # skip <0.05% dust turnover
    sell=np.maximum(-delta,0.)
    cash+=sell.sum()*(1-fee)
    units-=np.divide(sell,price,out=np.zeros(len(units)),where=price>0)
    buy=np.maximum(delta,0.)
    need=buy.sum()*(1+fee)
    if need>cash:buy*=max(0.,cash)/need
    cash-=buy.sum()*(1+fee)
    units+=np.divide(buy,price,out=np.zeros(len(units)),where=price>0)
    return float(cash),float((sell.sum()+buy.sum())*fee),float(sell.sum()+buy.sum()),int(np.count_nonzero(sell)+np.count_nonzero(buy))

def apply_risk_policy(study,day,weights,policy,equity,peak):
    """Close-known risk budget, implemented at a later open; not a loss guarantee."""
    if not policy or weights.sum()<=0:return weights
    result=weights.copy()
    if policy in ('risk06','risk08'):
        ids=np.flatnonzero(result)
        risk=np.std(study.features['returns'][max(0,day-59):day+1,ids]@result[ids],ddof=1)*np.sqrt(252)
        target=.06 if policy=='risk06' else .08
        result*=min(1.,target/risk) if risk>0 else 1.
    elif policy=='cushion07':
        # Ratcheting 93% wealth floor, multiplier 6, no leverage. Gaps may breach floor.
        budget=min(.8,max(0.,6*(equity-.93*peak)/equity)) if equity>0 else 0.
        result*=min(1.,budget/result.sum())
    else:raise ValueError('Unknown risk policy: '+str(policy))
    return result

@dataclass
class DecisionState:
    """Replayable close state. Day indices always refer to the fixed input origin."""
    ids: np.ndarray
    active: np.ndarray
    target: np.ndarray
    decision_day: int = -1

    @classmethod
    def empty(cls, size):
        return cls(np.array([], dtype=int), np.zeros(size, dtype=bool), np.zeros(size))

    def export(self, symbols):
        return {"selected": [symbols[i] for i in self.ids],
                "active": [symbols[i] for i in np.flatnonzero(self.active)],
                "target": dict(zip(symbols, self.target.tolist())),
                "decision_day": self.decision_day}


def decide_close(study, day, selection, timing, allocation, state, equity, peak, risk_policy=None):
    """The single decision kernel used by historical fills and paper signal export."""
    if timing not in TIMINGS or allocation not in ALLOCATIONS:
        raise ValueError("Unknown timing/allocation")
    p = study.panel
    reselect = day in study.selections[selection]
    ids = study.selections[selection][day] if reselect else state.ids
    permitted = np.zeros(len(p.symbols), dtype=bool)
    permitted[ids] = True
    if timing == 'monthly': active = permitted
    elif timing == 'trend': active = permitted & (p.valuation[day] > study.features['sma'][day])
    else:
        active = (state.active | (p.valuation[day] > study.features['entry'][day])) & permitted
        active &= p.valuation[day] >= study.features['exit'][day]
    change = not np.array_equal(active, state.active)
    recalc = reselect or change or ((allocation.startswith('vol') or risk_policy) and (day-START)%5 == 0) or risk_policy == 'cushion07'
    target = state.target.copy()
    if recalc:
        target = apply_risk_policy(study, day, allocate(study, day, ids, active, allocation), risk_policy, equity, peak)
    return DecisionState(ids.copy(), active.copy(), target, day if recalc else state.decision_day), bool(recalc)

def simulate(study,selection,timing,allocation,cost_multiplier=1.,risk_policy=None,execution_lag=1,trace=None):
    if execution_lag<1:raise ValueError('Signals must execute after the signal session')
    p=study.panel; n=len(p.symbols); units=np.zeros(n); cash=CASH; queue={}; peak=CASH
    curve=[]; weight_curve=[]; count=0; costs=0.; turnover=0.; annual=[]; active=np.zeros(n,dtype=bool)
    state=DecisionState.empty(n); gross_sum=0.; capital_loss=0.
    fee={'CN':.0015,'HK':.002,'US':.001}[study.market]*cost_multiplier
    for day in range(START,len(p.dates)):
        # Known delisting effective date: conservatively write remaining inventory down to zero.
        dead=(study.dead<=int(p.dates[day].replace('-',''))) & (units>0)
        if dead.any():capital_loss+=float(np.nansum(units[dead]*p.valuation[day-1,dead])); units[dead]=0
        if day in queue:
            cash,fee_paid,traded,orders=execute(study,day,queue.pop(day),cash,units,fee)
            costs+=fee_paid;turnover+=traded;count+=orders
        values=np.nan_to_num(p.valuation[day],nan=0.)*units
        equity=cash+values.sum(); gross=values.sum()/equity
        peak=max(peak,equity)
        curve.append({'date':p.dates[day],'equity':float(equity)})
        weight_curve.append(float(gross));gross_sum+=gross
        state, recalc = decide_close(study,day,selection,timing,allocation,state,equity,peak,risk_policy)
        if recalc: queue[day+execution_lag] = state.target.copy()
        if trace is not None:
            event={'date':p.dates[day], 'equity':float(equity), 'peak':float(peak),
                   'rebalanced':recalc, 'state':state.export(p.symbols)}
            if callable(trace): trace(event)
            else: trace.append(event)
    split=next(i for i,r in enumerate(curve) if r['date']>='2026-01-01')
    return {'full':metrics(curve),'development':metrics(curve[:split]),'review':metrics(curve,'2026-01-01'),
            'equity':[round(r['equity']/CASH,6) for r in curve],
            'exposure':[round(w,4) for w in weight_curve], 'trade_count':count,
            'cost':round(costs,2),'traded_notional':round(turnover,2),
            'average_exposure_pct':round(gross_sum/len(curve)*100,2),
            'delist_writeoff':round(capital_loss,2)}

def main():
    parser=argparse.ArgumentParser();parser.add_argument('--markets',nargs='+',default=['CN','HK','US']);args=parser.parse_args()
    out=ROOT/'reports'/'modular_daily';out.mkdir(exist_ok=True,parents=True)
    for market in args.markets:
        study=prepare(market)
        report={'market':market,'generated_at':datetime.now(timezone.utc).isoformat(),'metadata':study.metadata,
                'dates':study.panel.dates[START:],'rules':RULES,'combinations':[],
                'model':'fractional adjusted-price units; corporate actions approximated by supplier adjustment; next-open; costs; zero cash interest',
                'primary_goal':{'annual_return':8,'drawdown':10},'original_goal':{'annual_return':8,'drawdown':5}}
        report['benchmark']=simulate(study,'benchmark','monthly','equal')
        for s in SELECTIONS:
            for t in TIMINGS:
                for a in ALLOCATIONS:
                    r=simulate(study,s,t,a);r.update(id=f'{s}__{t}__{a}',selection=s,timing=t,allocation=a)
                    report['combinations'].append(r)
            print(market,s,'12 combinations complete',flush=True)
        # Development-only ranking; later results never influence the chosen candidate.
        eligible=[r for r in report['combinations'] if r['development']['cagr_pct']>=8 and r['development']['max_drawdown_pct']>=-10]
        chosen=max(eligible,key=lambda r:r['development']['sharpe']) if eligible else max(report['combinations'],key=lambda r:r['development']['sharpe'])
        report['development_choice']={'id':chosen['id'],'qualified':bool(eligible)}
        report['cost_stress']=simulate(study,chosen['selection'],chosen['timing'],chosen['allocation'],2.)
        report['counts']={'combinations':len(report['combinations']),
                         'dev_pass_8_10':len(eligible),
                         'both_pass_8_10':sum(all(r[p]['cagr_pct']>=8 and r[p]['max_drawdown_pct']>=-10 for p in ('development','review')) for r in report['combinations'])}
        path=out/(market+'.json');path.write_text(json.dumps(report,ensure_ascii=False,separators=(',',':'),allow_nan=False),encoding='utf8')
        print('saved',market,report['counts'],'choice',chosen['id'],chosen['review']['cagr_pct'],chosen['review']['max_drawdown_pct'],flush=True)
    public={'generated_at':datetime.now(timezone.utc).isoformat(),'rules':RULES,'markets':{}}
    for market in ('CN','HK','US'):
        path=out/(market+'.json')
        if path.exists():public['markets'][market]=json.loads(path.read_text(encoding='utf8'))
    (ROOT/'web_platform'/'src'/'modular-daily-results.json').write_text(json.dumps(public,ensure_ascii=False,separators=(',',':'),allow_nan=False),encoding='utf8')

if __name__=='__main__':main()
