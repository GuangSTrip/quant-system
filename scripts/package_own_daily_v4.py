"""Package only explicitly scoped research files, excluding private configuration."""
from pathlib import Path
import hashlib,json,zipfile
ROOT=Path(__file__).resolve().parents[1];OUT=ROOT/'reports/own_daily_v4'
def main():
    validation={'tests':{'ran':93,'passed':92,'skipped':1,'failed':0,'own_daily_passed':15,
        'command':'.venv-data/Scripts/python.exe -X utf8 -W ignore::DeprecationWarning -m unittest discover -s tests -q',
        'initial_run_note':'Default Windows GBK decoding caused 4 unrelated catalog-read errors; rerun with project UTF-8 mode passed.'},
        'verified_target':False,'reproductions':{},'frozen_sources_checked':0,'fees_reconciled':True}
    for m in ['CN','HK','US']:
        validation['reproductions'][m]=json.loads((OUT/f'reproduction_{m}.json').read_text(encoding='utf-8-sig'))
        if not validation['reproductions'][m]['reproduced']:raise ValueError('reproduction failed')
    for f in OUT.rglob('experiment.json'):
        e=json.loads(f.read_text());source=f.parent/'engine_snapshot.py'
        if hashlib.sha256(source.read_bytes()).hexdigest()!=e['engine_sha256']:raise ValueError('snapshot hash failed')
        if e.get('action_sha256') and hashlib.sha256((f.parent/'actions_snapshot.json').read_bytes()).hexdigest()!=e['action_sha256']:raise ValueError('action hash failed')
        validation['frozen_sources_checked']+=1
    for m in ['CN','HK','US']:
        r=json.loads((OUT/'risk'/m/'report.json').read_text())['selected']
        for key in ['cagr','max_drawdown','total_return','total_cost']:
            if abs(r['full'][key]-validation['reproductions'][m]['full'][key])>1e-7:raise ValueError('stale reproduction report')
        if abs(r['full']['total_cost']-sum(r['cost_breakdown'].values()))>1e-6:raise ValueError('cost mismatch')
        if abs(r['attribution_error'])>1e-5:raise ValueError('attribution mismatch')
    fills=json.loads((OUT/'FILL_AUDIT.json').read_text())
    if any(x['invalid_fills'] for x in fills):raise ValueError('invalid fills remain')
    validation['audited_fills']=sum(x['trades'] for x in fills)
    (OUT/'VALIDATION.json').write_text(json.dumps(validation,ensure_ascii=False,indent=2),encoding='utf8')
    files=[ROOT/'quant_system/own_daily.py',ROOT/'tests/test_own_daily.py']
    names=['run_own_daily_research.mjs','own_daily_data.py','own_daily_actions.py','evaluate_own_daily.py','evaluate_own_daily_v4.py','evaluate_own_daily_risk.py',
           'diagnose_own_daily.py','benchmark_own_daily.py','audit_own_daily_fills.py','reproduce_own_daily.py','report_own_daily.py','report_own_daily_v4.py','package_own_daily_v4.py',
           'portfolio_providers.py','myquant_data.py']
    files += [ROOT/'scripts'/n for n in names]
    files += list((ROOT/'docs').glob('OWN_DAILY*.md'))
    files += [p for p in OUT.rglob('*') if p.is_file() and '__pycache__' not in p.parts]
    files += [p for p in (ROOT/'data/own_daily_v4').rglob('*') if p.is_file()]
    archive=ROOT.parent/'自研日线策略第四轮优化-20260922.zip'
    note='第四轮增量研究包。阅读 reports/own_daily_v4/RESEARCH_REPORT.md。含源代码、协议、冻结实验、公开公司行动记录和SPY基准；不含凭证或完整历史行情。复现依赖原项目和 data/own_daily_v1 本地缓存，命令见报告。旧报告与旧交付包保留。本轮尚未达到20%年化/15%回撤目标。'
    with zipfile.ZipFile(archive,'w',zipfile.ZIP_DEFLATED) as z:
        z.writestr('README.txt',note)
        for p in sorted(set(files)):
            relative=p.relative_to(ROOT)
            if any(x.startswith('.env') or x in ['.dev.vars','.lan','.wrangler'] for x in relative.parts):raise ValueError('private path')
            z.write(p,relative.as_posix())
    with zipfile.ZipFile(archive) as z:
        if z.testzip():raise ValueError('zip integrity failed')
        count=len(z.namelist())
    result=dict(file=str(archive),files=count,bytes=archive.stat().st_size,sha256=hashlib.sha256(archive.read_bytes()).hexdigest())
    print(json.dumps(result,ensure_ascii=False))
if __name__=='__main__':main()
