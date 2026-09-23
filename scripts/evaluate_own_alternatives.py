"""Compare different mechanisms with identical accounting and development rules."""
from pathlib import Path
from dataclasses import asdict
import argparse,json,sys,hashlib,platform
import pandas as pd
import numpy as np
ROOT=Path(__file__).resolve().parents[1];sys.path.insert(0,str(ROOT))
from quant_system import own_daily as engine
from quant_system.own_alternatives import prepare,make_selector
from evaluate_own_daily import write,selection_score

def main():
    ap=argparse.ArgumentParser();ap.add_argument('--market',required=True);a=ap.parse_args()
    out=ROOT/'reports/own_alternatives'/a.market;out.mkdir(parents=True,exist_ok=True)
    p=engine.load(ROOT/'data/own_daily_v1',a.market);prepare(p,engine);selector=make_selector(engine)
    families=['residual_reversal','recovery_reversal','distributed_trend','mechanism_mix']
    choices=[engine.Design(name=f'{family}_v{int(vol*100)}',family=family,target_vol=vol,liquidity_limit=500,max_stock_vol=.75,
        holdings=25,rebalance=5 if family in ['residual_reversal','mechanism_mix'] else 21,regime=False,diversify=False)
        for family in families for vol in [.14,.20]]
    prior=ROOT/'reports/own_daily_v4/risk'/a.market
    actions=json.loads((prior/'actions_snapshot.json').read_text())
    kwargs=dict(stale_writeoff=False,delisted_writeoff=False,corporate_actions=actions)
    meta={k:v for k,v in p.metadata.items() if k!='records'};write(out/'data_audit.json',meta);write(out/'actions_snapshot.json',actions)
    (out/'universe_snapshot.json').write_bytes((ROOT/'data/own_daily_v1'/(a.market+'_universe.json')).read_bytes())
    hashes={}
    for source,dest in [('quant_system/own_daily.py','engine_snapshot.py'),('quant_system/own_alternatives.py','selector_snapshot.py'),('docs/OWN_DAILY_ALTERNATIVES.md','protocol_snapshot.md')]:
        content=(ROOT/source).read_bytes();(out/dest).write_bytes(content);hashes[dest]=hashlib.sha256(content).hexdigest()
    hashes['actions_snapshot.json']=hashlib.sha256((out/'actions_snapshot.json').read_bytes()).hexdigest()
    write(out/'experiment.json',dict(hashes=hashes,configs=[asdict(c) for c in choices],runtime=dict(python=platform.python_version(),numpy=np.__version__,pandas=pd.__version__),strict_holdout=False))
    rows=[];returns={}
    def evaluate(name,c,custom=True,detail=False,extra=None):
        r,f,trades,decisions=engine.run(p,c,weights_fn=selector if custom else None,details=detail,**{**kwargs,**(extra or {})})
        f.to_csv(out/(name+'_equity.csv'),index=False)
        if detail:
            pd.DataFrame(trades).to_csv(out/(name+'_trades.csv'),index=False);write(out/(name+'_decisions.json'),decisions)
        write(out/(name+'.json'),r)
        print(json.dumps(dict(market=a.market,case=name,cagr=r['full']['cagr'],drawdown=r['full']['max_drawdown'],cost=r['full']['total_cost'])),flush=True)
        return r,f
    for c in choices:
        r,f=evaluate(c.name,c);rows.append(r);returns[c.name]=f.equity/f.base_equity-1;write(out/'trials.json',rows)
    winner=max(rows,key=selection_score);chosen=next(c for c in choices if c.name==winner['config']['name'])
    result,_=evaluate('selected',chosen,detail=True)
    old=engine.Design(**json.loads((prior/'report.json').read_text())['selected']['config'])
    baseline,_=evaluate('previous_strategy',old,custom=False,detail=True)
    checks={}
    for name,opts in {'double_cost':dict(cost_multiplier=2),'extra_day_delay':dict(execution_lag=2),
                      'zero_recovery_stress':dict(stale_writeoff=True,delisted_writeoff=True)}.items():
        checks[name]=evaluate(name,chosen,extra=opts)[0]
    corr=pd.DataFrame({k:v for k,v in returns.items() if k.endswith('_v14')}).corr();corr.to_csv(out/'mechanism_correlations.csv')
    report=dict(selected=result,previous=baseline,checks=checks,trial_count=len(rows),numeric_pass_count=sum(r['full']['numeric_target'] for r in rows),verified_target=False,data_audit=meta)
    write(out/'report.json',report)
if __name__=='__main__':main()
