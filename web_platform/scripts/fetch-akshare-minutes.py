"""Fetch recent Eastmoney 1-minute bars through AkShare for local research.

Run: conda run -n quant-system python web_platform/scripts/fetch-akshare-minutes.py
The output directory is git-ignored. AkShare's one-minute history is short and
unadjusted; this script never labels it as a long-term validation sample.
"""

from __future__ import annotations

import argparse
import hashlib
import json
from datetime import datetime, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

import pandas as pd


SPECS = {
    "US": ("SPY", "105.SPY", "America/New_York"),
    "HK": ("0700.HK", "00700", "Asia/Hong_Kong"),
    "CN": ("600000.SH", "600000", "Asia/Shanghai"),
}
SOURCE_ZONE = ZoneInfo("Asia/Shanghai")  # Eastmoney timestamps, including US bars
OUTPUT = Path(__file__).resolve().parents[1] / "demo-data" / "library-inputs"


def fetch(ak, market: str, code: str) -> pd.DataFrame:
    if market == "US":
        return ak.stock_us_hist_min_em(symbol=code)
    if market == "HK":
        return ak.stock_hk_hist_min_em(symbol=code, period="1", adjust="")
    return ak.stock_zh_a_hist_min_em(symbol=code, period="1", adjust="")


def normalize(frame: pd.DataFrame, market: str) -> tuple[list[dict], dict]:
    required = ("时间", "开盘", "最高", "最低", "收盘", "成交量")
    missing = [name for name in required if name not in frame]
    if missing:
        raise ValueError(f"missing columns: {missing}")
    seen: set[str] = set()
    bars: list[dict] = []
    qa = {"raw_rows": len(frame), "duplicate_timestamps": 0,
          "invalid_ohlcv": 0, "zero_volume": 0, "off_session": 0}
    zone = ZoneInfo(SPECS[market][2])
    sessions = {"US": ((570, 960),), "HK": ((570, 720), (780, 960)),
                "CN": ((570, 690), (780, 900))}[market]
    for row in frame.to_dict("records"):
        try:
            stamp = pd.Timestamp(row["时间"])
            if stamp.tzinfo is None:
                stamp = stamp.tz_localize(SOURCE_ZONE)
            local = stamp.tz_convert(zone)
            minute = local.hour * 60 + local.minute
            key = stamp.isoformat()
            if key in seen:
                qa["duplicate_timestamps"] += 1
                continue
            seen.add(key)
            if not any(start <= minute < end for start, end in sessions):
                qa["off_session"] += 1
                continue
            o, h, l, c, v = (float(row[name]) for name in required[1:])
            if market == "CN":
                v *= 100  # Eastmoney A-share volume is in hands (100 shares).
            if not all(pd.notna(x) for x in (o, h, l, c, v)) or not (
                o > 0 and c > 0 and l > 0 and h >= max(o, c) and l <= min(o, c) and v >= 0
            ):
                qa["invalid_ohlcv"] += 1
                continue
            if v == 0:
                qa["zero_volume"] += 1
            bars.append({"t": stamp.isoformat(), "o": o, "h": h, "l": l, "c": c, "v": v})
        except (ValueError, TypeError, OverflowError):
            qa["invalid_ohlcv"] += 1
    bars.sort(key=lambda bar: bar["t"])
    by_day: dict[str, int] = {}
    for bar in bars:
        day = pd.Timestamp(bar["t"]).tz_convert(zone).date().isoformat()
        by_day[day] = by_day.get(day, 0) + 1
    qa["accepted_rows"] = len(bars)
    qa["rows_by_local_day"] = by_day
    expected = {"US": 390, "HK": 330, "CN": 240}[market]
    qa["missing_minutes_by_local_day_diagnostic"] = {
        day: max(0, expected - count) for day, count in by_day.items()
    }  # Early closes, halts, and vendor timestamp conventions need manual review.
    qa["sha256_bars"] = hashlib.sha256(json.dumps(bars, sort_keys=True).encode()).hexdigest()
    return bars, qa


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--markets", nargs="+", choices=SPECS, default=list(SPECS))
    parser.add_argument("--output", type=Path, default=OUTPUT)
    args = parser.parse_args()
    import akshare as ak

    args.output.mkdir(parents=True, exist_ok=True)
    failures = 0
    for market in args.markets:
        symbol, code, _ = SPECS[market]
        try:
            frame = fetch(ak, market, code)
            bars, qa = normalize(frame, market)
            expected = {"US": 390, "HK": 330, "CN": 240}[market]
            if len(qa["rows_by_local_day"]) < 2 or min(qa["rows_by_local_day"].values()) < expected * 0.8:
                raise ValueError(f"insufficient usable minutes: {qa}")
            now = datetime.now(timezone.utc).isoformat()
            payload = {"market": market, "symbol": symbol, "timeframe": "1Min",
                       "sample_kind": "historical", "source": f"AkShare {ak.__version__} / Eastmoney",
                       "fetched_at": now, "adjust": "unadjusted", "bars": bars, "qa": qa}
            path = args.output / f"akshare-{market}-{symbol.replace('.', '-')}.json"
            path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
            print(f"{market} {symbol}: {len(bars)} bars, {len(qa['rows_by_local_day'])} days -> {path}")
        except Exception as exc:
            failures += 1
            print(f"{market} {symbol}: FETCH FAILED: {type(exc).__name__}: {exc}")
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
