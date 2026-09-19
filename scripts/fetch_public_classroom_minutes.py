"""Download bounded, public HK/CN 1-minute snapshots into ignored local inputs.
No credentials or orders. Review source rights/quality before external publication.
"""
import argparse,datetime,hashlib,json,urllib.request
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]

def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--markets',nargs='+',choices=['HK','CN'],default=['HK','CN'])
    p.add_argument('--output',type=Path,default=ROOT/'web_platform/demo-data/library-inputs')
    args=p.parse_args();args.output.mkdir(parents=True,exist_ok=True);failed=0
    for market in args.markets:
        symbol,ticker={'HK':('0700.HK','0700.HK'),'CN':('600000.SH','600000.SS')}[market]
        try:
            url='https://query1.finance.yahoo.com/v8/finance/chart/'+ticker+'?range=5d&interval=1m'
            req=urllib.request.Request(url,headers={'User-Agent':'Mozilla/5.0'})
            with urllib.request.urlopen(req,timeout=25) as res:data=json.load(res)
            r=data['chart']['result'][0];q=r['indicators']['quote'][0];bars=[]
            for i,t in enumerate(r['timestamp']):
                vals=[q[k][i] for k in ['open','high','low','close','volume']]
                if any(v is None for v in vals):continue
                bars.append(dict(zip(['t','o','h','l','c','v'],[datetime.datetime.fromtimestamp(t,datetime.timezone.utc).isoformat().replace('+00:00','Z'),*vals])))
            if len(bars)<80:raise ValueError('Insufficient public minute observations')
            payload={'market':market,'symbol':symbol,'timeframe':'1Min','sample_kind':'historical','source':'Yahoo Finance Chart public snapshot','source_url':url,'adjust':'unadjusted','fetched_at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'sha256_bars':hashlib.sha256(json.dumps(bars,sort_keys=True).encode()).hexdigest(),'bars':bars}
            path=args.output/('yahoo-'+market+'.json');path.write_text(json.dumps(payload,ensure_ascii=False,separators=(',',':'))+'\n')
            print(market,len(bars),bars[0]['t'],bars[-1]['t'],path)
        except (ValueError,KeyError,TypeError,IndexError,OSError) as e:
            failed+=1;print(market,'FAILED',type(e).__name__,str(e))
    return 1 if failed else 0
if __name__=='__main__':raise SystemExit(main())
