"""Fetch authorized A-share 1-minute history in monthly chunks.

Run from repository root. Reads the same ignored data/tushare_token.txt file
as the daily fetcher; never prints or persists the credential.
"""

from __future__ import annotations

import argparse
import hashlib
import json
from datetime import datetime, timezone
from pathlib import Path

import pandas as pd

from fetch_daily_strategy_data import token


ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "web_platform" / "demo-data" / "library-inputs"
CHUNKS = ROOT / "data" / "minute_chunks" / "600000_SH"


def normalize(frames: list[pd.DataFrame]) -> tuple[list[dict], dict]:
    data = pd.concat(frames, ignore_index=True)
    fields = ("trade_time", "open", "high", "low", "close", "vol")
    if not all(name in data.columns for name in fields):
        raise ValueError(f"missing columns: {sorted(set(fields)-set(data.columns))}")
    qa = {"raw_rows": len(data), "duplicate_timestamps": int(data.duplicated("trade_time").sum()),
          "invalid_ohlcv": 0, "off_session": 0}
    if qa["duplicate_timestamps"]:
        raise ValueError("duplicate timestamps across chunks")
    bars = []
    for row in data.to_dict("records"):
        try:
            stamp = pd.Timestamp(row["trade_time"])
            minute = stamp.hour * 60 + stamp.minute
            if not (570 <= minute < 690 or 780 <= minute < 900):
                qa["off_session"] += 1
                continue
            o, h, l, c, v = (float(row[name]) for name in fields[1:])
            if not all(pd.notna(x) for x in (o, h, l, c, v)) or not (
                o > 0 and l > 0 and c > 0 and h >= max(o, c) and l <= min(o, c) and v >= 0
            ):
                qa["invalid_ohlcv"] += 1
                continue
            bars.append({"t": stamp.tz_localize("Asia/Shanghai").isoformat(),
                         "o": o, "h": h, "l": l, "c": c, "v": v})
        except (ValueError, TypeError, OverflowError):
            qa["invalid_ohlcv"] += 1
    bars.sort(key=lambda bar: bar["t"])
    daily = pd.Series([bar["t"][:10] for bar in bars]).value_counts().sort_index()
    qa["accepted_rows"] = len(bars)
    qa["days"] = len(daily)
    qa["bars_per_day_min"] = int(daily.min()) if len(daily) else 0
    qa["days_below_220_bars"] = int((daily < 220).sum())
    qa["sha256_bars"] = hashlib.sha256(json.dumps(bars, sort_keys=True).encode()).hexdigest()
    if qa["days"] < 20 or qa["days_below_220_bars"]:
        raise ValueError(f"insufficient or incomplete minute days: {qa}")
    return bars, qa


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--start", default="2026-01")
    parser.add_argument("--end", default="2026-09")
    parser.add_argument("--max-calls", type=int, default=1,
                        help="new API requests in this invocation; default respects trial rate limits")
    args = parser.parse_args()
    credential = token()
    if not credential:
        print("Tushare token not found in environment or data/tushare_token.txt")
        return 1
    import tushare as ts

    pro = ts.pro_api(credential)
    CHUNKS.mkdir(parents=True, exist_ok=True)
    requested = 0
    months = list(pd.period_range(args.start, args.end, freq="M"))
    for month in months:
        saved = CHUNKS / f"{month}.csv"
        if saved.is_file():
            continue
        if requested >= args.max_calls:
            break
        start = f"{month.start_time:%Y-%m-%d} 00:00:00"
        end = f"{month.end_time:%Y-%m-%d} 23:59:59"
        try:
            frame = pro.stk_mins(ts_code="600000.SH", freq="1min", start_date=start, end_date=end)
        except Exception as exc:
            print(f"{month}: {type(exc).__name__}: {exc}")
            break
        requested += 1
        print(f"{month}: {len(frame)} rows")
        if len(frame) >= 8000:
            raise ValueError(f"{month}: possible 8000-row truncation; split the chunk")
        if frame.empty:
            raise ValueError(f"{month}: empty response; inspect the trading calendar before retrying")
        frame.to_csv(saved, index=False)
    missing = [str(month) for month in months if not (CHUNKS / f"{month}.csv").is_file()]
    if missing:
        print(f"Partial archive: {len(months)-len(missing)}/{len(months)} months. Run again after API rate limit resets; next missing: {missing[0]}")
        return 0
    chunks = [pd.read_csv(CHUNKS / f"{month}.csv") for month in months]
    bars, qa = normalize(chunks)
    payload = {"market": "CN", "symbol": "600000.SH", "timeframe": "1Min",
               "sample_kind": "historical", "source": f"Tushare {ts.__version__} / stk_mins",
               "adjust": "unadjusted", "fetched_at": datetime.now(timezone.utc).isoformat(),
               "qa": qa, "bars": bars}
    OUT.mkdir(parents=True, exist_ok=True)
    path = OUT / "tushare-CN-600000-SH.json"
    path.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
    print(f"Saved {qa['accepted_rows']} bars across {qa['days']} days to {path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
