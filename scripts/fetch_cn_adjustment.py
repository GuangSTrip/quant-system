"""Create adjusted A-share daily prices from Tushare historical factors.

The raw OHLCV files are preserved. Adjusted OHLC is used for research signals;
raw close * raw volume remains available for liquidity estimates.
"""
from __future__ import annotations

import hashlib
import json
from datetime import datetime, timezone

import pandas as pd
import tushare as ts

from expand_daily_universe import ROOT, UNIVERSE
from fetch_daily_strategy_data import token


def main():
    credential = token()
    if not credential:
        raise RuntimeError("Tushare token is absent")
    pro = ts.pro_api(credential)
    output = ROOT / "data" / "daily_adjusted"
    output.mkdir(parents=True, exist_ok=True)
    complete, failures = [], []
    for symbol in UNIVERSE["CN"]:
        stem = f"CN_{symbol.replace('.', '_')}"
        source = ROOT / "data" / "daily" / f"{stem}.csv"
        if not source.exists():
            failures.append({"symbol": symbol, "reason": "raw_file_missing"})
            continue
        try:
            raw = pd.read_csv(source)
            factors = pro.adj_factor(ts_code=symbol, start_date="20200101", end_date="20260917")
            factors = factors[["trade_date", "adj_factor"]].copy()
            factors["date"] = pd.to_datetime(factors.trade_date.astype(str)).dt.strftime("%Y-%m-%d")
            merged = raw.merge(factors[["date", "adj_factor"]], on="date", how="left", validate="one_to_one")
            missing = int(merged.adj_factor.isna().sum())
            if missing or (merged.adj_factor <= 0).any():
                raise ValueError(f"missing or invalid factors: {missing}")
            latest = float(merged.adj_factor.iloc[-1])
            merged["raw_close"] = merged.close
            scale = merged.adj_factor / latest
            for column in ("open", "high", "low", "close"):
                merged[column] *= scale
            adjusted = merged[["date", "open", "high", "low", "close", "volume", "raw_close"]]
            path = output / f"{stem}.csv"
            adjusted.to_csv(path, index=False)
            meta = {"market": "CN", "symbol": symbol, "source": "Tushare daily + adj_factor",
                    "adjust": "factor_adjusted_to_latest_date", "from": adjusted.date.iloc[0],
                    "to": adjusted.date.iloc[-1], "rows": len(adjusted), "missing_factors": missing,
                    "raw_csv_sha256": hashlib.sha256(source.read_bytes()).hexdigest(),
                    "sha256_csv": hashlib.sha256(path.read_bytes()).hexdigest(),
                    "fetched_at": datetime.now(timezone.utc).isoformat()}
            path.with_suffix(".meta.json").write_text(json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8")
            complete.append(symbol)
            print(symbol, len(adjusted), flush=True)
        except Exception as exc:
            failures.append({"symbol": symbol, "reason": f"{type(exc).__name__}: {exc}"})
            print(symbol, "FAILED", type(exc).__name__, str(exc), flush=True)
    (output / "fetch_status.json").write_text(json.dumps({"complete": complete, "failures": failures}, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"complete {len(complete)}/{len(UNIVERSE['CN'])}", flush=True)


if __name__ == "__main__":
    main()
