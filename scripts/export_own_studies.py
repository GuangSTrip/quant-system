"""Publish selected offline research evidence, never credentials or raw vendor caches.

Run with --research-root pointing to the machine holding reports/. Existing frozen
exports remain usable when the private research inputs are unavailable.
"""
import argparse, csv, hashlib, json, math
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
FAMILIES = {'daily': '日线选股与风险控制', 'alternatives': '反转与趋势多机制', 'fundamental': 'A股盈利质量与估值'}
def read(p): return json.loads(p.read_text(encoding='utf-8'))
def safe(value):
    if isinstance(value, float) and not math.isfinite(value): return None
    if isinstance(value, dict): return {k:safe(v) for k,v in value.items()}
    if isinstance(value, list): return [safe(v) for v in value]
    return value
def save(p, data): p.write_text(json.dumps(safe(data),ensure_ascii=False,separators=(',',':'),allow_nan=False)+'\n',encoding='utf-8')
def rows(p):
    with p.open(encoding='utf-8-sig',newline='') as f:
        result=list(csv.DictReader(f))
    for row in result:
        for key,value in row.items():
            if key not in {'date','base_date','symbol','side','signal_date'}:
                try: row[key]=float(value)
                except (TypeError,ValueError): pass
    return result
def metrics(r):
    keys=['config','full','development','validation','retrospective_final','trade_count','cost_breakdown','verified_target','data_complete','terminal_unresolved_value','terminal_fee_reserve','attribution_error','cost_multiplier','execution_lag']
    return {k:r[k] for k in keys if k in r}
def main():
    parser=argparse.ArgumentParser();parser.add_argument('--research-root',type=Path,default=ROOT);args=parser.parse_args()
    out=ROOT/'web_platform/src/own-research';out.mkdir(exist_ok=True)
    manifest={'schema':1,'capital':1000000,'status':'research_only','selection_rule':'仅按截至2020年的开发期评分选定主候选；后续年份已在研究中观察，不是独立样本外验证。','studies':[]}
    specs=[]
    for market in ['CN','HK','US']:
        base='expanded/US' if market=='US' else market
        specs.extend([(market,'daily','base',f'reports/own_daily_v4/{base}'),(market,'daily','risk',f'reports/own_daily_v4/risk/{market}'),(market,'alternatives','v5',f'reports/own_alternatives/{market}')])
    specs.append(('CN','fundamental','v1','reports/own_alternatives/fundamental/CN'))
    for market,family,version,folder in specs:
        source=args.research_root/folder; report=read(source/'report.json'); selected=report['selected']
        sid=f'{market}-{family}-{version}'
        data={'schema':1,'id':sid,'family':family,'version':version,'market':market,'currency':{'CN':'CNY','HK':'HKD','US':'USD'}[market],
              'name':FAMILIES[family],'execution':'research_only','capital':1000000,'selected':metrics(selected),
              'equity':rows(source/'selected_equity.csv'),'trades':rows(source/'selected_trades.csv'),
              'decisions':read(source/'selected_decisions.json'),'trials':[metrics(x) for x in read(source/'trials.json')],
              'checks':{k:metrics(v) for k,v in report.get('checks',{}).items() if isinstance(v,dict) and 'full' in v},
              'source':folder,'source_hashes':{name:hashlib.sha256((source/name).read_bytes()).hexdigest() for name in ['selected_equity.csv','selected_trades.csv','selected_decisions.json','report.json','trials.json']}}
        # Data-access details and provider credentials are never copied to the export.
        data['decisions']=[{k:v for k,v in d.items() if k in {'date','execute_on','eligible','breadth','selected','exposure','stop_symbols','portfolio_risk_off','snapshot'}} for d in data['decisions']]
        data['history']=[]
        if family=='daily':
            for old in ['final_v1','final_v2','final_v3']:
                p=args.research_root/f'reports/own_daily_v1/{old}/{market}/report.json'
                if p.exists():
                    previous=read(p); data['history'].append({'version':old,**metrics(previous.get('selected',previous))})
        path=f'/own-study-{sid}.json';save(out/(sid+'.json'),data)
        manifest['studies'].append({k:data[k] for k in ['id','family','version','market','currency','name','execution','capital','selected']}|{'path':path,'bytes':(out/(sid+'.json')).stat().st_size,'trade_count':len(data['trades']),'decision_count':len(data['decisions'])})
    save(out/'manifest.json',manifest)
    imports=["import manifest from './own-research/manifest.json';"]
    paths=["'/own-studies.json':manifest"]
    for i,s in enumerate(manifest['studies']):
        imports.append(f"import study{i} from './own-research/{s['id']}.json';")
        paths.append(f"'{s['path']}':study{i}")
    (ROOT/'web_platform/src/own-research-assets.mjs').write_text('\n'.join(imports)+'\nexport const OWN_RESEARCH_ASSETS={'+','.join(paths)+'};\n',encoding='utf-8')
    print(json.dumps({'studies':len(specs),'bytes':sum(s['bytes'] for s in manifest['studies'])}))
if __name__=='__main__': main()
