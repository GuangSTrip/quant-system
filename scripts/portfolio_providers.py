"""Read-only market data adapters. These classes expose no order submission API."""
from __future__ import annotations
import json
import os
import urllib.parse
import urllib.request
from datetime import date,datetime,time,timedelta,timezone
from zoneinfo import ZoneInfo
import pandas as pd

UTC=timezone.utc

def iso(value):
    if value.tzinfo is None: raise ValueError('Provider returned a timezone-naive timestamp')
    return value.astimezone(UTC).isoformat().replace('+00:00','Z')

def session_from_calendar(sessions, now):
    # Wait 15 minutes after the market close for providers to finalize daily bars.
    completed=[s for s in sessions if s['close']+timedelta(minutes=15)<=now]
    if not completed: raise ValueError('No completed session in exchange calendar')
    previous=max(completed,key=lambda s:s['close'])
    upcoming=[s for s in sessions if s['open']>previous['close']]
    if not upcoming: raise ValueError('Next trading session unavailable')
    execution=min(upcoming,key=lambda s:s['open'])
    return {'signal_date':previous['date'],'data_asof':iso(previous['close']),
            'execute_after':iso(execution['open']),'expires_at':iso(execution['close'])}


class AlpacaData:
    market='US'
    def __init__(self):
        self.headers={'APCA-API-KEY-ID':os.environ['ALPACA_PAPER_API_KEY'],
                      'APCA-API-SECRET-KEY':os.environ['ALPACA_PAPER_API_SECRET']}
        self.zone=ZoneInfo('America/New_York')
        class NoRedirect(urllib.request.HTTPRedirectHandler):
            def redirect_request(self,*args,**kwargs):return None
        self.client=urllib.request.build_opener(NoRedirect())
    def get(self,path,params,data=False):
        host='https://data.alpaca.markets' if data else 'https://paper-api.alpaca.markets'
        request=urllib.request.Request(host+path+'?'+urllib.parse.urlencode(params),headers=self.headers)
        with self.client.open(request,timeout=30) as r:return json.load(r)
    def calendar(self,now):
        rows=self.get('/v2/calendar',{'start':(now-timedelta(days=14)).date().isoformat(),'end':(now+timedelta(days=10)).date().isoformat()})
        return [{'date':r['date'],'open':datetime.fromisoformat(r['date']+'T'+r['open']).replace(tzinfo=self.zone),
                 'close':datetime.fromisoformat(r['date']+'T'+r['close']).replace(tzinfo=self.zone)} for r in rows]
    def histories(self,symbols,end):
        result={s:[] for s in symbols}
        for offset in range(0,len(symbols),20):
            chunk=symbols[offset:offset+20];token=None;seen=set()
            while True:
                params={'symbols':','.join(chunk),'timeframe':'1Day','start':'2024-01-01T00:00:00Z',
                        'end':end+'T23:59:59Z','adjustment':'all','feed':'iex','limit':10000,'sort':'asc'}
                if token:params['page_token']=token
                page=self.get('/v2/stocks/bars',params,data=True)
                for symbol,bars in page['bars'].items():
                    if symbol not in chunk:raise ValueError('Unexpected provider symbol')
                    for b in bars:result[symbol].append({'date':datetime.fromisoformat(b['t'].replace('Z','+00:00')).astimezone(self.zone).date().isoformat(),
                         'open':b['o'],'high':b['h'],'low':b['l'],'close':b['c'],'volume':b['v']})
                token=page.get('next_page_token')
                if not token:break
                if token in seen or len(seen)>1000:raise ValueError('Repeated/excessive pagination')
                seen.add(token)
        return {symbol:pd.DataFrame(rows) for symbol,rows in result.items()}


class LongbridgeData:
    market='HK'
    def __init__(self):
        from longbridge.openapi import Config,QuoteContext
        # Reject transport overrides; this service uses the official SDK endpoints.
        if any(os.getenv(k) for k in ('LONGBRIDGE_HTTP_URL','LONGBRIDGE_QUOTE_WS_URL','LONGBRIDGE_TRADE_WS_URL')):
            raise ValueError('Longbridge endpoint overrides are not permitted')
        self.context=QuoteContext(Config.from_apikey(app_key=os.environ['LONGBRIDGE_APP_KEY'],
            app_secret=os.environ['LONGBRIDGE_APP_SECRET'],access_token=os.environ['LONGBRIDGE_ACCESS_TOKEN'],
            http_url='https://openapi.longbridge.com',enable_papertrading=True,enable_print_quote_packages=False))
        self.zone=ZoneInfo('Asia/Hong_Kong')
    def calendar(self,now):
        from longbridge.openapi import Market
        days=self.context.trading_days(Market.HK,(now-timedelta(days=14)).date(),(now+timedelta(days=10)).date())
        half=set(days.half_trading_days)
        return [{'date':d.isoformat(),'open':datetime.combine(d,time(9,30),self.zone),
                 'close':datetime.combine(d,time(12) if d in half else time(16),self.zone)} for d in sorted(set(days.trading_days)|half)]
    def histories(self,symbols,end):
        from longbridge.openapi import Period,AdjustType
        result={}
        for symbol in symbols:
            bars=self.context.history_candlesticks_by_date(symbol,Period.Day,AdjustType.ForwardAdjust,date(2024,1,1),date.fromisoformat(end))
            result[symbol]=pd.DataFrame([{'date':b.timestamp.astimezone(self.zone).date().isoformat(),
                'open':float(b.open),'high':float(b.high),'low':float(b.low),'close':float(b.close),'volume':b.volume} for b in bars])
        return result
    def quotes(self,symbols,now,calendar):
        from longbridge.openapi import TradeStatus
        current=next((s for s in calendar if s['date']==now.astimezone(self.zone).date().isoformat()),None)
        local=now.astimezone(self.zone)
        is_open=bool(current and current['open']<=now<current['close'] and not time(12)<=local.time()<time(13))
        if not is_open or not symbols:return None
        records=[]
        for offset in range(0,len(symbols),50):
            chunk=symbols[offset:offset+50];info={x.symbol:x for x in self.context.static_info(chunk)}
            for q in self.context.quote(chunk):
                i=info[q.symbol]
                if i.currency!='HKD':raise ValueError('Non-HKD security in HK adapter')
                records.append({'symbol':q.symbol,'price':float(q.last_done),'lot':i.lot_size,
                    'tradable':q.trade_status==TradeStatus.Normal,'asof':iso(q.timestamp)})
        if {r['symbol'] for r in records}!=set(symbols):raise ValueError('Incomplete quote snapshot')
        return {'market':'HK','asof':iso(now),'is_open':is_open,'instruments':records}

PROVIDERS={'alpaca':AlpacaData,'longbridge':LongbridgeData}
