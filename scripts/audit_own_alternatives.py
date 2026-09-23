"""Audit selected research fills against observed tradable daily bars."""
from pathlib import Path
import json
import pandas as pd
ROOT=Path(__file__).resolve().parents[1];OUT=ROOT/'reports/own_alternatives'

def main():
    audit=[]
    for market,folder in [(m,OUT/m) for m in ['CN','HK','US']]+[('CN',OUT/'fundamental/CN')]:
        trades=pd.read_csv(folder/'selected_trades.csv');bad=[]
        for symbol,g in trades.groupby('symbol'):
            f=pd.read_csv(ROOT/'data/own_daily_v1'/market/(symbol+'.csv.gz')).set_index('date')
            q=f.reindex(g.date)
            for d in q.index[(q.volume.fillna(0)<=0)|q.open.isna()|(q.open<=0)]:bad.append(dict(symbol=symbol,date=d))
        audit.append(dict(market=market,case=str(folder.relative_to(OUT)),trades=len(trades),invalid_fills=bad))
    (OUT/'FILL_AUDIT.json').write_text(json.dumps(audit,indent=2),encoding='utf8')
    if any(x['invalid_fills'] for x in audit):raise ValueError('invalid execution bars')
    print(json.dumps(dict(audited=sum(x['trades'] for x in audit),invalid_fills=0)))

if __name__=='__main__':main()
