"""Persistent read-only producer: update data, replay strategies, publish signals/quotes.

Run separately from the website Worker. Never sends orders or starts strategies.
A process supervisor should restart on failure. --once is useful for verification.
"""
from __future__ import annotations
import argparse
import hashlib
import json
import os
import re
import tempfile
import time
from datetime import datetime,timezone
from pathlib import Path
import numpy as np
from portfolio_signal import Publisher,catalog,produce,VERSION
from portfolio_providers import PROVIDERS,session_from_calendar,fresh_quotes
from myquant_data import MyQuantData
from refine_daily_research import china_selection
PROVIDERS["myquant"]=MyQuantData
from evaluate_modular_daily import prepare,ROOT


def refresh(provider,symbols,session,folder):
    frames=provider.histories(symbols,session['signal_date'])
    if set(frames)!=set(symbols):raise ValueError('Incomplete universe from provider')
    market=provider.market
    target=folder/market;target.mkdir(parents=True,exist_ok=True)
    for symbol,frame in frames.items():
        required=['open','high','low','close','volume']
        if frame.empty or not set(['date',*required])<=set(frame):raise ValueError('Missing history: '+symbol)
        if frame.date.duplicated().any() or frame.date.tolist()!=sorted(frame.date) or frame.date.iloc[-1]!=session['signal_date']:
            raise ValueError('Missing, duplicate or unordered daily session: '+symbol)
        if not np.isfinite(frame[required].to_numpy(float)).all() or (frame[['open','high','low','close']]<=0).any().any() or (frame.volume<0).any():raise ValueError('Invalid OHLCV')
        if (frame.high<frame[['open','close','low']].max(axis=1)).any() or (frame.low>frame[['open','close','high']].min(axis=1)).any():raise ValueError('Invalid OHLC relationship: '+symbol+' '+str(frame.loc[(frame.high<frame[["open","close","low"]].max(axis=1)) | (frame.low>frame[["open","close","high"]].min(axis=1)),['date',*required]].head(1).to_dict('records')))
    # No publication before every symbol is validated. Temporary directory isolates partial downloads.
    for symbol,frame in frames.items():frame.to_csv(target/(symbol+'.csv.gz'),index=False,compression='gzip')
    (folder/(market+'_manifest.json')).write_text(json.dumps({'listed_candidates':len(symbols),'requested':len(symbols),'source':type(provider).__name__}))


def run_once(config,providers,publisher,state):
    entries=catalog();now=datetime.now(timezone.utc)
    for market,options in config['markets'].items():
        provider=providers[market];calendar=provider.calendar(now);session=session_from_calendar(calendar,now)
        if datetime.fromisoformat(session['expires_at'].replace('Z','+00:00'))<=now:
            continue  # final bar publication grace period; no stale signal upload
        symbols=options['symbols']
        pattern=r'[A-Z][A-Z0-9.-]{0,14}' if market=='US' else r'[1-9][0-9]{0,4}\.HK' if market=='HK' else r'\d{6}\.(SH|SZ)'
        if any(not re.fullmatch(pattern,s) for s in symbols):raise ValueError('Invalid provider security id')
        if len(symbols)<30 or len(set(symbols))!=len(symbols):raise ValueError('Each fixed universe requires at least 30 unique symbols')
        fingerprint=hashlib.sha256(json.dumps(symbols,sort_keys=True).encode()).hexdigest()
        key=market+':'+session['signal_date']+':'+fingerprint
        ids=options.get('strategies','all')
        if ids=='all':ids=[k for k,v in entries.items() if v['market']==market]
        if not ids or any(i not in entries or entries[i]['market']!=market for i in ids):raise ValueError('Invalid registered strategy ids')
        # Keep live quotes available even when a historical signal is rejected.
        if market in ('HK','CN'):
            needed=sorted(set(symbols+publisher.get('portfolio').get('quote_symbols',{}).get(market,[])))
            quote=provider.quotes(needed,datetime.now(timezone.utc),calendar)
            if quote:publisher.post('portfolio/quotes',fresh_quotes(quote,datetime.now(timezone.utc)))
        if state.get(market)!=key:
            # Frozen per-session artifacts survive restarts and provider historical revisions.
            saved=ROOT/'.paper_state'/'portfolio-signals'/hashlib.sha256((key+VERSION).encode()).hexdigest()
            saved.mkdir(parents=True,exist_ok=True)
            paths={i:saved/(hashlib.sha256(i.encode()).hexdigest()+'.json') for i in ids}
            missing=[i for i in ids if not paths[i].exists()]
            if missing:
                with tempfile.TemporaryDirectory(prefix='portfolio-data-',dir=ROOT/'.paper_state') as temp:
                    folder=Path(temp);refresh(provider,symbols,session,folder)
                    if market=='CN':provider.fundamentals(symbols,session['signal_date'],folder)
                    study=prepare(market,end_date=session['signal_date'],data_root=folder)
                    if market=='CN':china_selection(study,folder)
                    for strategy_id in missing:
                        result=produce(study,strategy_id,session)
                        result['note']+=' Provider: '+type(provider).__name__+'; fixed operator universe of '+str(len(symbols))+' securities, different from the repository research universe.'
                        temporary=paths[strategy_id].with_suffix('.tmp')
                        temporary.write_text(json.dumps(result,ensure_ascii=False,allow_nan=False))
                        temporary.replace(paths[strategy_id])
            rejected=[]
            from urllib.error import HTTPError
            for strategy_id in ids:
                result=json.loads(paths[strategy_id].read_text())
                try:
                    publisher.post('portfolio/backtests',result)
                    publisher.post('portfolio/signals',result['signal'])
                except HTTPError as error:
                    if error.code!=409:raise
                    rejected.append(strategy_id)
                    print(market,'signal rejected:',strategy_id,'HTTP 409; prior signal retained',flush=True)
            state[market]=key
            if rejected:
                # A deterministic conflict will not heal by resending every 30s.
                # Remember the session attempt, retain old signals, and keep quotes polling.
                state[market+':rejected']=rejected
                print(market,'partial publication; conflicting strategies blocked:',len(rejected),flush=True)
                continue
            state.pop(market+':rejected',None)
            print(market,'published completed-session signals',session['signal_date'],flush=True)


def main():
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--config',type=Path,required=True);parser.add_argument('--once',action='store_true');parser.add_argument('--market',choices=['US','HK','CN']);args=parser.parse_args()
    config=json.loads(args.config.read_text());providers={}
    if args.market:config['markets']={args.market:config['markets'][args.market]}
    for market,options in config['markets'].items():
        provider=PROVIDERS[options['provider']]()
        if market!=provider.market:raise ValueError('Provider/market mismatch')
        providers[market]=provider
    (ROOT/'.paper_state').mkdir(exist_ok=True)
    lock=(ROOT/'.paper_state'/('portfolio-producer-'+(args.market or 'all')+'.lock')).open('a')
    if os.name=='nt':
        import msvcrt
        lock.seek(0);lock.write('0');lock.flush();lock.seek(0)
        msvcrt.locking(lock.fileno(),msvcrt.LK_NBLCK,1)
    else:
        import fcntl
        fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
    state={};publisher=Publisher(config['site_origin']);logged=time.monotonic()
    try:
        while True:
            if time.monotonic()-logged>6*3600:
                publisher.post('auth/logout',{});publisher=Publisher(config['site_origin']);logged=time.monotonic()
            failures=[]
            for market,options in config['markets'].items():
                try:run_once({**config,'markets':{market:options}},providers,publisher,state)
                except Exception as error:
                    failures.append(market)
                    detail=str(error)
                    for name,value in os.environ.items():
                        if value and any(k in name for k in ('TOKEN','SECRET','PASSWORD','KEY')):detail=detail.replace(value,'[redacted]')
                    print(market,'data refresh failed:',type(error).__name__,detail[:240],flush=True)
            if args.once:
                if failures:raise RuntimeError('Some markets failed')
                break
            time.sleep(max(15,min(60,config.get('poll_seconds',30))))
    finally:publisher.post('auth/logout',{})

if __name__=='__main__':
    try:main()
    except Exception as error:
        # Provider exceptions can contain URLs/headers. No raw credentials or traceback in service logs.
        print('Portfolio data service stopped:',type(error).__name__,flush=True)
        raise SystemExit(1)
