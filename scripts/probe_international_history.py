"""Small bounded connectivity/entitlement check, with no credentials in output."""
import json
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
import requests
import tushare as ts
from fetch_daily_strategy_data import ROOT, token

OUT = ROOT / 'reports' / 'international_access'

def tushare_probe(endpoint, symbol):
    start = time.monotonic()
    try:
        api = ts.pro_api(token(), timeout=15)
        frame = getattr(api, endpoint)(ts_code=symbol, start_date='20240101', end_date='20251231')
        OUT.mkdir(parents=True, exist_ok=True)
        if len(frame):
            frame.to_csv(OUT / (endpoint + '.csv.gz'), index=False, compression='gzip')
        return dict(source=endpoint, status='ok' if len(frame) else 'empty', rows=len(frame),
                    seconds=round(time.monotonic()-start, 2))
    except Exception as exc:
        return dict(source=endpoint, status='error', error=str(exc).replace(token() or 'TOKEN_ABSENT', '[redacted]')[:220],
                    seconds=round(time.monotonic()-start, 2))

def yahoo_probe(symbol):
    start = time.monotonic()
    try:
        response = requests.get(f'https://query1.finance.yahoo.com/v8/finance/chart/{symbol}',
            params={'period1':1704067200, 'period2':1767225600, 'interval':'1d', 'events':'div,splits'},
            headers={'User-Agent':'Mozilla/5.0'}, timeout=18)
        response.raise_for_status()
        item = response.json()['chart']['result'][0]
        OUT.mkdir(parents=True, exist_ok=True)
        (OUT / f'yahoo_{symbol}.json').write_text(json.dumps(item), encoding='utf8')
        return dict(source=f'Yahoo {symbol}', status='ok', rows=len(item['timestamp']),
                    seconds=round(time.monotonic()-start, 2))
    except Exception as exc:
        return dict(source=f'Yahoo {symbol}', status='error', error=str(exc)[:180],
                    seconds=round(time.monotonic()-start, 2))

if __name__ == '__main__':
    OUT.mkdir(parents=True, exist_ok=True)
    jobs = [(tushare_probe, ('us_daily','AAPL')), (tushare_probe, ('hk_daily','00700.HK')),
            (tushare_probe, ('us_daily_adj','AAPL')), (tushare_probe, ('hk_daily_adj','00700.HK')),
            (yahoo_probe, ('AAPL',)), (yahoo_probe, ('0700.HK',))]
    results = []
    with ThreadPoolExecutor(max_workers=3) as pool:
        for future in as_completed([pool.submit(fn,*args) for fn,args in jobs]):
            item = future.result(); results.append(item); print(json.dumps(item,ensure_ascii=False), flush=True)
    (OUT/'status.json').write_text(json.dumps({'checked_at':datetime.now(timezone.utc).isoformat(),
        'results':results},ensure_ascii=False,indent=2),encoding='utf8')
