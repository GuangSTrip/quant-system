"""Check actual selected/old comparison fills against cached daily liquidity."""
from pathlib import Path
import json,sys
import pandas as pd
ROOT=Path(__file__).resolve().parents[1];OUT=ROOT/'reports/own_daily_v4'
def main():
    audit=[]
    for m in ['CN','HK','US']:
        base=OUT/('expanded/US' if m=='US' else m)
        for label,path in [('selected',OUT/'risk'/m/'selected_trades.csv'),('old',base/'previous_strategy_corrected_trades.csv')]:
            trades=pd.read_csv(path);bad=[]
            for s,g in trades.groupby('symbol'):
                f=pd.read_csv(ROOT/'data/own_daily_v1'/m/(s+'.csv.gz')).set_index('date');q=f.reindex(g.date)
                for d in q.index[(q.volume.fillna(0)<=0)|q.open.isna()|(q.open<=0)]:bad.append(dict(symbol=s,date=d))
            audit.append(dict(market=m,case=label,trades=len(trades),invalid_fills=bad))
    (OUT/'FILL_AUDIT.json').write_text(json.dumps(audit,ensure_ascii=False,indent=2),encoding='utf8')
    if any(x['invalid_fills'] for x in audit):raise ValueError('invalid execution bars')
    print(json.dumps(dict(audited=sum(x['trades'] for x in audit),invalid_fills=0)))
if __name__=='__main__':main()
