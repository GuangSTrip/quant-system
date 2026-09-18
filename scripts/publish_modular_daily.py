"""Publish verified existing results without rerunning numerical experiments."""
import json
from datetime import datetime, timezone
from evaluate_modular_daily import ROOT, RULES

def main():
    public={'generated_at':datetime.now(timezone.utc).isoformat(),'rules':RULES,'markets':{}}
    for market in ('CN','HK','US'):
        path=ROOT/'reports'/'modular_daily'/(market+'.json')
        r=json.loads(path.read_text(encoding='utf8'));r['rules']=RULES
        r['metadata']['scope']=('全市场日线缓存；本次选股覆盖沪深 A 股，北交所未纳入' if market=='CN'
             else '当前交易所清单的自动抽样；有存续、下载成功及价格质量筛选偏差，非全市场验证')
        r['model']='fractional adjusted-price units; corporate actions approximated by supplier adjustment; next-open; costs; zero cash interest'
        path.write_text(json.dumps(r,ensure_ascii=False,separators=(',',':'),allow_nan=False),encoding='utf8')
        public['markets'][market]=r
    out=ROOT/'web_platform'/'src'/'modular-daily-results.json'
    out.write_text(json.dumps(public,ensure_ascii=False,separators=(',',':'),allow_nan=False),encoding='utf8')
    print('Published',sum(len(r['combinations']) for r in public['markets'].values()),'completed combinations')

if __name__=='__main__':main()
