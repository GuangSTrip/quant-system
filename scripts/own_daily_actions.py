"""Read-only corporate action coverage probe; no assumed synthetic settlements."""
from pathlib import Path
import json,hashlib
from concurrent.futures import ThreadPoolExecutor,as_completed
from datetime import timedelta,date
import pandas as pd
from portfolio_providers import AlpacaData
from own_daily_data import save_json
ROOT=Path(__file__).resolve().parents[1]

def collect_actions():
    out=ROOT/'data/own_daily_v4';out.mkdir(parents=True,exist_ok=True)
    p=AlpacaData();audit=[]
    for year in range(2016,2026):
        rows={};token=None;seen=set()
        try:
            while True:
                params=dict(types='cash_merger,stock_merger,stock_and_cash_merger,worthless_removal',start=f'{year}-01-01',end=f'{year}-12-31',limit=1000)
                if token:params['page_token']=token
                page=p.get('/v1/corporate-actions',params,data=True)
                for k,v in page.get('corporate_actions',{}).items():rows.setdefault(k,[]).extend(v)
                token=page.get('next_page_token')
                if not token:break
                if token in seen:raise ValueError('repeated page')
                seen.add(token)
            save_json(out/f'US_actions_{year}.json',rows)
            item=dict(year=year,status='ok',counts={k:len(v) for k,v in rows.items()})
        except Exception as e:item=dict(year=year,status='failed',error_type=type(e).__name__,http_status=getattr(e,'code',None))
        audit.append(item);print(json.dumps(item),flush=True)
    save_json(out/'actions_audit.json',audit)
    normalize_actions(out)
    from own_daily_data import us_history
    f=us_history(p,'SPY','2016-01-01','2025-12-31');path=out/'SPY_benchmark.csv.gz';f.to_csv(path,index=False,compression='gzip')
    save_json(out/'SPY_benchmark_meta.json',dict(source='Alpaca SIP',adjustment='all',rows=len(f),sha256=hashlib.sha256(path.read_bytes()).hexdigest()))

def normalize_actions(out):
    """Require local identity continuity and contemporaneous raw/adjusted factors."""
    root=ROOT/'data/own_daily_v1';manifest=json.loads((root/'US_manifest.json').read_text())
    records=[]
    for path in sorted(out.glob('US_actions_*.json')):
        for kind,rows in json.loads(path.read_text()).items():
            for r in rows:records.append((kind,r))
    candidates=[];rejected=[];frames={}
    def frame(s):
        if s not in frames:frames[s]=pd.read_csv(root/'US'/(s+'.csv.gz')).set_index('date')
        return frames[s]
    for kind,r in records:
        s=r.get('acquiree_symbol');effective=r.get('effective_date');process=r.get('process_date')
        if not s or manifest.get(s,{}).get('status')!='ok':continue
        reason=None
        if kind not in ['cash_mergers','stock_mergers','stock_and_cash_mergers']:reason='unsupported_type'
        elif not effective or not process or process<effective:reason='invalid_dates'
        elif frame(s).index[-1]>=effective:reason='history_continues_identity_or_event_ambiguous'
        elif (date.fromisoformat(effective)-date.fromisoformat(frame(s).index[-1])).days>10:reason='no_recent_acquiree_price'
        buyer=r.get('acquirer_symbol')
        if not reason and kind!='cash_mergers':
            if manifest.get(buyer,{}).get('status')!='ok':reason='acquirer_history_missing'
            elif process not in frame(buyer).index:reason='acquirer_event_price_missing'
        if reason:rejected.append(dict(symbol=s,id=r['id'],reason=reason));continue
        candidates.append((kind,r))
    jobs={}
    for kind,r in candidates:
        s=r['acquiree_symbol'];jobs[(s,frame(s).index[-1])]=True
        if kind!='cash_mergers':jobs[(r['acquirer_symbol'],r['process_date'])]=True
    rawdir=out/'raw_event_bars';rawdir.mkdir(exist_ok=True)
    def fetch(key):
        s,d=key;path=rawdir/(s+'_'+d+'.json')
        try:
            if path.exists():return key,json.loads(path.read_text())
            p=AlpacaData();data=p.get('/v2/stocks/bars',dict(symbols=s,timeframe='1Day',start=d+'T00:00:00Z',end=d+'T23:59:59Z',adjustment='raw',feed='sip',limit=1000),data=True)
            save_json(path,data);return key,data
        except Exception as e:return key,dict(error_type=type(e).__name__,http_status=getattr(e,'code',None))
    raw={}
    with ThreadPoolExecutor(max_workers=4) as pool:
        for k,data in pool.map(fetch,jobs):raw[k]=data
    normalized=[]
    for kind,r in candidates:
        s=r['acquiree_symbol'];d=frame(s).index[-1]
        def factor(symbol,day):
            bars=raw[(symbol,day)].get('bars',{}).get(symbol,[])
            bars=[b for b in bars if str(pd.Timestamp(b['t']).tz_convert('America/New_York').date())==day]
            if len(bars)!=1 or bars[0]['c']<=0:raise ValueError('missing raw event bar')
            return float(frame(symbol).loc[day,'close'])/bars[0]['c']
        try:
            oldfactor=factor(s,d);cash=float(r.get('rate',0) if kind=='cash_mergers' else r.get('cash_rate',0))
            buyer=r.get('acquirer_symbol') if kind!='cash_mergers' else None
            newfactor=factor(buyer,r['process_date']) if buyer else 1.
            ratio=float(r['acquirer_rate'])/float(r['acquiree_rate']) if buyer else 0.
            if oldfactor<=0 or newfactor<=0:raise ValueError('nonpositive adjustment')
            normalized.append(dict(id=r['id'],kind=kind,symbol=s,date=r['process_date'],effective_date=r['effective_date'],
                cash_per_adjusted_unit=cash*oldfactor,acquirer=buyer,new_units_per_adjusted_unit=ratio*oldfactor/newfactor,
                old_factor=oldfactor,new_factor=newfactor,raw_cash=cash,raw_share_ratio=ratio,source='Alpaca corporate-actions + SIP raw event bars'))
        except Exception as e:rejected.append(dict(symbol=s,id=r['id'],reason=type(e).__name__))
    save_json(out/'normalized_actions.json',normalized);save_json(out/'rejected_actions.json',rejected)
    hashes={str(f.relative_to(out)):hashlib.sha256(f.read_bytes()).hexdigest() for f in out.rglob('*.json') if f.name!='action_hashes.json'}
    save_json(out/'action_hashes.json',hashes)
    print(json.dumps(dict(normalized=len(normalized),rejected=len(rejected),raw_requests=len(jobs))),flush=True)
