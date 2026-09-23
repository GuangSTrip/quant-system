from datetime import datetime,timezone
import sys
if '--diagnose-hk' in sys.argv:
    import json
    from pathlib import Path
    from urllib.error import HTTPError
    from portfolio_service import run_once
    from portfolio_signal import Publisher
    from portfolio_providers import LongbridgeData
    config=json.loads(Path('configs/portfolio_service.local.json').read_text())
    config['markets']={'HK':config['markets']['HK']}
    publisher=Publisher(config['site_origin'])
    try:
        run_once(config,{'HK':LongbridgeData()},publisher,{})
    except HTTPError as e:
        detail=json.loads(e.read())
        print(json.dumps({'http':e.code,'code':detail.get('code'),'error':detail.get('error')},ensure_ascii=False))
    finally:publisher.post('auth/logout',{})
    raise SystemExit(0)
from portfolio_providers import AlpacaData,LongbridgeData
from myquant_data import MyQuantData
if '--live-only' in sys.argv:
    import json
    for provider,symbols in [(LongbridgeData(),['288.HK']),(MyQuantData(),['600036.SH'])]:
        now=datetime.now(timezone.utc)
        try:
            print(json.dumps(provider.quotes(symbols,now,provider.calendar(now)),ensure_ascii=False),flush=True)
        except ValueError as error:
            if provider.market=='HK':
                q=provider.context.quote(symbols)[0]
                print(json.dumps({'market':'HK','symbol':q.symbol,'price':float(q.last_done),'timestamp':str(q.timestamp),'now_utc':now.isoformat(),'error':str(error)}),flush=True)
            else:raise
    raise SystemExit(0)
if '--screen-hk' in sys.argv:
    import json
    from pathlib import Path
    provider=LongbridgeData()
    path=Path('configs/portfolio_service.local.json');config=json.loads(path.read_text())
    candidates=list(dict.fromkeys(config['markets']['HK']['symbols']+[str(n)+'.HK' for n in [1,2,3,6,12,20,23,83,144,151,241,268,291,322,358,390,489,522,688,728,763,788,857,868,914,960,998,1044,1088,1193,1211,1288,1336,1800,1810,1928,2020,2269,2313,2331,2601,2628,3328,3690,3968,3988,6098,9618,9888,9988]]))
    accepted=[]
    for symbol in candidates:
        try:
            f=provider.histories([symbol],'2026-09-18')[symbol]
            valid=len(f)>300 and f.date.iloc[-1]=='2026-09-18' and not ((f.high<f[['open','close','low']].max(axis=1)) | (f.low>f[['open','close','high']].min(axis=1))).any() and (f[['open','high','low','close']]>0).all().all()
            if valid:accepted.append(symbol)
            print(symbol,'accepted' if valid else 'excluded: history validation',flush=True)
        except Exception:print(symbol,'excluded: provider error',flush=True)
        if len(accepted)==30:break
    if len(accepted)!=30:raise SystemExit('Not enough valid histories')
    config['markets']['HK']['symbols']=accepted;path.write_text(json.dumps(config,ensure_ascii=False,indent=2),encoding='utf8')
    raise SystemExit(0)
for cls in [AlpacaData,LongbridgeData,MyQuantData]:
    if len(sys.argv)>1 and cls.market not in sys.argv[1:]:continue
    try:
        provider=cls();sessions=provider.calendar(datetime.now(timezone.utc))
        print(cls.__name__,'calendar OK',len(sessions),flush=True)
        symbols={'US':['AAPL'],'HK':['5.HK'],'CN':['600000.SH']}[provider.market]
        frames=provider.histories(symbols,'2026-09-18')
        print(cls.__name__,'history rows', {s:len(f) for s,f in frames.items()},flush=True)
        if provider.market=='HK':
            q=provider.context.quote(['288.HK'])[0];i=provider.context.static_info(['288.HK'])[0]
            print('HK test instrument',q.symbol,float(q.last_done),i.lot_size,flush=True)
        if provider.market=='CN':
            q=provider.api.current(symbols=['SHSE.600000'])[0]
            print('CN test instrument',q['symbol'],q['price'],flush=True)
    except Exception as error:print(cls.__name__,'FAILED',type(error).__name__,str(error)[:200],flush=True)
