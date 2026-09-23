"""Read-only cached data audit; optional independent public-source overlap check."""
from pathlib import Path
import argparse,json,collections,hashlib
import pandas as pd
from own_daily_data import OUT,ROOT,save_json,yahoo_history,safe_error

def main():
    p=argparse.ArgumentParser();p.add_argument('--overlap',action='store_true');args=p.parse_args();report={}
    previous=ROOT/'reports'/'own_daily_v1'/'DATA_AUDIT.json'
    if previous.exists():
        old=json.loads(previous.read_text(encoding='utf8'))
        if old.get('HK_source_overlap'):report['HK_source_overlap']=old['HK_source_overlap']
    for market in ['CN','HK','US']:
        manifest=json.loads((OUT/(market+'_manifest.json')).read_text());master=json.loads((OUT/(market+'_universe.json')).read_text())
        counts=collections.Counter(x['status'] for x in manifest.values());sources=collections.Counter(x.get('provider') for x in manifest.values() if x['status']=='ok')
        issues=[];bytes_total=0;coverage={};hash_errors=[]
        for s,row in manifest.items():
            if row['status']!='ok':continue
            path=OUT/market/(s+'.csv.gz');bytes_total+=path.stat().st_size
            if hashlib.sha256(path.read_bytes()).hexdigest()!=row['sha256']:hash_errors.append(s)
            f=pd.read_csv(path)
            invalid=(f[['open','high','low','close']]<=0).any(axis=1)|(f.high+1e-7<f[['open','low','close']].max(axis=1))|(f.low-1e-7>f[['open','high','close']].min(axis=1))
            jumps=f.close.pct_change().abs()>.5
            if invalid.any() or jumps.any():issues.append(dict(symbol=s,invalid_bars=int(invalid.sum()),moves_over_50pct=int(jumps.sum())))
            for year in range(2014,2026):
                n=int(f.date.str.startswith(str(year)).sum())
                c=coverage.setdefault(str(year),dict(any_history=0,at_least_200_bars=0))
                c['any_history']+=int(n>0);c['at_least_200_bars']+=int(n>=200)
        relevant={r['symbol'] for r in master['records'] if not r.get('listed') or r['listed']<='2025-12-31'}
        report[market]=dict(initial_master=len(master['records']),eligible_history_universe=len(relevant),outside_study_listing_date=len(master['records'])-len(relevant),attempted=len(manifest),counts=dict(counts),sources=dict(sources),
            not_attempted=len(relevant-set(manifest)),compressed_bytes=bytes_total,
            yearly_coverage=coverage,quality_issues=issues,hash_errors=hash_errors,historical_complete=False,
            failures={s:r for s,r in manifest.items() if r['status']=='failed'})
    if args.overlap:
        manifest=json.loads((OUT/'HK_manifest.json').read_text());checks=[]
        for s,r in [(s,r) for s,r in manifest.items() if r.get('provider')=='Longbridge' and r.get('rows',0)>1500][:3]:
            try:
                a=pd.read_csv(OUT/'HK'/(s+'.csv.gz')).set_index('date').close
                b=yahoo_history(s,'HK','2014-01-01','2025-12-31').set_index('date').close
                aligned=pd.concat([a.rename('longbridge'),b.rename('yahoo')],axis=1).dropna()
                diff=aligned.pct_change().dropna().diff(axis=1).iloc[:,1].abs()
                checks.append(dict(symbol=s,overlap=len(aligned),median_return_difference=float(diff.median()),max_return_difference=float(diff.max()),days_difference_over_1pct=int((diff>.01).sum())))
            except Exception as e:checks.append(dict(symbol=s,error=safe_error(e)))
        report['HK_source_overlap']=checks
    save_json(ROOT/'reports'/'own_daily_v1'/'DATA_AUDIT.json',report)
    print(json.dumps({m:{k:v for k,v in r.items() if k in ['counts','sources','initial_master','attempted','not_attempted','compressed_bytes']} for m,r in report.items() if isinstance(r,dict)},ensure_ascii=False))

if __name__=='__main__':main()
