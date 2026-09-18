"""Fetch daily OHLCV for the independent strategy study.

Try AkShare first, then Tushare when a token is available. No token is printed
or written to the output. Run from the repository root with the quant-system
conda environment. Outputs under data/daily are ignored by Git.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
from datetime import date, datetime, timezone
from pathlib import Path

import pandas as pd


ROOT = Path(__file__).resolve().parents[1]
SPECS = {"US": ("SPY", "105.SPY", "SPY"),
         "HK": ("0700.HK", "00700", "00700.HK"),
         "CN": ("600000.SH", "600000", "600000.SH")}


def token() -> str | None:
    value = os.getenv("TUSHARE_TOKEN", "").strip()
    path = ROOT / "data" / "tushare_token.txt"
    if not value and path.is_file():
        value = path.read_text(encoding="utf-8-sig").strip()
    return value or None


def akshare_daily(market: str, code: str, start: str, end: str):
    import akshare as ak
    if market == "US":
        frame = ak.stock_us_hist(symbol=code, period="daily", start_date=start, end_date=end, adjust="")
    elif market == "HK":
        frame = ak.stock_hk_hist(symbol=code, period="daily", start_date=start, end_date=end, adjust="")
    else:
        frame = ak.stock_zh_a_hist(symbol=code, period="daily", start_date=start, end_date=end, adjust="")
    return frame.rename(columns={"日期": "date", "开盘": "open", "最高": "high",
                                 "最低": "low", "收盘": "close", "成交量": "volume"}), f"AkShare {ak.__version__} / Eastmoney"


def tushare_daily(market: str, code: str, start: str, end: str, credential: str):
    import tushare as ts
    pro = ts.pro_api(credential)
    arguments = {"ts_code": code, "start_date": start, "end_date": end}
    endpoint = {"US": "us_daily", "HK": "hk_daily", "CN": "daily"}[market]
    frame = getattr(pro, endpoint)(**arguments)
    return frame.rename(columns={"trade_date": "date", "vol": "volume"}), f"Tushare {ts.__version__} / {endpoint}"


def yahoo_us_daily(symbol: str, start: str, end: str):
    from quant_system.data import load_yahoo
    frame = load_yahoo([symbol], start=pd.Timestamp(start).strftime("%Y-%m-%d"),
                       end=pd.Timestamp(end).strftime("%Y-%m-%d"))
    frame = frame.rename(columns={"timestamp": "date"}).drop(columns="symbol")
    return frame, "Yahoo Finance Chart / project adapter"


def normalize(frame: pd.DataFrame, market: str) -> tuple[pd.DataFrame, dict]:
    required = ["date", "open", "high", "low", "close", "volume"]
    if not all(column in frame.columns for column in required):
        raise ValueError(f"missing required OHLCV columns: {sorted(set(required)-set(frame.columns))}")
    result = frame[required].copy()
    result["date"] = pd.to_datetime(result["date"], errors="coerce").dt.strftime("%Y-%m-%d")
    for column in required[1:]:
        result[column] = pd.to_numeric(result[column], errors="coerce")
    if market == "CN":
        result["volume"] *= 100  # Both suppliers describe A-share daily volume in hands.
    qa = {"raw_rows": len(result), "duplicate_dates": int(result.duplicated("date").sum())}
    if qa["duplicate_dates"]:
        raise ValueError(f"duplicate trading dates: {qa['duplicate_dates']}")
    good = (result[required].notna().all(axis=1) & (result[["open", "high", "low", "close"]] > 0).all(axis=1)
            & (result["volume"] >= 0) & (result["high"] >= result[["open", "close", "low"]].max(axis=1))
            & (result["low"] <= result[["open", "close", "high"]].min(axis=1)))
    qa["invalid_rows"] = int((~good).sum())
    result = result.loc[good].sort_values("date").reset_index(drop=True)
    qa["accepted_rows"] = len(result)
    qa["zero_volume_rows"] = int((result["volume"] == 0).sum())
    qa["close_change_over_25pct"] = int((result["close"].pct_change().abs() > 0.25).sum())
    if len(result) < 252:
        raise ValueError(f"need at least 252 valid daily bars, got {len(result)}")
    return result, qa


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--start", default="20200101")
    parser.add_argument("--end", default=date.today().strftime("%Y%m%d"))
    parser.add_argument("--markets", nargs="+", choices=SPECS, default=list(SPECS))
    parser.add_argument("--provider", choices=("auto", "akshare", "tushare", "yahoo"), default="auto")
    args = parser.parse_args()
    out = ROOT / "data" / "daily"
    out.mkdir(parents=True, exist_ok=True)
    credential = token()
    failures = 0
    for market in args.markets:
        symbol, ak_code, ts_code = SPECS[market]
        errors = []
        providers = ("akshare", "tushare", "yahoo") if args.provider == "auto" and market == "US" else (
            ("akshare", "tushare") if args.provider == "auto" else (args.provider,))
        for provider in providers:
            if provider == "tushare" and not credential:
                errors.append("Tushare: token absent")
                continue
            if provider == "yahoo" and market != "US":
                errors.append("Yahoo fallback is configured only for US")
                continue
            try:
                raw, source = (akshare_daily(market, ak_code, args.start, args.end) if provider == "akshare"
                               else tushare_daily(market, ts_code, args.start, args.end, credential) if provider == "tushare"
                               else yahoo_us_daily(symbol, args.start, args.end))
                data, qa = normalize(raw, market)
                csv_path = out / f"{market}_{symbol.replace('.', '_')}.csv"
                data.to_csv(csv_path, index=False)
                digest = hashlib.sha256(csv_path.read_bytes()).hexdigest()
                metadata = {"market": market, "symbol": symbol, "source": source,
                            "adjust": "split_dividend_adjusted" if provider == "yahoo" else "unadjusted",
                            "fetched_at": datetime.now(timezone.utc).isoformat(), "from": data.iloc[0]["date"],
                            "to": data.iloc[-1]["date"], "sha256_csv": digest, "qa": qa}
                csv_path.with_suffix(".meta.json").write_text(json.dumps(metadata, ensure_ascii=False, indent=2), encoding="utf-8")
                print(f"{market} {symbol}: {len(data)} rows from {source} -> {csv_path}")
                break
            except Exception as exc:
                errors.append(f"{provider}: {type(exc).__name__}: {exc}")
        else:
            failures += 1
            print(f"{market} {symbol}: FAILED; {' | '.join(errors)}")
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
