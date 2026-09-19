"""Download public one-minute observations in bounded seven-day requests; no account.
Never interpolate missing bars. Existing snapshots are preserved on a failed market.
"""
import argparse, datetime, hashlib, json, math, urllib.request
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
SPECS={'US':('SPY','SPY','SPY'),'HK':('0700.HK','0700.HK','HK'),'CN':('600000.SH','600000.SS','CN')}

def merge_bars(chunks):
    bars={}
    for r in chunks:
        q=r['indicators']['quote'][0]
        for i,t in enumerate(r.get('timestamp',[])):
            vals=[q[k][i] for k in ['open','high','low','close','volume']]
            if any(v is None or not isinstance(v,(int,float)) or not math.isfinite(v) for v in vals):continue
            o,h,l,c,v=vals
            if min(o,h,l,c)<=0 or v<0 or h<max(o,l,c) or l>min(o,h,c):continue
            bar=dict(zip(['t','o','h','l','c','v'],[datetime.datetime.fromtimestamp(t,datetime.timezone.utc).isoformat().replace('+00:00','Z'),*vals]))
            if t in bars and bars[t]!=bar:raise ValueError('Conflicting overlapping observations')
            bars[t]=bar
    return [bars[t] for t in sorted(bars)]

def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--markets',nargs='+',choices=SPECS,default=list(SPECS))
    p.add_argument('--days',type=int,choices=range(5,29),default=28)
    p.add_argument('--output',type=Path,default=ROOT/'web_platform/demo-data/library-inputs')
    p.add_argument('--update-defaults',action='store_true',help='Update tracked classroom snapshots after validating each download')
    args=p.parse_args();out=ROOT/'web_platform/demo-data' if args.update_defaults else args.output
    out.mkdir(parents=True,exist_ok=True);failed=0
    now=datetime.datetime.now(datetime.timezone.utc)
    # End at UTC midnight: keep complete prior market dates, no partial current day.
    end=int(now.replace(hour=0,minute=0,second=0,microsecond=0).timestamp());start=end-args.days*86400
    for market in args.markets:
        symbol,ticker,stem=SPECS[market]
        try:
            chunks=[];urls=[]
            for first in range(start,end,7*86400):
                last=min(first+7*86400,end)
                url=f'https://query1.finance.yahoo.com/v8/finance/chart/{ticker}?period1={first}&period2={last}&interval=1m'
                req=urllib.request.Request(url,headers={'User-Agent':'Mozilla/5.0'})
                with urllib.request.urlopen(req,timeout=25) as res:data=json.load(res)
                if data['chart'].get('error'):raise ValueError('Provider rejected requested history')
                chunks.append(data['chart']['result'][0]);urls.append(url)
            bars=merge_bars(chunks)
            if len(bars)<80:raise ValueError('Insufficient public minute observations')
            payload={'market':market,'symbol':symbol,'timeframe':'1Min','sample_kind':'historical','source':'Yahoo Finance Chart public snapshot','source_urls':urls,'adjust':'unadjusted','fetched_at':now.isoformat(),'sha256_bars':hashlib.sha256(json.dumps(bars,sort_keys=True).encode()).hexdigest(),'bars':bars}
            path=out/(stem+'-1Min-snapshot.json' if args.update_defaults else 'yahoo-'+market+'.json')
            temporary=path.with_suffix('.tmp');temporary.write_text(json.dumps(payload,ensure_ascii=False,separators=(',',':'))+'\n');temporary.replace(path)
            print(market,len(bars),bars[0]['t'],bars[-1]['t'],flush=True)
        except (ValueError,KeyError,TypeError,IndexError,OSError) as e:
            failed+=1;print(market,'FAILED',type(e).__name__,str(e),flush=True)
    return 1 if failed else 0
if __name__=='__main__':raise SystemExit(main())
