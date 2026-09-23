from pathlib import Path
import json,sys,hashlib
import pandas as pd
ROOT=Path(__file__).resolve().parents[1];sys.path.insert(0,str(ROOT))
from quant_system import own_daily as engine
from quant_system.own_fundamental import make_selector
from evaluate_own_daily import write,selection_score
def main():
    out=ROOT/'reports/own_alternatives/fundamental/CN';out.mkdir(parents=True,exist_ok=True)
    data=ROOT/'data/own_fundamental_cn_2014_2024'
    collection=json.loads((data/'collection.json').read_text())
    if not collection['complete']:raise ValueError('financial collection incomplete')
    p=engine.load(ROOT/'data/own_daily_v1','CN',end='2024-12-31');selector=make_selector(engine,p,data)
    choices=[engine.Design(name=f'{family}_regime{int(regime)}',family=family,holdings=25,target_vol=.18,liquidity_limit=1500,max_stock_vol=.75,rebalance=21,regime=regime,diversify=False)
        for family in ['fundamental_quality','fundamental_value_quality'] for regime in [False,True]]
    hashes={}
    for name in ['collection.json','retrieval_gaps.json']:
        if (data/name).exists():
            b=(data/name).read_bytes();(out/name).write_bytes(b);hashes[name]=hashlib.sha256(b).hexdigest()
    for src,name in [('quant_system/own_daily.py','engine_snapshot.py'),('quant_system/own_fundamental.py','selector_snapshot.py'),('docs/OWN_FUNDAMENTAL_CN.md','protocol_snapshot.md'),('data/own_fundamental_cn_2014_2024/manifest.json','financial_manifest.json'),('data/own_daily_v1/CN_universe.json','universe_snapshot.json')]:
        b=(ROOT/src).read_bytes();(out/name).write_bytes(b);hashes[name]=hashlib.sha256(b).hexdigest()
    write(out/'experiment.json',dict(hashes=hashes,configs=[c.__dict__ for c in choices],strict_holdout=False));write(out/'data_audit.json',{k:v for k,v in p.metadata.items() if k!='records'})
    kwargs=dict(stale_writeoff=False,delisted_writeoff=False)
    rows=[]
    def evaluate(name,c,extra=None,detail=False,custom=True):
        r,f,trades,decisions=engine.run(p,c,weights_fn=selector if custom else None,details=detail,**{**kwargs,**(extra or {})})
        f.to_csv(out/(name+'_equity.csv'),index=False);write(out/(name+'.json'),r)
        if detail:
            pd.DataFrame(trades).to_csv(out/(name+'_trades.csv'),index=False);write(out/(name+'_decisions.json'),decisions)
        print(json.dumps(dict(case=name,cagr=r['full']['cagr'],drawdown=r['full']['max_drawdown'],cost=r['full']['total_cost'])),flush=True)
        return r
    for c in choices:rows.append(evaluate(c.name,c));write(out/'trials.json',rows)
    best=max(rows,key=selection_score);chosen=next(c for c in choices if c.name==best['config']['name']);result=evaluate('selected',chosen,detail=True)
    previous=json.loads((ROOT/'reports/own_daily_v4/risk/CN/report.json').read_text())['selected'];baseline=evaluate('previous_strategy',engine.Design(**previous['config']),custom=False)
    checks={name:evaluate(name,chosen,opts) for name,opts in {'double_cost':dict(cost_multiplier=2),'extra_day_delay':dict(execution_lag=2),'zero_recovery_stress':dict(stale_writeoff=True,delisted_writeoff=True)}.items()}
    write(out/'report.json',dict(selected=result,previous=baseline,checks=checks,trial_count=len(rows),numeric_pass_count=sum(r['full']['numeric_target'] for r in rows),verified_target=False))
if __name__=='__main__':main()
