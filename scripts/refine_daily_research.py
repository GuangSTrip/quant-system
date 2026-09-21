"""Bounded second-round research: China factors and tighter international risk.

All periods are already seen; this is explicitly exploratory, not a new holdout.
Original reports remain untouched. Candidate definitions are stored with results.
"""
import json
from datetime import datetime,timezone
import numpy as np
import pandas as pd
from evaluate_modular_daily import ROOT,START,prepare,simulate,rank

CN_NAMES={'earnings_value':'盈利收益率选股','dividend_defensive':'红利低波动',
          'balanced_value':'价值动量低波动','smooth_momentum':'平稳中期动量'}
RISK_NAMES={'risk06':'6%波动目标','risk08':'8%波动目标','cushion07':'7%净值缓冲仓位'}
TIMING_NAMES={'monthly':'每月换股','trend':'120日均线进出','breakout':'55/20日通道进出'}

def china_selection(study,data_root=None):
    p=study.panel;f=study.features;n=len(p.symbols);lookup={s:i for i,s in enumerate(p.symbols)}
    snaps=[]
    for path in sorted(((data_root or ROOT/'data'/'modular_daily')/'CN_basic').glob('*.csv.gz')):
        frame=pd.read_csv(path);ids=frame.ts_code.map(lookup);valid=ids.notna();frame=frame[valid];ids=ids[valid].to_numpy(int)
        values={}
        for col in ['pe_ttm','dv_ttm','total_mv']:
            arr=np.full(n,np.nan);arr[ids]=frame[col].to_numpy(float);values[col]=arr
        snaps.append((pd.Timestamp(path.name[:8]),values))
    ordinary=np.array([s.startswith(('000','001','002','003','300','301','600','601','603','605','688','689')) for s in p.symbols])
    history={name:[] for name in CN_NAMES}
    for name in CN_NAMES:study.selections[name]={}
    for day in range(START,len(p.dates),21):
        date=pd.Timestamp(p.dates[day]);prior=[snap for snap in snaps if snap[0]<date]
        if not prior or (date-prior[-1][0]).days>62:raise ValueError('Missing historical snapshot: '+str(date))
        v=prior[-1][1]
        valid=ordinary & (f['observations'][day]>=240) & np.isfinite(p.closes[day]) & (p.volumes[day]>0)
        valid &= np.isfinite(v['total_mv']) & np.isfinite(f['vol'][day]) & (f['vol'][day]>.01)
        # China evidence motivates excluding the smallest 30% before value ranking.
        valid &= v['total_mv']>=np.nanquantile(v['total_mv'][valid],.30)
        valid &= f['liquidity'][day]>=20_000_000
        ids=sorted(np.flatnonzero(valid),key=lambda i:-f['liquidity'][day,i])[:2000]
        valid[:]=False;valid[ids]=True
        earn=np.divide(1.,v['pe_ttm'],out=np.full(n,np.nan),where=v['pe_ttm']>0)
        mom=p.valuation[day-5]/p.valuation[day-126]-1
        consistency=(f['returns'][day-119:day+1]>0).mean(axis=0)
        value_ok=valid & np.isfinite(earn)
        dividend_ok=value_ok & (v['dv_ttm']>0)
        scores={
            'earnings_value':rank(earn,value_ok),
            'dividend_defensive':.6*rank(v['dv_ttm'],dividend_ok)+.4*rank(-f['vol'][day],dividend_ok),
            'balanced_value':(rank(earn,value_ok)+rank(mom,value_ok)+rank(-f['vol'][day],value_ok))/3,
            'smooth_momentum':.5*rank(mom/np.maximum(f['vol'][day],.05),valid)+.5*rank(consistency,valid)}
        for name,score in scores.items():
            eligible=dividend_ok if name=='dividend_defensive' else valid if name=='smooth_momentum' else value_ok
            chosen=sorted(np.flatnonzero(eligible),key=lambda i:(-score[i],p.symbols[i]))[:30]
            study.selections[name][day]=np.array(chosen,dtype=int)
            history[name].append({'date':p.dates[day],'eligible':int(eligible.sum()),'symbols':[p.symbols[i] for i in chosen]})
    return history

def old_choice(old):
    pool=[r for r in old['combinations'] if r['full']['max_drawdown_pct']>=-10]
    return max(pool,key=lambda r:r['full']['cagr_pct'])

def main():
    out=ROOT/'reports'/'daily_refinement';out.mkdir(parents=True,exist_ok=True)
    public={'generated_at':datetime.now(timezone.utc).isoformat(),'stage':'已看过数据上的进一步探索，非独立样本外检验','markets':{}}
    for market in ['CN','HK','US']:
        study=prepare(market)
        old=json.loads((ROOT/'reports'/'modular_daily'/(market+'.json')).read_text(encoding='utf8'))
        report={'market':market,'dates':study.panel.dates[START:],'previous':old_choice(old),
                'experiments':[],'definitions':{},'selection_history':{}}
        configs=[]
        if market=='CN':
            report['selection_history']=china_selection(study)
            for selection,label in CN_NAMES.items():
                for timing in ['monthly','trend']:
                    for allocation in ['vol08','vol12']:
                        configs.append((selection,timing,allocation,None,label+' × '+TIMING_NAMES[timing]+' × '+('8%' if allocation=='vol08' else '12%')+'波动目标'))
        else:
            for timing in ['monthly','trend','breakout']:
                for policy,label in RISK_NAMES.items():
                    configs.append(('near_high',timing,'inverse_vol',policy,'接近年内高点 × '+TIMING_NAMES[timing]+' × '+label))
        report['definitions']={'CN_selection':CN_NAMES,'risk':RISK_NAMES,
          'details':'A股新选股在历史市值排除最小30%后，按历史成交额保留最多2000只、选前30只；其他市场保留原先前20只高点选股。6%/8%波动目标每5日更新；净值缓冲每天更新，以历史净值高点的93%为参考底线、风险资金为净值高于底线部分的6倍，目标股票仓位最多80%。离散交易和跳空可能突破参考底线。'}
        for selection,timing,allocation,policy,label in configs:
            r=simulate(study,selection,timing,allocation,risk_policy=policy)
            r.update(id='__'.join([selection,timing,allocation,policy or 'base']),label=label,
                     selection=selection,timing=timing,allocation=allocation,risk_policy=policy)
            report['experiments'].append(r)
            print(market,label,'annual',round(r['full']['cagr_pct'],2),'dd',round(r['full']['max_drawdown_pct'],2),'2026',round(r['review']['cagr_pct'],2),flush=True)
        # Rank all tried old and new variants transparently, rather than discard stronger controls.
        all_results=old['combinations']+report['experiments']
        if market=='CN':
            acceptable=[r for r in all_results if r['full']['max_drawdown_pct']>=-10 and r['review']['cagr_pct']>=0]
            chosen=max(acceptable,key=lambda r:r['full']['cagr_pct'])
        else:
            acceptable=[r for r in all_results if r['full']['cagr_pct']>=8 and r['review']['cagr_pct']>=0]
            chosen=max(acceptable,key=lambda r:r['full']['max_drawdown_pct'])
            if market=='HK':
                balanced=[r for r in acceptable if r['full']['max_drawdown_pct']>=-5 and r['review']['cagr_pct']>=8]
                if balanced:chosen=max(balanced,key=lambda r:r['full']['cagr_pct'])
        report['selected']=chosen.copy()
        if 'label' not in report['selected']:
            report['selected']['label']=' × '.join(old['rules'][key][chosen[key]]['label'] for key in ['selection','timing','allocation'])
        for key,options in [('double_cost',{'cost_multiplier':2.}),('delayed_open',{'execution_lag':2})]:
            report[key]=simulate(study,chosen['selection'],chosen['timing'],chosen['allocation'],risk_policy=chosen.get('risk_policy'),**options)
        report['experiment_count']=len(configs)
        report['selection_basis']='完整历史上的事后探索选择；不能作为未来收益承诺'
        (out/(market+'.json')).write_text(json.dumps(report,ensure_ascii=False,separators=(',',':'),allow_nan=False),encoding='utf8')
        print('CHOSEN',market,report['selected']['label'],report['selected']['full'],flush=True)
        public['markets'][market]=report
    (ROOT/'web_platform'/'src'/'daily-refinement.json').write_text(json.dumps(public,ensure_ascii=False,separators=(',',':'),allow_nan=False),encoding='utf8')

if __name__=='__main__':main()
