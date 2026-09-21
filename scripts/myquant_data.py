"""Read-only MyQuant data adapter; no trading API or terminal account login."""
import os
from datetime import datetime,date,time,timedelta
from zoneinfo import ZoneInfo
import pandas as pd
from portfolio_providers import iso

def native(symbol):
    code,exchange=symbol.split('.')
    if exchange not in ('SH','SZ'):raise ValueError('Only Shanghai/Shenzhen supported')
    return ('SHSE.' if exchange=='SH' else 'SZSE.')+code

class MyQuantData:
    market='CN'
    def __init__(self):
        import gm.api as api
        self.api=api;api.set_token(os.environ.get('MYQUANT_DATA_TOKEN') or os.environ['MYQUANT_SIM_TOKEN'])
        self.zone=ZoneInfo('Asia/Shanghai')
    def calendar(self,now):
        days=self.api.get_trading_dates('SHSE',(now-timedelta(days=14)).date().isoformat(),(now+timedelta(days=14)).date().isoformat())
        return [{'date':d,'open':datetime.combine(date.fromisoformat(d),time(9,30),self.zone),'close':datetime.combine(date.fromisoformat(d),time(15),self.zone)} for d in days]
    def histories(self,symbols,end):
        out={}
        for symbol in symbols:
            frame=self.api.history(native(symbol),'1d','2024-01-01',end+' 15:00:00',fields='eob,open,high,low,close,volume,amount',adjust=self.api.ADJUST_PREV,df=True)
            frame['date']=pd.to_datetime(frame.eob).dt.strftime('%Y-%m-%d')
            out[symbol]=frame[['date','open','high','low','close','volume','amount']]
        return out
    def fundamentals(self,symbols,end,folder):
        frames=[]
        info=self.api.get_symbol_infos(1010,symbols=[native(s) for s in symbols],df=True)
        listing={s:str(info.loc[info.symbol==native(s),'listed_date'].iloc[0])[:10] for s in symbols}
        import json
        (folder/'CN_listing.json').write_text(json.dumps(listing),encoding='utf8')
        for symbol in symbols:
            v=self.api.stk_get_daily_valuation(native(symbol),'pe_ttm,dy_ttm','2024-01-01',end,True)
            m=self.api.stk_get_daily_mktvalue(native(symbol),'tot_mv','2024-01-01',end,True)
            if v.empty or m.empty:raise ValueError('Missing historical fundamentals')
            frame=v.merge(m[['trade_date','tot_mv']],on='trade_date',validate='one_to_one')
            frame['ts_code']=symbol
            frames.append(frame.rename(columns={'dy_ttm':'dv_ttm','tot_mv':'total_mv'}))
        target=folder/'CN_basic';target.mkdir(exist_ok=True)
        for day,frame in pd.concat(frames).groupby('trade_date'):
            if set(frame.ts_code)!=set(symbols):raise ValueError('Incomplete fundamental universe')
            frame.to_csv(target/(str(day)[:10].replace('-','')+'.csv.gz'),index=False,compression='gzip')
    def quotes(self,symbols,now,calendar):
        session=next((s for s in calendar if s['date']==now.astimezone(self.zone).date().isoformat()),None)
        local=now.astimezone(self.zone)
        opened=bool(session and session['open']<=now<session['close'] and not time(11,30)<=local.time()<time(13))
        if not opened:return {'market':'CN','asof':iso(now),'is_open':False,'instruments':[]}
        if not symbols:return None
        ids={native(s):s for s in symbols}
        rows=self.api.current(symbols=list(ids));records=[]
        info=self.api.get_symbols(1010,symbols=list(ids),skip_suspended=True,skip_st=True,trade_date=local.date().isoformat(),df=True)
        tradable=set(info.symbol) if not info.empty else set()
        for q in rows:
            records.append({'symbol':ids[q['symbol']],'price':round(float(q['price']),2),'lot':100,'tradable':q['symbol'] in tradable,'asof':iso(q['created_at'])})
        if {r['symbol'] for r in records}!=set(symbols):raise ValueError('Incomplete quote snapshot')
        return {'market':'CN','asof':iso(now),'is_open':True,'instruments':records}
