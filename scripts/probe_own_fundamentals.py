"""Read-only availability/PIT probe. Financial data only, never account data."""
from pathlib import Path
import json,os
from own_daily_data import save_json,safe_error
ROOT=Path(__file__).resolve().parents[1]
def plain(x):
    if x is None or isinstance(x,(str,int,float,bool)):return x
    if isinstance(x,dict):return {str(k):plain(v) for k,v in x.items()}
    if isinstance(x,(list,tuple)):return [plain(v) for v in x]
    return {k:plain(getattr(x,k)) for k in dir(x) if not k.startswith('_') and not callable(getattr(x,k))}
def probe_fundamentals(market):
    out=ROOT/'data/own_fundamental_probe';out.mkdir(parents=True,exist_ok=True);audit=[]
    if market=='CN':
        from myquant_data import MyQuantData
        p=MyQuantData()
        calls=[('annual_original',lambda:p.api.stk_get_finance_prime('SHSE.600036',fields='roe,eps_basic',rpt_type=12,data_type=101,start_date='2014-01-01',end_date='2025-12-31',df=True)),
            ('asof_2015',lambda:p.api.stk_get_finance_prime_pt('SHSE.600036,SHSE.600519,SZSE.000858',fields='roe,eps_basic',rpt_type=12,data_type=101,date='2015-06-30',df=True)),
            ('quality_fields_2015',lambda:p.api.stk_get_finance_prime_pt('SHSE.600036,SHSE.600519,SZSE.000858',fields='ttl_ast,ttl_liab,net_prof_pcom,ttl_eqy_pcom,net_cf_oper,inc_oper',rpt_type=12,data_type=101,date='2015-06-30',df=True)),
            ('valuation_2015',lambda:p.api.stk_get_daily_valuation_pt('SHSE.600036,SHSE.600519,SZSE.000858',fields='pe_ttm',trade_date='2015-06-30',df=True))]
        for name,fn in calls:
            try:
                frame=fn();frame.to_csv(out/('CN_'+name+'.csv'),index=False)
                item=dict(name=name,status='ok',rows=len(frame),columns=list(frame.columns))
            except Exception as e:item=dict(name=name,status='failed',error_type=type(e).__name__,error=safe_error(e))
            audit.append(item);print(json.dumps(item,ensure_ascii=False),flush=True)
    else:
        from longbridge.openapi import Config,FundamentalContext
        config=Config.from_apikey(app_key=os.environ['LONGBRIDGE_APP_KEY'],app_secret=os.environ['LONGBRIDGE_APP_SECRET'],access_token=os.environ['LONGBRIDGE_ACCESS_TOKEN'],http_url='https://openapi.longbridge.com',enable_papertrading=True,enable_print_quote_packages=False)
        p=FundamentalContext(config)
        for s in ['700.HK','AAPL.US']:
            try:
                response=plain(p.financial_report(s));save_json(out/(s+'_financial_report.json'),response)
                item=dict(symbol=s,status='ok',top_level_keys=list(response))
            except Exception as e:item=dict(symbol=s,status='failed',error_type=type(e).__name__,error=safe_error(e))
            audit.append(item);print(json.dumps(item,ensure_ascii=False),flush=True)
    save_json(out/(market+'_audit.json'),audit)
