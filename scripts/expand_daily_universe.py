"""Checkpoint a fixed, diverse daily research universe across three markets.

This is a convenience sample fixed before backtesting, not a historical
point-in-time index membership list. Existing valid files are not refetched.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import time
from datetime import datetime, timezone
from pathlib import Path

from fetch_daily_strategy_data import ROOT, normalize, token, tushare_daily, yahoo_us_daily

UNIVERSE = {
    "US": ["SPY", "QQQ", "IWM", "DIA", "EFA", "EEM", "TLT", "GLD", "XLF", "XLK",
           "AAPL", "MSFT", "JPM", "XOM", "JNJ", "KO", "PG", "CAT", "NVDA", "AMZN",
           "GOOG", "DIS", "BA", "NKE", "PFE", "CVX", "WMT", "HD", "MCD", "CSCO"],
    "HK": ["0700.HK", "0005.HK", "1299.HK", "0939.HK", "1398.HK", "0941.HK", "0388.HK", "2318.HK", "0883.HK", "1211.HK",
           "0016.HK", "0011.HK", "0027.HK", "0066.HK", "0267.HK", "0762.HK", "0823.HK", "1093.HK", "1109.HK", "1177.HK",
           "1810.HK", "1928.HK", "1997.HK", "2020.HK", "2269.HK", "2313.HK", "2382.HK", "2628.HK", "3328.HK", "3988.HK"],
    "CN": ["600000.SH", "000001.SZ", "600036.SH", "601318.SH", "600028.SH", "601857.SH", "000333.SZ", "002415.SZ", "600030.SH", "000651.SZ",
           "600887.SH", "601398.SH", "601288.SH", "600276.SH", "600309.SH", "601012.SH", "002594.SZ", "000002.SZ", "002304.SZ", "601166.SH",
           "601899.SH", "600900.SH", "600104.SH", "600438.SH", "000063.SZ", "000725.SZ", "600585.SH", "601088.SH", "002352.SZ", "000568.SZ"],
}
START, END = "20200101", "20260917"


def fetch_one(market: str, symbol: str, credential: str | None, out: Path):
    if market in ("US", "HK"):
        raw, source = yahoo_us_daily(symbol, START, END)
        adjust = "split_dividend_adjusted"
    else:
        if not credential:
            raise RuntimeError("Tushare credential absent")
        raw, source = tushare_daily(market, symbol, START, END, credential)
        adjust = "unadjusted"
    data, qa = normalize(raw, market)
    csv_path = out / f"{market}_{symbol.replace('.', '_')}.csv"
    data.to_csv(csv_path, index=False)
    metadata = {"market": market, "symbol": symbol, "source": source, "adjust": adjust,
                "fetched_at": datetime.now(timezone.utc).isoformat(), "from": data.iloc[0]["date"],
                "to": data.iloc[-1]["date"], "sha256_csv": hashlib.sha256(csv_path.read_bytes()).hexdigest(), "qa": qa}
    csv_path.with_suffix(".meta.json").write_text(json.dumps(metadata, ensure_ascii=False, indent=2), encoding="utf-8")
    return metadata


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--markets", nargs="+", choices=UNIVERSE, default=list(UNIVERSE))
    parser.add_argument("--only", nargs="+", help="retry only these symbols from the fixed universe")
    parser.add_argument("--hk-pause", type=int, default=0, help="optional seconds between HK requests")
    args = parser.parse_args()
    out = ROOT / "data" / "daily"
    out.mkdir(parents=True, exist_ok=True)
    credential = token()
    results = []
    for market in args.markets:
        for symbol in UNIVERSE[market]:
            if args.only and symbol not in args.only:
                continue
            stem = f"{market}_{symbol.replace('.', '_')}"
            meta_path = out / f"{stem}.meta.json"
            if meta_path.exists() and (out / f"{stem}.csv").exists():
                try:
                    meta = json.loads(meta_path.read_text(encoding="utf-8"))
                    if market == "HK" and "Yahoo" not in meta["source"]:
                        raise ValueError("refresh HK with consistent adjusted series")
                    results.append({"market": market, "symbol": symbol, "status": "cached", "rows": meta["qa"]["accepted_rows"]})
                    print(f"{market} {symbol}: cached {meta['qa']['accepted_rows']}", flush=True)
                    continue
                except (ValueError, KeyError):
                    pass
            try:
                meta = fetch_one(market, symbol, credential, out)
                results.append({"market": market, "symbol": symbol, "status": "ok", "rows": meta["qa"]["accepted_rows"]})
                print(f"{market} {symbol}: {meta['qa']['accepted_rows']} rows", flush=True)
            except Exception as exc:
                results.append({"market": market, "symbol": symbol, "status": "failed", "error": f"{type(exc).__name__}: {exc}"})
                print(f"{market} {symbol}: FAILED {type(exc).__name__}: {exc}", flush=True)
            if market == "HK" and symbol != UNIVERSE["HK"][-1]:
                time.sleep(max(args.hk_pause, 0))
    (out / "universe_fetch.json").write_text(json.dumps(results, ensure_ascii=False, indent=2), encoding="utf-8")
    print("Complete: " + str(sum(r["status"] != "failed" for r in results)) + "/" + str(len(results)), flush=True)


if __name__ == "__main__":
    main()
