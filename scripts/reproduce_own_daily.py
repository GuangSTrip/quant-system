"""Reproduce selected metrics with frozen engine and exact symbol/data hashes."""
import argparse,importlib.util,json,sys,hashlib
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
p=argparse.ArgumentParser();p.add_argument('report_dir',type=Path);args=p.parse_args();folder=args.report_dir
r=json.loads((folder/'report.json').read_text(encoding='utf8'));experiment=json.loads((folder/'experiment.json').read_text(encoding='utf8'))
v4='selected' in r
audit=r.get('data_audit')
if v4:
    r=r['selected']
    if audit is None:audit=json.loads((folder/'data_audit.json').read_text(encoding='utf8'))
else:audit=r['data_audit']
source=folder/'engine_snapshot.py'
if hashlib.sha256(source.read_bytes()).hexdigest()!=experiment['engine_sha256']:raise ValueError('engine snapshot hash mismatch')
spec=importlib.util.spec_from_file_location('frozen_own_daily_engine',source);module=importlib.util.module_from_spec(spec);sys.modules[spec.name]=module;spec.loader.exec_module(module)
market=folder.name;data=ROOT/'data'/'own_daily_v1';hashes=audit['source_hashes']
for s,h in hashes.items():
    if hashlib.sha256((data/market/(s+'.csv.gz')).read_bytes()).hexdigest()!=h:raise ValueError('input data changed: '+s)
panel=module.load(data,market,only_symbols=set(hashes))
panel.metadata['records']={x['symbol']:x for x in json.loads((folder/'universe_snapshot.json').read_text(encoding='utf8'))['records']}
kwargs={}
if v4:
    actions_file=folder/'actions_snapshot.json'
    if experiment.get('action_sha256') and hashlib.sha256(actions_file.read_bytes()).hexdigest()!=experiment['action_sha256']:raise ValueError('action snapshot hash mismatch')
    kwargs=dict(stale_writeoff=False,delisted_writeoff=False,corporate_actions=json.loads(actions_file.read_text()))
again,_,_,_=module.run(panel,module.Design(**r['config']),**kwargs)
for period in ['full','development','validation','retrospective_final']:
    for key in ['cagr','total_return','max_drawdown','total_cost']:
        if abs(again[period][key]-r[period][key])>1e-7:raise AssertionError((period,key,again[period][key],r[period][key]))
print(json.dumps({'reproduced':True,'market':market,'engine_sha256':experiment['engine_sha256'],'histories':len(hashes),'full':again['full']}))
