"""Read-only broker history capability audit and reproducible research collection.
No trading imports or order calls. No exception text (may contain credentials).
"""
from pathlib import Path
from datetime import date, datetime, timezone
import argparse, hashlib, json, os, time, re, urllib.request, urllib.parse, shutil
from concurrent.futures import ThreadPoolExecutor,as_completed
import pandas as pd
ROOT=Path(__file__).resolve().parents[1]
OUT=ROOT/'data'/'own_daily_v1'

def save_json(path,value):
    path.parent.mkdir(parents=True,exist_ok=True)
    tmp=path.with_suffix(path.suffix+'.tmp')
    tmp.write_text(json.dumps(value,ensure_ascii=False,indent=2,default=str),encoding='utf8');tmp.replace(path)

def safe_error(e):
    message=str(e)
    for k,v in os.environ.items():
        if any(t in k for t in ('TOKEN','SECRET','KEY','PASSWORD','ACCOUNT')) and len(v)>3:message=message.replace(v,'[redacted]')
    return re.sub(r'[A-Za-z0-9_-]{32,}','[redacted]',message)[:200]

def save_frame(market,symbol,frame,provider,adjustment):
    frame=frame.sort_values('date').drop_duplicates('date')
    path=OUT/market/(symbol+'.csv.gz');path.parent.mkdir(parents=True,exist_ok=True)
    if path.exists():
        archive=OUT/'source_archive'/market;archive.mkdir(parents=True,exist_ok=True)
        h=hashlib.sha256(path.read_bytes()).hexdigest();old=archive/(h+'.csv.gz')
        if not old.exists():shutil.copy2(path,old)
    frame.to_csv(path,index=False,compression='gzip')
    return dict(market=market,symbol=symbol,provider=provider,adjustment=adjustment,rows=len(frame),
        start=str(frame.date.iloc[0]) if len(frame) else None,end=str(frame.date.iloc[-1]) if len(frame) else None,
        sha256=hashlib.sha256(path.read_bytes()).hexdigest(),file=str(path.relative_to(ROOT)))

def us_history(p,symbol,start,end,feed='sip'):
    rows=[];token=None;seen=set()
    while True:
        params=dict(symbols=symbol,timeframe='1Day',start=start+'T00:00:00Z',end=end+'T23:59:59Z',adjustment='all',feed=feed,limit=10000,sort='asc')
        if token:params['page_token']=token
        page=p.get('/v2/stocks/bars',params,data=True)
        rows.extend(page.get('bars',{}).get(symbol,[]));token=page.get('next_page_token')
        if not token:break
        if token in seen:raise ValueError('Repeated page')
        seen.add(token)
    return pd.DataFrame([dict(date=str(pd.Timestamp(b['t']).tz_convert('America/New_York').date()),open=b['o'],high=b['h'],low=b['l'],close=b['c'],volume=b['v']) for b in rows],columns=['date','open','high','low','close','volume'])

def hk_history(p,symbol,start,end):
    from longbridge.openapi import Period,AdjustType
    # One-year requests avoid provider record limits; keep all chunks, including empties.
    rows=[]
    for year in range(int(start[:4]),int(end[:4])+1):
        a=max(start,f'{year}-01-01');b=min(end,f'{year}-12-31')
        bars=p.context.history_candlesticks_by_date(symbol,Period.Day,AdjustType.ForwardAdjust,date.fromisoformat(a),date.fromisoformat(b))
        rows.extend(dict(date=str(x.timestamp.astimezone(p.zone).date()),open=float(x.open),high=float(x.high),low=float(x.low),close=float(x.close),volume=x.volume,amount=float(x.turnover)) for x in bars)
    return pd.DataFrame(rows,columns=['date','open','high','low','close','volume','amount'])

def cn_history(p,symbol,start,end):
    f=p.api.history(symbol,'1d',start+' 00:00:00',end+' 23:59:59',fields='eob,open,high,low,close,volume,amount',adjust=p.api.ADJUST_PREV,df=True)
    if len(f)>=33000:raise ValueError('Possible record truncation')
    if len(f):
        f['date']=pd.to_datetime(f.eob).dt.strftime('%Y-%m-%d')
        return f[['date','open','high','low','close','volume','amount']]
    return pd.DataFrame(columns=['date','open','high','low','close','volume','amount'])

def probe(market):
    from portfolio_providers import AlpacaData,LongbridgeData
    from myquant_data import MyQuantData
    result={'market':market,'checked_at':datetime.now(timezone.utc).isoformat(),'read_only':True,'attempts':[]}
    try:
        provider={'US':AlpacaData,'HK':LongbridgeData,'CN':MyQuantData}[market]()
        symbol={'US':'AAPL','HK':'700.HK','CN':'SHSE.600036'}[market]
        for start,end in [('2015-01-01','2015-12-31'),('2020-01-01','2020-12-31'),('2025-01-01','2025-12-31')]:
            for feed in (['sip','iex'] if market=='US' else ['default']):
                item=dict(start=start,end=end,feed=feed,symbol=symbol)
                try:
                    frame=us_history(provider,symbol,start,end,feed) if market=='US' else hk_history(provider,symbol,start,end) if market=='HK' else cn_history(provider,symbol,start,end)
                    item.update(status='ok' if len(frame) else 'empty',rows=len(frame),first=str(frame.date.iloc[0]) if len(frame) else None,last=str(frame.date.iloc[-1]) if len(frame) else None)
                    if len(frame):save_frame('probe_'+market,symbol+'_'+start[:4]+'_'+feed,frame,market, 'provider_adjusted')
                except Exception as e:item.update(status='failed',error_type=type(e).__name__,http_status=getattr(e,'code',None))
                result['attempts'].append(item);print(json.dumps(item),flush=True)
        if market=='US':
            rows=provider.get('/v2/assets',{'status':'active','asset_class':'us_equity'})
            save_json(OUT/'US_current_assets.json',rows);result['current_assets']=len(rows)
            inactive=provider.get('/v2/assets',{'status':'inactive','asset_class':'us_equity'})
            save_json(OUT/'US_inactive_assets.json',inactive);result['inactive_assets']=len(inactive)
        elif market=='CN':
            info=provider.api.get_symbol_infos(1010,df=True)
            info.to_csv(OUT/'CN_symbol_infos.csv.gz',index=False,compression='gzip');result['symbol_infos']=len(info)
    except Exception as e:result['setup_error_type']=type(e).__name__
    save_json(ROOT/'reports'/'own_daily_v1'/('capability_'+market+'.json'),result)

def universe(market):
    if market=='CN':
        f=pd.read_csv(OUT/'CN_symbol_infos.csv.gz')
        # Explicit ordinary A share classification, including historical delisted issues.
        f=f[f.sec_type2==101001]
        records=[dict(symbol=r.symbol,listed=str(r.listed_date)[:10],delisted=str(r.delisted_date)[:10],exchange=r.exchange) for r in f.itertuples()]
    elif market=='HK':
        rows=json.loads((OUT/'HK_securities.json').read_text(encoding='utf8'))
        records=[dict(symbol=str(int(r[0]))+'.HK',lot=int(r[4].replace(',','')),listed=None,delisted=None) for r in rows[3:] if len(r)>16 and r[2]=='Equity' and r[16]=='HKD' and 'Preference' not in str(r[3])]
    else:
        assets=json.loads((OUT/'US_current_assets.json').read_text())+json.loads((OUT/'US_inactive_assets.json').read_text())
        records=[];seen=set()
        for r in assets:
            s=r['symbol'];name=r.get('name','')
            if s in seen or not re.fullmatch(r'[A-Z]{1,5}(?:\.[AB])?',s):continue
            if re.search(r'\b(?:ETF|ETN|fund|preferred|warrants?|rights?|units?|debenture|notes?|bonds?|acquisition|depositary)\b',name,re.I):continue
            # NYSE names often omit "Common Stock" (e.g. JPM/LLY/TDOC).
            # Include corporate legal names as candidates; this is still a
            # provider-name classifier, not a verified historical security type.
            if not re.search(r'common|ordinary|Class [ABC]|\b(?:Inc|Incorporated|Corp|Corporation|Co|Company|Ltd|Limited|PLC|REIT)\b',name,re.I):continue
            seen.add(s);records.append(dict(symbol=s,listed=None,delisted=None,status=r['status'],exchange=r['exchange']))
    records=sorted(records,key=lambda r:hashlib.sha256(r['symbol'].encode()).hexdigest())
    save_json(OUT/(market+'_universe.json'),{'source':'platform securities master' if market!='HK' else 'HKEX current list', 'historically_complete':False,'records':records,'ordering':'sha256 symbol; independent of returns','notes':'HK misses historical delisted; US name-based classification and symbol changes need audit; CN provider master coverage not independently verified'})
    return records

def us_batch(p,symbols,start,end):
    rows={s:[] for s in symbols};token=None;seen=set()
    while True:
        params=dict(symbols=','.join(symbols),timeframe='1Day',start=start+'T00:00:00Z',end=end+'T23:59:59Z',adjustment='all',feed='sip',limit=10000,sort='asc')
        if token:params['page_token']=token
        for attempt in range(3):
            try:
                page=p.get('/v2/stocks/bars',params,data=True);break
            except Exception as exc:
                code=getattr(exc,'code',None)
                if attempt==2 or (code is not None and code not in [408,429,500,502,503,504]):raise
                time.sleep(2**attempt)
        for s,b in page.get('bars',{}).items():rows[s].extend(b)
        token=page.get('next_page_token')
        if not token:break
        if token in seen:raise ValueError('Repeated page')
        seen.add(token)
    return {s:pd.DataFrame([dict(date=str(pd.Timestamp(b['t']).tz_convert('America/New_York').date()),open=b['o'],high=b['h'],low=b['l'],close=b['c'],volume=b['v']) for b in bars],columns=['date','open','high','low','close','volume']) for s,bars in rows.items()}

def cn_batch(p,symbols,start,end):
    collected=[]
    for year in range(int(start[:4]),int(end[:4])+1):
        a=max(start,f'{year}-01-01');b=min(end,f'{year}-12-31')
        f=p.api.history(','.join(symbols),'1d',a+' 00:00:00',b+' 23:59:59',fields='symbol,eob,open,high,low,close,volume,amount',adjust=p.api.ADJUST_PREV,df=True)
        if len(f)>=33000:raise ValueError('Possible record truncation')
        if len(f):
            f['date']=pd.to_datetime(f.eob).dt.strftime('%Y-%m-%d');collected.append(f)
    frames={s:pd.DataFrame(columns=['date','open','high','low','close','volume','amount']) for s in symbols}
    if collected:
        for s,f in pd.concat(collected).groupby('symbol'):frames[s]=f[['date','open','high','low','close','volume','amount']]
    return frames

def hk_fast(p,symbol,start,end):
    from longbridge.openapi import Period,AdjustType
    from datetime import timedelta
    cutoff=datetime.fromisoformat(end+'T23:59:59').replace(tzinfo=p.zone);rows=[]
    for _ in range(20):
        time.sleep(.25)
        for attempt in range(3):
            try:
                bars=p.context.history_candlesticks_by_offset(symbol,Period.Day,AdjustType.ForwardAdjust,False,1000,cutoff)
                break
            except Exception as e:
                if '301607' in str(e):raise
                if attempt==2:raise
                time.sleep(1+attempt)
        if not bars:break
        first=min(x.timestamp.astimezone(p.zone) for x in bars)
        rows.extend(dict(date=str(x.timestamp.astimezone(p.zone).date()),open=float(x.open),high=float(x.high),low=float(x.low),close=float(x.close),volume=x.volume,amount=float(x.turnover)) for x in bars if start<=str(x.timestamp.astimezone(p.zone).date())<=end)
        if str(first.astimezone(p.zone).date())<=start or len(bars)<1000:break
        next_cutoff=first-timedelta(days=1)
        if next_cutoff>=cutoff:raise ValueError('Non-progressing history')
        cutoff=next_cutoff
    else:raise ValueError('Exceeded history pagination')
    return pd.DataFrame(rows,columns=['date','open','high','low','close','volume','amount'])

def collect(args):
    from portfolio_providers import AlpacaData,LongbridgeData
    from myquant_data import MyQuantData
    market=args.market;p={'US':AlpacaData,'HK':LongbridgeData,'CN':MyQuantData}[market]()
    records=universe(market);records=[r for r in records if not r.get('listed') or r['listed']<=args.end]
    if args.limit:records=records[:args.limit]
    manifest_path=OUT/(market+'_manifest.json');manifest=json.loads(manifest_path.read_text()) if manifest_path.exists() else {}
    todo=[r['symbol'] for r in records if r['symbol'] not in manifest or manifest[r['symbol']].get('status') not in ('ok','empty')]
    start_time=time.monotonic();batch_size=30 if market=='US' else 1
    print(json.dumps({'market':market,'initial_pool':len(records),'pending':len(todo)}),flush=True)
    for offset in range(0,len(todo),batch_size):
        if time.monotonic()-start_time>args.seconds:break
        symbols=todo[offset:offset+batch_size]
        try:
            frames=us_batch(p,symbols,args.start,args.end) if market=='US' else {symbols[0]:cn_history(p,symbols[0],args.start,args.end)} if market=='CN' else {symbols[0]:hk_fast(p,symbols[0],args.start,args.end)}
            for s,f in frames.items():
                item=save_frame(market,s,f,{'US':'Alpaca SIP','HK':'Longbridge','CN':'MyQuant'}[market],'all' if market=='US' else 'forward_adjusted')
                item.update(status='ok' if len(f) else 'empty',requested_start=args.start,requested_end=args.end)
                manifest[s]=item
        except Exception as e:
            for s in symbols:manifest[s]=dict(status='failed',error_type=type(e).__name__,error_hint=safe_error(e))
            if '301607' in str(e):
                save_json(manifest_path,manifest);print('Provider historical symbol quota reached; stop without retry.',flush=True);break
        save_json(manifest_path,manifest)
        if offset%30==0:print(json.dumps({'market':market,'processed':min(offset+batch_size,len(todo)),'ok':sum(x['status']=='ok' for x in manifest.values()),'failed':sum(x['status']=='failed' for x in manifest.values()),'seconds':round(time.monotonic()-start_time)}),flush=True)
    print(json.dumps({'market':market,'finished_batch':True,'ok':sum(x['status']=='ok' for x in manifest.values()),'empty':sum(x['status']=='empty' for x in manifest.values()),'failed':sum(x['status']=='failed' for x in manifest.values())}),flush=True)

def yahoo_history(symbol,market,start,end):
    ticker=(symbol.split('.')[0].zfill(4)+'.HK') if market=='HK' else symbol
    a=int(pd.Timestamp(start,tz='UTC').timestamp());b=int((pd.Timestamp(end,tz='UTC')+pd.Timedelta(days=1)).timestamp())
    url='https://query1.finance.yahoo.com/v8/finance/chart/'+urllib.parse.quote(ticker)+'?'+urllib.parse.urlencode(dict(period1=a,period2=b,interval='1d',events='div,splits'))
    request=urllib.request.Request(url,headers={'User-Agent':'Mozilla/5.0'})
    with urllib.request.urlopen(request,timeout=25) as response:obj=json.load(response)
    data=obj['chart']['result'][0];q=data['indicators']['quote'][0];adj=data['indicators'].get('adjclose',[{}])[0].get('adjclose',q['close']);rows=[]
    for i,stamp in enumerate(data.get('timestamp',[])):
        raw=q['close'][i]
        if raw is None or adj[i] is None or raw<=0:continue
        factor=adj[i]/raw
        if any(q[k][i] is None for k in ['open','high','low','volume']):continue
        day=str(pd.Timestamp(stamp,unit='s',tz='UTC').tz_convert('Asia/Hong_Kong' if market=='HK' else 'America/New_York').date())
        if not start<=day<=end:continue
        rows.append(dict(date=day,open=q['open'][i]*factor,high=q['high'][i]*factor,low=q['low'][i]*factor,close=adj[i],volume=q['volume'][i],amount=raw*q['volume'][i]))
    return pd.DataFrame(rows,columns=['date','open','high','low','close','volume','amount'])

def collect_parallel(args):
    """Small read-only thread pool; one writer maintains atomic manifest checkpoints."""
    from portfolio_providers import AlpacaData
    from myquant_data import MyQuantData
    m=args.market;records=universe(m);records=[r for r in records if not r.get('listed') or r['listed']<=args.end]
    if args.limit:records=records[:args.limit]
    path=OUT/(m+'_manifest.json');manifest=json.loads(path.read_text()) if path.exists() else {}
    todo=[r['symbol'] for r in records if manifest.get(r['symbol'],{}).get('status') not in ('ok','empty') or
          (args.yahoo and args.uniform_source and manifest.get(r['symbol'],{}).get('provider')!='Yahoo public fallback')]
    if args.yahoo:provider=None
    else:provider=AlpacaData() if m=='US' else MyQuantData()
    size=30 if m=='US' and not args.yahoo else 1
    batches=[todo[i:i+size] for i in range(0,len(todo),size)];started=time.monotonic()
    def job(symbols):
        if time.monotonic()-started>args.seconds:return symbols,None,None
        try:
            if args.yahoo:frames={s:yahoo_history(s,m,args.start,args.end) for s in symbols}
            elif m=='US':frames=us_batch(provider,symbols,args.start,args.end)
            else:frames={s:cn_history(provider,s,args.start,args.end) for s in symbols}
            return symbols,frames,None
        except Exception as e:return symbols,None,dict(status='failed',error_type=type(e).__name__,error_hint=safe_error(e))
    print(json.dumps({'market':m,'pending':len(todo),'workers':args.workers,'source':'Yahoo public fallback' if args.yahoo else 'existing platform'}),flush=True)
    with ThreadPoolExecutor(max_workers=args.workers) as executor:
        futures=[executor.submit(job,b) for b in batches];processed=0
        for future in as_completed(futures):
            symbols,frames,error=future.result()
            if frames is None and error is None:continue
            if error:
                for s in symbols:manifest[s]=error.copy()
            else:
                for s,f in frames.items():
                    item=save_frame(m,s,f,'Yahoo public fallback' if args.yahoo else 'Alpaca SIP' if m=='US' else 'MyQuant','split_dividend_adjusted' if args.yahoo else 'all' if m=='US' else 'forward_adjusted')
                    item.update(status='ok' if len(f) else 'empty',requested_start=args.start,requested_end=args.end);manifest[s]=item
            processed+=len(symbols);save_json(path,manifest)
            if processed%30==0:print(json.dumps({'market':m,'processed':processed,'ok':sum(x['status']=='ok' for x in manifest.values()),'failed':sum(x['status']=='failed' for x in manifest.values()),'seconds':round(time.monotonic()-started)}),flush=True)
    print(json.dumps({'market':m,'finished_batch':True,'ok':sum(x['status']=='ok' for x in manifest.values()),'empty':sum(x['status']=='empty' for x in manifest.values()),'failed':sum(x['status']=='failed' for x in manifest.values())}),flush=True)

if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('--market',choices=['US','HK','CN'],required=True);p.add_argument('--fundamental-collect',action='store_true');p.add_argument('--fundamental-probe',action='store_true');p.add_argument('--actions',action='store_true');p.add_argument('--probe',action='store_true');p.add_argument('--collect',action='store_true');p.add_argument('--limit',type=int,default=0);p.add_argument('--seconds',type=int,default=900);p.add_argument('--start',default='2014-01-01');p.add_argument('--end',default='2025-12-31');p.add_argument('--workers',type=int,default=1);p.add_argument('--yahoo',action='store_true');p.add_argument('--uniform-source',action='store_true');args=p.parse_args()
    OUT.mkdir(parents=True,exist_ok=True)
    if args.probe:probe(args.market)
    if args.fundamental_probe:
        from probe_own_fundamentals import probe_fundamentals
        probe_fundamentals(args.market)
    if args.fundamental_collect:
        if args.market!='CN':raise ValueError('PIT collector currently CN only')
        from collect_own_fundamental_cn import collect
        collect()
    if args.actions:
        from own_daily_actions import collect_actions
        collect_actions()
    if args.collect:
        # GM SDK query callbacks stalled under concurrent threads in the audit.
        # Keep that SDK single-threaded; HTTP-only sources can use a small pool.
        if args.market=='CN' and not args.yahoo:collect(args)
        elif args.workers>1 or args.yahoo:collect_parallel(args)
        else:collect(args)
