"""Passive SPY adjusted-price benchmark, same period and fee assumptions."""
from pathlib import Path
import sys,json
import pandas as pd
ROOT=Path(__file__).resolve().parents[1];sys.path.insert(0,str(ROOT))
from quant_system.own_daily import fees,metrics
from evaluate_own_daily import write

def main():
    out=ROOT/'reports/own_daily_v4/expanded/US'
    target=json.loads((out/'report.json').read_text())['selected']['full']
    f=pd.read_csv(ROOT/'data/own_daily_v4/SPY_benchmark.csv.gz');f=f[(f.date>=target['start'])&(f.date<=target['end'])].reset_index(drop=True)
    cash=1e6;lo=0.;hi=cash
    for _ in range(50):
        mid=(lo+hi)/2
        if mid+sum(fees('US',f.date.iloc[0],mid,'buy').values())<=cash:lo=mid
        else:hi=mid
    paid=sum(fees('US',f.date.iloc[0],lo,'buy').values());units=lo/f.open.iloc[0];cash-=lo+paid;last=1e6;rows=[]
    strategy=pd.read_csv(out/'selected_equity.csv');base_date=str(strategy.base_date.iloc[0])
    for i,b in enumerate(f.itertuples()):
        equity=cash+units*b.close;cost=paid if i==0 else 0
        if i==len(f)-1:
            cost+=sum(fees('US',b.date,units*b.close,'sell').values());equity-=cost
        rows.append(dict(date=b.date,base_date=base_date,base_equity=last,equity=equity,cash=cash,cost=cost,traded=lo if i==0 else 0,exposure=units*b.close/equity))
        last=equity;base_date=b.date
    curve=pd.DataFrame(rows);curve.to_csv(out/'SPY_equity.csv',index=False)
    write(out/'SPY_benchmark.json',dict(full=metrics(curve),source='Alpaca SIP adjustment=all',model='Buy first open, hold fractional adjusted units, terminal sell-fee reserve; no interest; same assumed trading costs',corporate_actions='provider adjusted series; not independently reconstructed'))
    print(json.dumps(metrics(curve)))
if __name__=='__main__':main()
