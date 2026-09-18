"""Bounded history collection for modular course research. No broker access."""
from __future__ import annotations
import argparse, hashlib, json, re, time
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
import numpy as np
import pandas as pd
import requests
import tushare as ts
from fetch_daily_strategy_data import ROOT, token

OUT=ROOT/'data'/'modular_daily'
MAX_BYTES=1_000_000_000

def storage_size():
    return sum(p.stat().st_size for p in (ROOT/'data').rglob('*') if p.is_file())

def universe(market):
    if market=='HK':
        rows=json.loads((ROOT/'data'/'universe_access.json').read_text(encoding='utf8'))['lists']['HK_listed']
        return sorted({r['ts_code'] for r in rows if str(r.get('list_date',''))<'20240101'
                       and r.get('curr_type')=='HKD' and r['ts_code'][:5].isdigit() and int(r['ts_code'][:5])<10000})
    folder=ROOT/'data'/'international_universe'
    frames=[pd.read_csv(folder/'nasdaqlisted.txt',sep='|').rename(columns={'Symbol':'symbol'}),
            pd.read_csv(folder/'otherlisted.txt',sep='|').rename(columns={'ACT Symbol':'symbol'})]
    result=set()
    for f in frames:
        f=f[(f['Test Issue']=='N') & (f['ETF']=='N')]
        for s,name in zip(f.symbol,f['Security Name']):
            if isinstance(s,str) and re.fullmatch('[A-Z]{1,5}',s) and not re.search('warrant|preferred|rights|units|debenture',str(name),re.I):
                result.add(s)
    return sorted(result)

def international_one(market,symbol):
    path=OUT/market/(symbol+'.csv.gz'); path.parent.mkdir(exist_ok=True,parents=True)
    if path.exists(): return {'symbol':symbol,'status':'cached'}
    import akshare as ak
    started=time.monotonic()
    try:
        # Sina is the documented AkShare alternative to Eastmoney/Yahoo.
        if market=='HK': f=ak.stock_hk_daily(symbol=symbol[:5],adjust='qfq')
        else: f=ak.stock_us_daily(symbol=symbol,adjust='qfq')
        f=f.rename(columns={'index':'date'})
        f['date']=pd.to_datetime(f['date']).dt.strftime('%Y-%m-%d')
        f=f[(f.date>='2024-01-01') & (f.date<='2026-09-17')].sort_values('date')
        need=['date','open','high','low','close','volume']
        f=f[need].dropna()
        if len(f)<400 or f.date.duplicated().any() or (f[['open','close']]<=0).any().any():
            raise ValueError(f'insufficient/invalid history: {len(f)}')
        # Reject unhandled splits/bad factor data rather than reporting extreme artificial profits.
        if f.close.pct_change().abs().max()>.65: raise ValueError('unexplained adjusted one-day move >65%')
        f.to_csv(path,index=False,compression='gzip')
        return {'symbol':symbol,'status':'ok','rows':len(f),'from':f.date.iloc[0],'to':f.date.iloc[-1],
                'seconds':round(time.monotonic()-started,2),'bytes':path.stat().st_size}
    except Exception as exc:
        return {'symbol':symbol,'status':'failed','error':str(exc)[:140],'seconds':round(time.monotonic()-started,2)}

def cn_fundamentals():
    api=ts.pro_api(token(),timeout=15)
    folder=OUT/'CN_basic'; folder.mkdir(parents=True,exist_ok=True)
    dates=sorted(p.name[:8] for p in (ROOT/'data'/'point_in_time_cn').glob('*.csv.gz'))
    # One historical snapshot per calendar month, consumed only on/after its own date.
    months={d[:6]:d for d in dates}
    for day in months.values():
        path=folder/(day+'.csv.gz')
        if path.exists(): continue
        f=api.daily_basic(trade_date=day,fields='ts_code,trade_date,pe_ttm,pb,dv_ttm,total_mv')
        if len(f)<1000: raise ValueError('incomplete historical fundamental snapshot')
        f.to_csv(path,index=False,compression='gzip')
        print('CN fundamental',day,len(f),flush=True)

if __name__=='__main__':
    parser=argparse.ArgumentParser(); parser.add_argument('--market',choices=['CN','HK','US'],required=True)
    parser.add_argument('--count',type=int,default=120); args=parser.parse_args()
    if storage_size()>MAX_BYTES-20_000_000: raise RuntimeError('Cache near 1 GB; user decision required')
    if args.market=='CN': cn_fundamentals(); raise SystemExit(0)
    # Stable code hash chooses a reproducible broad sample, unrelated to historical performance.
    symbols=universe(args.market)
    picked=sorted(symbols,key=lambda s:hashlib.sha256(('course-v2-'+s).encode()).hexdigest())[:args.count]
    OUT.mkdir(exist_ok=True,parents=True)
    snapshot={'market':args.market,'listed_candidates':len(symbols),'requested':len(picked),
              'method':'deterministic hash sample of current exchange list; NOT historical full-market membership',
              'source':'AkShare / Sina adjusted daily','checked_at':datetime.now(timezone.utc).isoformat(),
              'results':[]}
    print(args.market,'listed',len(symbols),'requested',len(picked),flush=True)
    original_get=requests.get
    def bounded_get(*a,**kw): kw.setdefault('timeout',9); return original_get(*a,**kw)
    requests.get=bounded_get
    # Initialize the embedded decoder once on the main thread before workers start.
    import akshare as ak
    decoder_bootstrap=ak.stock_hk_daily.__globals__['MiniRacer']()
    decoder_bootstrap.eval('1 + 1')
    with ThreadPoolExecutor(max_workers=3) as pool:
        for future in as_completed([pool.submit(international_one,args.market,s) for s in picked]):
            result=future.result(); snapshot['results'].append(result)
            if len(snapshot['results'])%10==0:
                good=sum(r['status']!='failed' for r in snapshot['results'])
                print(args.market,'done',len(snapshot['results']),'accepted',good,flush=True)
            (OUT/(args.market+'_manifest.json')).write_text(json.dumps(snapshot,ensure_ascii=False,indent=2),encoding='utf8')
    print(args.market,'complete',sum(r['status']!='failed' for r in snapshot['results']),flush=True)
