"""Original annual reports available at historical quarterly observation dates."""
from pathlib import Path
import json,hashlib,time
import pandas as pd
from myquant_data import MyQuantData
from own_daily_data import save_json,safe_error
ROOT=Path(__file__).resolve().parents[1]
def collect():
    out=ROOT/'data/own_fundamental_cn';out.mkdir(parents=True,exist_ok=True)
    records=json.loads((ROOT/'data/own_daily_v1/CN_universe.json').read_text())['records']
    calendar=pd.read_csv(ROOT/'data/own_daily_v1/CN/SHSE.600036.csv.gz').date
    dates=[str(calendar[calendar<=d.strftime('%Y-%m-%d')].iloc[-1]) for d in pd.date_range('2014-12-31','2025-09-30',freq='Q')]
    manifest=json.loads((out/'manifest.json').read_text()) if (out/'manifest.json').exists() else {}
    p=MyQuantData()
    for day in dates:
        if manifest.get(day,{}).get('status')=='ok':continue
        symbols=[r['symbol'] for r in records if r['listed']<=day and (not r.get('delisted') or r['delisted']>day)];frames=[]
        try:
            for start in range(0,len(symbols),500):
                parts=out/'parts';parts.mkdir(exist_ok=True);checkpoint=parts/(day+'_'+str(start)+'.csv.gz')
                if checkpoint.exists():frames.append(pd.read_csv(checkpoint));continue
                financial_parts=[];valuation_parts=[]
                for offset in range(start,min(start+500,len(symbols)),100):
                    subcheckpoint=parts/(day+'_small_'+str(offset)+'.csv.gz')
                    if subcheckpoint.exists():
                        cached=pd.read_csv(subcheckpoint)
                        financial_parts.append(cached.drop(columns=['pe_ttm','trade_date'],errors='ignore'))
                        valuation_parts.append(cached[['symbol','pe_ttm','trade_date']])
                        continue
                    batch=','.join(symbols[offset:min(offset+100,start+500)])
                    print(json.dumps(dict(date=day,batch=offset,phase='annual_reports_100')),flush=True)
                    fast_path=parts/(day+'_annual100_'+str(offset)+'.csv.gz')
                    fast_attempt=parts/(day+'_attempt100_'+str(offset)+'.json')
                    tiny_offsets=range(offset,min(offset+100,start+500,len(symbols)),20)
                    has_small_cache=any((parts/(day+'_annual20_'+str(i)+'.csv.gz')).exists() for i in tiny_offsets)
                    if not fast_path.exists() and not fast_attempt.exists() and not has_small_cache:
                        save_json(fast_attempt,1)
                        fast=p.api.stk_get_finance_prime_pt(batch,fields='ttl_ast,net_prof_pcom,ttl_eqy_pcom,net_cf_oper',rpt_type=12,data_type=101,date=day,df=True)
                        if not fast.empty:fast.to_csv(fast_path,index=False,compression='gzip')
                    annual=[pd.read_csv(fast_path)] if fast_path.exists() else []
                    for tiny in ([] if annual else tiny_offsets):
                        annual_path=parts/(day+'_annual20_'+str(tiny)+'.csv.gz')
                        if annual_path.exists():annual.append(pd.read_csv(annual_path));continue
                        attempt_path=parts/(day+'_attempt20_'+str(tiny)+'.json')
                        attempts=json.loads(attempt_path.read_text()) if attempt_path.exists() else 0
                        if attempts>=2:
                            gaps_path=out/'retrieval_gaps.json'
                            gaps=json.loads(gaps_path.read_text()) if gaps_path.exists() else {}
                            gaps[day+'_'+str(tiny)]=dict(date=day,symbols=symbols[tiny:min(tiny+20,offset+100)],reason='two interrupted requests without a response; excluded, not imputed')
                            save_json(gaps_path,gaps)
                            print(json.dumps(dict(date=day,batch=tiny,phase='missing_after_two_interrupted_requests')),flush=True)
                            continue
                        save_json(attempt_path,attempts+1)
                        print(json.dumps(dict(date=day,batch=tiny,phase='annual_reports_20')),flush=True)
                        z=p.api.stk_get_finance_prime_pt(','.join(symbols[tiny:min(tiny+20,offset+100)]),fields='ttl_ast,net_prof_pcom,ttl_eqy_pcom,net_cf_oper',rpt_type=12,data_type=101,date=day,df=True)
                        save_json(attempt_path,0)
                        if not z.empty:z.to_csv(annual_path,index=False,compression='gzip');annual.append(z)
                    a=pd.concat(annual,ignore_index=True) if annual else pd.DataFrame()
                    time.sleep(.15)
                    print(json.dumps(dict(date=day,batch=offset,phase='valuation_100')),flush=True)
                    b=p.api.stk_get_daily_valuation_pt(batch,fields='pe_ttm',trade_date=day,df=True)
                    financial_parts.append(a);valuation_parts.append(b)
                    if not a.empty and not b.empty:
                        a.merge(b[['symbol','pe_ttm','trade_date']],on='symbol',how='left',validate='one_to_one').to_csv(subcheckpoint,index=False,compression='gzip')
                    time.sleep(.15)
                f=pd.concat(financial_parts,ignore_index=True);v=pd.concat(valuation_parts,ignore_index=True)
                if f.empty:continue
                if f.symbol.duplicated().any():raise ValueError('duplicate report symbols')
                if (f.pub_date.astype(str).str[:10]>day).any():raise ValueError('future publication returned')
                if not v.empty:
                    if (v.trade_date.astype(str).str[:10]>day).any():raise ValueError('future valuation returned')
                    f=f.merge(v[['symbol','pe_ttm','trade_date']],on='symbol',how='left',validate='one_to_one')
                else:f['pe_ttm']=float('nan');f['trade_date']=None
                f['asof']=day;f.to_csv(checkpoint,index=False,compression='gzip');frames.append(f)
            if not frames:raise ValueError('no reports returned')
            frame=pd.concat(frames,ignore_index=True);path=out/(day+'.csv.gz');frame.to_csv(path,index=False,compression='gzip')
            item=dict(status='ok',requested=len(symbols),rows=len(frame),non_null={k:int(frame[k].notna().sum()) for k in ['ttl_ast','net_prof_pcom','ttl_eqy_pcom','net_cf_oper','pe_ttm']},sha256=hashlib.sha256(path.read_bytes()).hexdigest())
        except Exception as e:
            item=dict(status='failed',error_type=type(e).__name__,error=safe_error(e));manifest[day]=item;save_json(out/'manifest.json',manifest);print(json.dumps(dict(date=day,**item),ensure_ascii=False),flush=True);raise
        manifest[day]=item;save_json(out/'manifest.json',manifest);print(json.dumps(dict(date=day,**item)),flush=True)
    save_json(out/'collection.json',dict(source='MyQuant stk_get_finance_prime_pt original annual data_type=101 + daily valuation PIT',dates=dates,complete=len(manifest)==len(dates),retrieval_gaps=(out/'retrieval_gaps.json').exists(),fields='assets,attributable_profit,attributable_equity,operating_cashflow,pe_ttm',publication_checked=True))
if __name__=='__main__':collect()
