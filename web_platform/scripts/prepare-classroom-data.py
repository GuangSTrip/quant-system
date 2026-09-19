"""Derive the public classroom SPY snapshot from the hash-pinned course dataset.
Run from repository root after scripts/prepare_low_frequency_data.py.
"""
import hashlib
import json
import sys
from pathlib import Path
root=Path(__file__).resolve().parents[2]
sys.path.insert(0,str(root))
from quant_system.data import load_yahoo_wide_csv
from scripts.prepare_low_frequency_data import SOURCE_SHA256, SOURCE_URL
source=root/'data/low_frequency_etfs_raw.csv'
assert hashlib.sha256(source.read_bytes()).hexdigest()==SOURCE_SHA256
frame=load_yahoo_wide_csv(str(source))
frame=frame[frame.symbol=='SPY'].tail(750)
bars=[dict(t=r.timestamp.strftime('%Y-%m-%d'),o=r.open,h=r.high,l=r.low,c=r.close,v=r.volume) for r in frame.itertuples()]
output={'symbol':'SPY','source':'Yahoo Finance 复权日线 · 课程冻结快照','source_url':SOURCE_URL,'source_sha256':SOURCE_SHA256,'adjustment':'OHLC 乘以 Adj Close / Close，含分红复权；不再重复派息','bars':bars}
(root/'web_platform/src/classroom-snapshot.json').write_text(json.dumps(output,ensure_ascii=False,separators=(',',':'))+'\n')
