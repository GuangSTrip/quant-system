from pathlib import Path
import json,sys,hashlib
from reproduce_own_alternatives import module
ROOT=Path(__file__).resolve().parents[1]
def main():
    folder=ROOT/'reports/own_alternatives/fundamental/CN';e=json.loads((folder/'experiment.json').read_text());r=json.loads((folder/'report.json').read_text())['selected']
    for name,h in e['hashes'].items():
        if hashlib.sha256((folder/name).read_bytes()).hexdigest()!=h:raise ValueError('snapshot changed')
    data=ROOT/'data/own_fundamental_cn_2014_2024'
    if hashlib.sha256((data/'manifest.json').read_bytes()).hexdigest()!=e['hashes']['financial_manifest.json']:raise ValueError('financial manifest changed')
    engine=module(folder/'engine_snapshot.py','frozen_finance_engine');selector=module(folder/'selector_snapshot.py','frozen_finance_selector')
    audit=json.loads((folder/'data_audit.json').read_text());price_root=ROOT/'data/own_daily_v1'
    for s,h in audit['source_hashes'].items():
        if hashlib.sha256((price_root/'CN'/(s+'.csv.gz')).read_bytes()).hexdigest()!=h:raise ValueError('price changed')
    p=engine.load(price_root,'CN',end='2024-12-31',only_symbols=set(audit['source_hashes']));p.metadata['records']={x['symbol']:x for x in json.loads((folder/'universe_snapshot.json').read_text())['records']}
    again,*_=engine.run(p,engine.Design(**r['config']),weights_fn=selector.make_selector(engine,p,data),stale_writeoff=False,delisted_writeoff=False)
    for period in ['full','development','validation','retrospective_final']:
        for key in ['cagr','max_drawdown','total_return','total_cost']:
            if abs(again[period][key]-r[period][key])>1e-7:raise ValueError('reproduction mismatch')
    print(json.dumps(dict(reproduced=True,full=again['full'])))
if __name__=='__main__':main()
