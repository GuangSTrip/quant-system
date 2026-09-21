"""Reproduce the own strategy on the exact bundled classroom minute snapshot, offline."""
from pathlib import Path
import argparse,json,sys
ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT))
from quant_system.intraday import split_sessions,backtest_intraday,DEFAULT_CONFIG
p=argparse.ArgumentParser(description=__doc__);p.add_argument('--symbol',default='TSLA');p.add_argument('--budget',type=float,default=2000);p.add_argument('--cost-bps',type=float,default=10);p.add_argument('--output',type=Path,default=ROOT/'reports/own-strategy-reproduction.json');args=p.parse_args()
source=json.loads((ROOT/'web_platform/src/own-research.json').read_text(encoding='utf-8'));bars=[dict(zip(source['columns'],r)) for r in source['symbols'][args.symbol]]
sessions=split_sessions(bars);report=backtest_intraday([sessions[d] for d in sorted(sessions)],DEFAULT_CONFIG,args.budget,args.cost_bps)
report.update(symbol=args.symbol,budget=args.budget,cost_bps=args.cost_bps,config=DEFAULT_CONFIG,sample_sha256=source['sha256'],source=source['source'],scope='Fixed-symbol research, not a dynamic-universe portfolio backtest',from_date=str(min(sessions)),to_date=str(max(sessions)))
args.output.parent.mkdir(parents=True,exist_ok=True);args.output.write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8');print(json.dumps({k:report[k] for k in ['symbol','total_return','final_cash','from_date','to_date']}));print('trades',len(report['trades']))
