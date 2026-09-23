"""CN quality/value from historical original reports, no current-report backfill."""
from pathlib import Path
import json,hashlib
import numpy as np
import pandas as pd

def load_snapshots(p,root):
    manifest=json.loads((root/'manifest.json').read_text());snapshots=[];dates=[]
    for day,row in sorted(manifest.items()):
        if row['status']!='ok':raise ValueError('incomplete financial snapshot')
        path=root/(day+'.csv.gz')
        if hashlib.sha256(path.read_bytes()).hexdigest()!=row['sha256']:raise ValueError('financial hash mismatch')
        f=pd.read_csv(path)
        if f.symbol.duplicated().any() or (f.pub_date.astype(str).str[:10]>day).any():raise ValueError('invalid PIT snapshot')
        if not (f.data_type==101).all():raise ValueError('not original reports')
        f=f.set_index('symbol').reindex(p.symbols)
        x={k:pd.to_numeric(f[k],errors='coerce').to_numpy(float) for k in ['ttl_ast','net_prof_pcom','ttl_eqy_pcom','net_cf_oper','pe_ttm']}
        x['report_date']=pd.to_datetime(f.rpt_date,errors='coerce').to_numpy(dtype='datetime64[D]')
        snapshots.append(x);dates.append(day)
    return np.array(dates),snapshots

def make_selector(engine,p,root):
    dates,snapshots=load_snapshots(p,root)
    def select(panel,t,c,held):
        valid,breadths=engine.design_universe(panel,c);valid=valid[t].copy();breadth=float(breadths[t]);w=np.zeros(len(panel.symbols))
        # Strictly earlier snapshot, never same-day publication availability.
        index=int(np.searchsorted(dates,panel.dates[t],side='left'))-1
        if index<0:return w,dict(eligible=0,breadth=breadth,selected=[],exposure=0.,snapshot=None)
        x=snapshots[index];age=(np.datetime64(panel.dates[t],'D')-x['report_date']).astype('timedelta64[D]').astype(float)
        assets=x['ttl_ast'];profit=x['net_prof_pcom'];equity=x['ttl_eqy_pcom'];cf=x['net_cf_oper'];pe=x['pe_ttm']
        valid&=(assets>0)&(profit>0)&(equity>0)&(cf>0)&(age>=0)&(age<=550)
        if c.family=='fundamental_value_quality':valid&=np.isfinite(pe)&(pe>0)
        def ratio(a,b):return np.divide(a,b,out=np.full(len(a),np.nan),where=b>0)
        quality=(engine.percentile(ratio(profit,assets),valid)+engine.percentile(ratio(profit,equity),valid)+engine.percentile(ratio(cf,assets),valid))/3
        score=.5*quality+.5*engine.percentile(ratio(np.ones(len(pe)),pe),valid) if c.family=='fundamental_value_quality' else quality
        ids=sorted(np.flatnonzero(valid),key=lambda i:(-score[i],panel.symbols[i]))[:25]
        if ids:
            iv=1/np.maximum(panel.features['vol'][t,ids],.10);w[ids]=np.minimum(iv/iv.sum(),.10)
            risk=float(np.std(panel.features['ret'][max(0,t-59):t+1]@w,ddof=1)*np.sqrt(252))
            exposure=.95*min(1.,c.target_vol/max(risk,.01))
            if c.regime:exposure*=float(np.clip((breadth-.35)/.35,0,1))
            w*=exposure
        return w,dict(eligible=int(valid.sum()),breadth=breadth,selected=[panel.symbols[i] for i in np.flatnonzero(w>0)],exposure=float(w.sum()),snapshot=str(dates[index]))
    return select
