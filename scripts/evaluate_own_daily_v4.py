"""Preregistered v4 mechanism comparison and causal yearly model selection."""
from pathlib import Path
from dataclasses import replace,asdict
import argparse,hashlib,itertools,json,sys,time,platform
import numpy as np
import pandas as pd
ROOT=Path(__file__).resolve().parents[1];sys.path.insert(0,str(ROOT))
from quant_system.own_daily import Design,load,run,metrics
from evaluate_own_daily import write,selection_score

def configs():
    return [Design(name=f'{family}_liq{limit}_v{int(vol*100)}',family=family,liquidity_limit=limit,max_stock_vol=.75,
        target_vol=vol,holdings=25,rebalance=21,breadth_floor=.35)
        for family,limit,vol in itertools.product(['quality_momentum','smooth_breakout','defensive_momentum'],[200,500],[.14,.20])]

def main():
    ap=argparse.ArgumentParser();ap.add_argument('--market',required=True,choices=['CN','HK','US']);ap.add_argument('--tag',default='');args=ap.parse_args()
    out=ROOT/'reports/own_daily_v4'/args.tag/args.market;out.mkdir(parents=True,exist_ok=True)
    p=load(ROOT/'data/own_daily_v1',args.market);choices=configs()
    action_path=ROOT/'data/own_daily_v4/normalized_actions.json'
    actions=json.loads(action_path.read_text()) if args.market=='US' and action_path.exists() else []
    kwargs=dict(stale_writeoff=False,delisted_writeoff=False,corporate_actions=actions)
    meta={k:v for k,v in p.metadata.items() if k!='records'}
    write(out/'data_audit.json',meta);write(out/'actions_snapshot.json',actions)
    source=(ROOT/'quant_system/own_daily.py').read_bytes();(out/'engine_snapshot.py').write_bytes(source)
    (out/'universe_snapshot.json').write_bytes((ROOT/'data/own_daily_v1'/(args.market+'_universe.json')).read_bytes())
    write(out/'experiment.json',dict(engine_sha256=hashlib.sha256(source).hexdigest(),configs=[asdict(c) for c in choices],
        action_sha256=hashlib.sha256((out/'actions_snapshot.json').read_bytes()).hexdigest(),
        protocol_sha256=hashlib.sha256((ROOT/'docs/OWN_DAILY_RESEARCH_V4.md').read_bytes()).hexdigest(),
        runtime=dict(python=platform.python_version(),numpy=np.__version__,pandas=pd.__version__),
        selection='development only; expanding annual selection uses preceding years only',strict_untouched_holdout=False))
    rows=[];curves={}
    def evaluate(name,c,extra=None,detail=False):
        opts={**kwargs,**(extra or {})};r,f,trades,decisions=run(p,c,details=detail,**opts)
        f.to_csv(out/(name+'_equity.csv'),index=False)
        if detail:
            pd.DataFrame(trades).to_csv(out/(name+'_trades.csv'),index=False);write(out/(name+'_decisions.json'),decisions)
        write(out/(name+'.json'),r)
        print(json.dumps(dict(market=args.market,case=name,cagr=r['full']['cagr'],drawdown=r['full']['max_drawdown'],unresolved=r['terminal_unresolved_value'])),flush=True)
        return r,f
    for c in choices:
        r,f=evaluate(c.name,c);rows.append(r);curves[c.name]=f;write(out/'trials.json',rows)
    winner=max(rows,key=selection_score);selected=next(c for c in choices if c.name==winner['config']['name'])
    main_result,_=evaluate('selected',selected,detail=True)
    old=json.loads((ROOT/'reports/own_daily_v1/SUMMARY.json').read_text(encoding='utf8'))['markets'][args.market]
    checks={}
    variants={'previous_strategy_corrected':Design(**old['selected_config']),
        'same_pool_equal_weight':replace(selected,name='same_pool_equal_weight',equal_benchmark=True),
        'no_liquidity_vol_filter':replace(selected,name='no_liquidity_vol_filter',liquidity_limit=1500,max_stock_vol=99.),
        'no_breadth_regime':replace(selected,name='no_breadth_regime',regime=False)}
    for name,c in variants.items():checks[name]=evaluate(name,c,detail=name=='previous_strategy_corrected')[0]
    for name,opts in {'double_cost':dict(cost_multiplier=2),'extra_day_delay':dict(execution_lag=2),
                      'zero_recovery_stress':dict(stale_writeoff=True,delisted_writeoff=True)}.items():
        checks[name]=evaluate(name,selected,opts)[0]
    if actions:checks['without_corporate_actions']=evaluate('without_corporate_actions',selected,dict(corporate_actions=[]))[0]
    schedule={};selection=[]
    for year in range(2021,2026):
        end=f'{year-1}-12-31'
        ranked=[(selection_score({'development':metrics(curves[c.name],end=end)}),c) for c in choices]
        score,c=max(ranked,key=lambda x:x[0]);date=str(p.dates[np.flatnonzero(p.dates>=f'{year}-01-01')[0]])
        schedule[date]=c;selection.append(dict(effective_date=date,training_end=end,config=asdict(c),score=score))
    write(out/'walk_forward_selection.json',selection)
    wf,_=evaluate('walk_forward',selected,dict(start='2021-01-01',design_schedule=schedule),detail=True)
    report=dict(selected=main_result,checks=checks,walk_forward=wf,trial_count=len(rows),numeric_pass_count=sum(r['full']['numeric_target'] for r in rows),
        verified_target=False,data_complete=False,data_audit=meta)
    write(out/'report.json',report)
if __name__=='__main__':main()
