"""Read public security names from configured providers; never access trading APIs."""
import json
from pathlib import Path
from datetime import datetime, timezone
from portfolio_providers import AlpacaData, PROVIDERS
from myquant_data import MyQuantData, native

root=Path(__file__).resolve().parents[1]
config=json.loads((root/'configs/portfolio_service.local.json').read_text(encoding='utf-8'))
target=root/'web_platform/src/stock-names.json'
out=json.loads(target.read_text(encoding='utf-8')) if target.exists() else {'names':{}}
for market,options in config['markets'].items():
    wanted=options['symbols']; names={}
    try:
        if market=='US':
            assets=AlpacaData().get('/v2/assets',{'status':'active'})
            names={r['symbol']:r['name'] for r in assets if r.get('symbol') in wanted and r.get('name')}
        elif market=='HK':
            provider=PROVIDERS[options['provider']]()
            names={str(int(r.symbol.split('.')[0]))+'.HK':r.name_cn or r.name_en for r in provider.context.static_info(wanted)}
        else:
            rows=MyQuantData().api.get_symbol_infos(1010,symbols=[native(s) for s in wanted],df=True).to_dict('records')
            lookup={native(s):s for s in wanted}
            for r in rows:
                name=r.get('sec_name') or r.get('symbol_name') or r.get('name')
                if name and r.get('symbol') in lookup:names[lookup[r['symbol']]]=str(name)
        out['names'].update(names)
        print(market,'verified names',len(names),'of',len(wanted),flush=True)
    except Exception as error:
        print(market,'name lookup failed',type(error).__name__,flush=True)
out['updated_at']=datetime.now(timezone.utc).isoformat()
out['sources']={'US':'Alpaca asset directory','HK':'Longbridge static_info','CN':'MyQuant get_symbol_infos'}
target.write_text(json.dumps(out,ensure_ascii=False,indent=2),encoding='utf-8')
