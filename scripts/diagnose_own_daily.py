"""Trace economic loss causes without using diagnostic future data in signals."""
from pathlib import Path
import argparse,json,sys
import numpy as np
import pandas as pd
ROOT=Path(__file__).resolve().parents[1];sys.path.insert(0,str(ROOT))
from quant_system.own_daily import Design,load,run
from evaluate_own_daily import write

def main():
    ap=argparse.ArgumentParser();ap.add_argument('--market',required=True);a=ap.parse_args()
    out=ROOT/'reports/own_daily_v4'/a.market;out.mkdir(parents=True,exist_ok=True)
    old=json.loads((ROOT/'reports/own_daily_v1/SUMMARY.json').read_text(encoding='utf8'))['markets'][a.market]
    p=load(ROOT/'data/own_daily_v1',a.market);c=Design(**old['selected_config'])
    report={}
    for name,kw in [('legacy',{}),('mark_unresolved',dict(stale_writeoff=False,delisted_writeoff=False))]:
        r,f,trades,decisions=run(p,c,details=True,**kw)
        if name=='legacy':
            for e in r['writeoff_events']:
                i=p.symbols.index(e['symbol']);future=np.flatnonzero((p.dates>e['date'])&np.isfinite(p.closes[:,i])&(p.volume[:,i]>0))
                e['later_valid_bar']=str(p.dates[future[0]]) if len(future) else None
            r['writeoff_later_resumes']=sum(e['amount'] for e in r['writeoff_events'] if e['later_valid_bar'])
        f.to_csv(out/(name+'_equity.csv'),index=False)
        pd.DataFrame(trades).to_csv(out/(name+'_trades.csv'),index=False)
        write(out/(name+'.json'),r)
        report[name]={k:r[k] for k in ['full','development','validation','retrospective_final','stale_or_delisted_writeoff','terminal_unresolved_value','attribution_error']}
        report[name]['worst_symbols']=r['symbol_attribution'][:15]
        if name=='legacy':report[name]['writeoff_later_resumes']=r['writeoff_later_resumes']
        print(json.dumps(dict(market=a.market,case=name,**report[name])),flush=True)
    write(out/'diagnosis.json',report)
if __name__=='__main__':main()
