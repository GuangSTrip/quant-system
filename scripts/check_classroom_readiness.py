"""Read-only configuration/data readiness. Never prints credentials or places orders."""
import json,os
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
def main():
    broker={name:{'configured':all(bool(os.getenv(k)) for k in keys),'required_environment':keys,'verified_external_fills':False} for name,keys in {
        'Alpaca Paper':['ALPACA_PAPER_API_KEY','ALPACA_PAPER_API_SECRET'],
        'Longbridge Paper':['LONGBRIDGE_APP_KEY','LONGBRIDGE_APP_SECRET','LONGBRIDGE_ACCESS_TOKEN']}.items()}
    cache={'US':len(list((ROOT/'data/modular_daily/US').glob('*.csv.gz'))),'HK':len(list((ROOT/'data/modular_daily/HK').glob('*.csv.gz'))),'CN_daily':len(list((ROOT/'data/point_in_time_cn').glob('*.csv.gz'))),'CN_fundamentals':len(list((ROOT/'data/modular_daily/CN_basic').glob('*.csv.gz')))}
    print(json.dumps({'broker_readiness':broker,'portfolio_cache_counts':cache,'note':'配置存在不等于连接成功；外部接单和成交须由券商回报验证。'},ensure_ascii=False,indent=2))
if __name__=='__main__':main()
