"""Cache compact A-share market-wide daily bars for historical universe tests.

One gzip file per exchange session allows resumable downloads. All stocks'
open, adjusted prior close, close, volume and turnover are kept because a
future ranker must be able to evaluate an entrant using information available
on that historical date. The cache has a strict size cap.
"""
from __future__ import annotations

import argparse
import gzip
import json
from datetime import datetime, timezone

import tushare as ts

from fetch_daily_strategy_data import ROOT, token


FIELDS = ("ts_code", "trade_date", "open", "close", "pre_close", "vol", "amount", "pct_chg")
START = "20240101"
END = "20260917"
MAX_BYTES = 1024 * 1024 * 1024


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--start", default=START)
    parser.add_argument("--end", default=END)
    parser.add_argument("--max-mb", type=float, default=1024)
    args = parser.parse_args()
    maximum = int(args.max_mb * 1024 * 1024)
    output = ROOT / "data" / "point_in_time_cn"
    output.mkdir(parents=True, exist_ok=True)
    api = ts.pro_api(token())
    calendar = api.trade_cal(exchange="SSE", start_date=args.start, end_date=args.end)
    dates = sorted(calendar.loc[calendar.is_open.astype(str) == "1", "cal_date"].astype(str))
    if not dates:
        raise RuntimeError("No trading sessions returned")
    size = sum(path.stat().st_size for path in output.glob("*.csv.gz"))
    print("planned sessions", len(dates), "cached MB", round(size / 1024**2, 2), flush=True)
    for index, day in enumerate(dates, 1):
        path = output / f"{day}.csv.gz"
        if path.exists():
            continue
        frame = api.daily(trade_date=day, fields=",".join(FIELDS))
        if len(frame) < 1000 or not set(FIELDS).issubset(frame.columns):
            raise RuntimeError(f"{day}: incomplete market-wide daily bars ({len(frame)})")
        frame = frame.loc[:, FIELDS].sort_values("ts_code")
        blob = gzip.compress(frame.to_csv(index=False).encode("utf-8"), compresslevel=6)
        if size + len(blob) > maximum:
            raise RuntimeError(f"Storage cap reached before {day}: {size/1024**2:.1f} MB used, "
                               f"next day {len(blob)/1024:.0f} KB; ask user before increasing cap")
        temporary = path.with_name(path.name + ".tmp")
        temporary.write_bytes(blob)
        temporary.replace(path)
        size += len(blob)
        if index % 25 == 0 or index == len(dates):
            print("sessions", index, "/", len(dates), "stored MB", round(size / 1024**2, 2), flush=True)
    metadata = {"source": "Tushare daily", "start": args.start, "end": args.end,
                "sessions": len(dates), "cached_sessions": sum((output / f"{day}.csv.gz").exists() for day in dates),
                "fields": FIELDS, "bytes": size, "cap_bytes": maximum,
                "generated_at": datetime.now(timezone.utc).isoformat()}
    (output / "manifest.json").write_text(json.dumps(metadata, ensure_ascii=False, indent=2), encoding="utf-8")
    print("complete", metadata["cached_sessions"], "/", len(dates), flush=True)


if __name__ == "__main__":
    main()
