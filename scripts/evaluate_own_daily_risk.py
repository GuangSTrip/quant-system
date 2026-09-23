from pathlib import Path
from dataclasses import replace
import argparse,json,sys,hashlib,itertools
import pandas as pd
ROOT=Path(__file__).resolve().parents[1];sys.path.insert(0,str(ROOT))
from quant_system.own_daily import Design,load,run
from evaluate_own_daily import write,selection_score

def main():
    ap=argparse.ArgumentParser();ap.add_argument('--market',required=True);ap.add_argument('--base-tag',default='');a=ap.parse_args()
    base=ROOT/'reports/own_daily_v4'/a.base_tag/a.market;out=ROOT/'reports/own_daily_v4/risk'/a.market;out.mkdir(parents=True,exist_ok=True)
    old=json.loads((base/'report.json').read_text());c=Design(**old['selected']['config']);p=load(ROOT/'data/own_daily_v1',a.market)
    actions=json.loads((base/'actions_snapshot.json').read_text());kwargs=dict(stale_writeoff=False,delisted_writeoff=False,corporate_actions=actions)
    source=(ROOT/'quant_system/own_daily.py').read_bytes();(out/'engine_snapshot.py').write_bytes(source)
    for name in ['actions_snapshot.json','universe_snapshot.json','data_audit.json']:(out/name).write_bytes((base/name).read_bytes())
    choices=[c]+[replace(c,name=f'account_stop{int(stop*100)}_pause{pause}',portfolio_stop=stop,portfolio_pause=pause) for stop,pause in itertools.product([.08,.12],[20,60])]
    write(out/'experiment.json',dict(engine_sha256=hashlib.sha256(source).hexdigest(),action_sha256=hashlib.sha256((out/'actions_snapshot.json').read_bytes()).hexdigest(),configs=[x.__dict__ for x in choices],base=str(base.relative_to(ROOT)),adaptive_research=True))
    rows=[]
    for config in choices:
        r,f,_,_=run(p,config,**kwargs);rows.append(r);f.to_csv(out/(config.name+'_equity.csv'),index=False);write(out/'trials.json',rows)
        print(json.dumps(dict(market=a.market,case=config.name,cagr=r['full']['cagr'],drawdown=r['full']['max_drawdown'])),flush=True)
    best=max(rows,key=selection_score);selected=next(x for x in choices if x.name==best['config']['name'])
    r,f,trades,decisions=run(p,selected,details=True,**kwargs)
    f.to_csv(out/'selected_equity.csv',index=False);pd.DataFrame(trades).to_csv(out/'selected_trades.csv',index=False);write(out/'selected_decisions.json',decisions)
    checks={}
    for name,opts in {'double_cost':dict(cost_multiplier=2),'extra_day_delay':dict(execution_lag=2),'zero_recovery_stress':dict(stale_writeoff=True,delisted_writeoff=True)}.items():
        checks[name]=run(p,selected,**{**kwargs,**opts})[0]
    write(out/'report.json',dict(selected=r,checks=checks,base_config=c.__dict__,trial_count=4,baseline_repeated=True,verified_target=False))
    print(json.dumps(dict(market=a.market,selected=selected.name,full=r['full'])),flush=True)
if __name__=='__main__':main()
