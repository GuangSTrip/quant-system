"""Replay every registered strategy from available original caches, never publish signals/orders.

A missing market is reported as blocked; a smaller replacement universe is never
presented as reproduction of the original full-universe report.
"""
import argparse
import hashlib
import json
from pathlib import Path
from evaluate_modular_daily import ROOT, START, prepare, simulate
from portfolio_signal import catalog, VERSION
from refine_daily_research import china_selection, CN_NAMES


def replay(study, strategy_id, config):
    trace=[]
    result=simulate(study,**{k:v for k,v in config.items() if k!='market'},trace=trace)
    decisions=[{'t':e['date'],'rebalanced':bool(e['rebalanced']),'cash':e['cash'],'holdings':e['holdings'],
                'reason':'收盘重算目标；下一交易日开盘执行' if e['rebalanced'] else '沿用目标；未发出新调仓指令',
                'targets':[{'symbol':s,'weight':float(w)} for s,w in e['state']['target'].items() if w>0]} for e in trace]
    trades=[t for e in trace for t in e['trades']]
    digest=hashlib.sha256()
    digest.update(json.dumps({'dates':study.panel.dates,'symbols':study.panel.symbols,'config':config},sort_keys=True).encode())
    for a in [study.panel.opens,study.panel.closes,study.panel.volumes,study.panel.turnover]:digest.update(a.tobytes())
    return {'config':config,'dates':study.panel.dates[START:],
            'signal':{'strategy_id':strategy_id,'strategy_version':VERSION,'data_digest':digest.hexdigest()},
            'backtest':{**result,'decisions':decisions,'trades':trades},
            'note':'Historical research archive only; incomplete signal envelope cannot authorize execution. Adjusted fractional units.'}


def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--markets',nargs='+',choices=['US','HK','CN'],default=['US','HK','CN'])
    p.add_argument('--end-date',default='2026-09-17')
    p.add_argument('--output',type=Path,default=ROOT/'reports/portfolio_archive')
    args=p.parse_args();args.output.mkdir(parents=True,exist_ok=True)
    manifest={'completed':[],'blocked':[],'mode':'research_only_no_orders'}
    entries=catalog()
    for market in args.markets:
        try:
            study=prepare(market,end_date=args.end_date)
            if market=='CN':china_selection(study)
        except (FileNotFoundError,ValueError,RuntimeError) as e:
            manifest['blocked'].append({'market':market,'reason':str(e),'strategies':sum(c['market']==market for c in entries.values())})
            continue
        for key,config in entries.items():
            if config['market']!=market:continue
            output=replay(study,key,config);path=args.output/(key.replace(':','_')+'.json')
            path.write_text(json.dumps(output,ensure_ascii=False,allow_nan=False,separators=(',',':')))
            manifest['completed'].append({'strategy_id':key,'file':path.name,'rows':len(output['dates']),'trades':len(output['backtest']['trades'])})
    (args.output/'manifest.json').write_text(json.dumps(manifest,ensure_ascii=False,indent=2))
    print(json.dumps(manifest,ensure_ascii=False,indent=2))
    return 2 if manifest['blocked'] else 0

if __name__=='__main__':raise SystemExit(main())
