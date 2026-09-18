import json, time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
import requests
from fetch_daily_strategy_data import ROOT

def probe(label, url, params=None):
    start=time.monotonic()
    try:
        r=requests.get(url,params=params,timeout=10,headers={'User-Agent':'Mozilla/5.0'})
        r.raise_for_status()
        if label.startswith('Yahoo'):
            data=r.json()['chart']['result'][0]
            detail=f"{len(data.get('timestamp',[]))} daily bars"
        elif label.startswith('Nasdaq'):
            out=ROOT/'data'/'international_universe'; out.mkdir(exist_ok=True,parents=True)
            (out/(label.split()[-1]+'.txt')).write_text(r.text,encoding='utf8')
            detail=f'{len(r.text.splitlines())} lines'
        else:
            detail=f'{len(r.content)} bytes, assignment={"=" in r.text}'
        return {'source':label,'ok':True,'seconds':round(time.monotonic()-start,2),'detail':detail}
    except Exception as exc:
        return {'source':label,'ok':False,'seconds':round(time.monotonic()-start,2),'error':str(exc)[:150]}

if __name__=='__main__':
    jobs=[('Nasdaq nasdaqlisted','https://www.nasdaqtrader.com/dynamic/SymDir/nasdaqlisted.txt',None),
          ('Nasdaq otherlisted','https://www.nasdaqtrader.com/dynamic/SymDir/otherlisted.txt',None),
          ('Sina HK','https://finance.sina.com.cn/stock/hkstock/00700/klc2_kl.js',None)]
    for s in ['MSFT','JPM','KO','0700.HK','0005.HK','2800.HK']:
        jobs.append(('Yahoo '+s,'https://query1.finance.yahoo.com/v8/finance/chart/'+s,
                     {'period1':1704067200,'period2':1767225600,'interval':'1d','events':'div,splits'}))
    with ThreadPoolExecutor(max_workers=3) as pool:
        for f in as_completed([pool.submit(probe,*job) for job in jobs]): print(json.dumps(f.result(),ensure_ascii=False),flush=True)
