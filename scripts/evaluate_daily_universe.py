"""Evaluate fixed daily rules on each stock in the preregistered universe.

Reports describe distributions of independent single-asset backtests; they
are not a tradable equal-weight portfolio, and do not rank assets using future
returns. No broker operation occurs here.
"""
from __future__ import annotations

import json
from datetime import datetime, timezone

import pandas as pd

from evaluate_daily_strategy import ROOT, STRATEGIES, backtest
from expand_daily_universe import UNIVERSE


def stats(rows):
    values = pd.DataFrame(rows)
    return {"assets": len(values),
            "median_holdout_pct": float(values.holdout_return_pct.median()),
            "mean_holdout_pct": float(values.holdout_return_pct.mean()),
            "median_benchmark_pct": float(values.holdout_benchmark_pct.median()),
            "mean_benchmark_pct": float(values.holdout_benchmark_pct.mean()),
            "beat_benchmark_count": int((values.holdout_return_pct > values.holdout_benchmark_pct).sum()),
            "positive_holdout_count": int((values.holdout_return_pct > 0).sum()),
            "median_holdout_drawdown_pct": float(values.holdout_max_drawdown_pct.median()),
            "median_full_pct": float(values.full_return_pct.median()),
            "median_full_benchmark_pct": float(values.full_benchmark_pct.median()),
            "median_full_drawdown_pct": float(values.full_max_drawdown_pct.median()),
            "mean_full_pct": float(values.full_return_pct.mean()),
            "cost_stress_positive_count": int((values.double_cost_return_pct > 0).sum()),
            "holdout_zero_trade_count": int((values.holdout_trades == 0).sum())}


def main():
    output = ROOT / "reports" / "daily_strategy"
    output.mkdir(parents=True, exist_ok=True)
    rows, missing = [], []
    for market, symbols in UNIVERSE.items():
        for symbol in symbols:
            path = ROOT / "data" / ("daily_adjusted" if market == "CN" else "daily") / f"{market}_{symbol.replace('.', '_')}.csv"
            if not path.exists():
                missing.append({"market": market, "symbol": symbol, "reason": "not_fetched"})
                continue
            frame = pd.read_csv(path)
            if len(frame) < 500 or frame.date.duplicated().any() or not frame.date.is_monotonic_increasing:
                missing.append({"market": market, "symbol": symbol, "reason": "quality_or_history"})
                continue
            split = int(len(frame) * 0.7)
            for strategy in STRATEGIES:
                full = backtest(frame, market, 80, len(frame), strategy=strategy, symbol=symbol)
                holdout = backtest(frame, market, split, len(frame), strategy=strategy, symbol=symbol)
                stress = backtest(frame, market, 80, len(frame), strategy=strategy, cost_multiplier=2, symbol=symbol)
                segment = "US_ETF" if market == "US" and symbols.index(symbol) < 10 else "US_STOCK" if market == "US" else market
                rows.append({"market": market, "segment": segment, "symbol": symbol, "strategy": strategy,
                             "rows": len(frame), "from": frame.date.iloc[0], "to": frame.date.iloc[-1],
                             "holdout_from": holdout["from"], "full_return_pct": full["return_pct"],
                             "full_benchmark_pct": full["benchmark_pct"], "full_trades": full["trade_count"],
                             "full_total_cost": full["total_cost"], "cost_bps_each_side": full["cost_bps_each_side"],
                             "full_max_drawdown_pct": full["max_drawdown_pct"],
                             "holdout_return_pct": holdout["return_pct"],
                             "holdout_benchmark_pct": holdout["benchmark_pct"],
                             "holdout_max_drawdown_pct": holdout["max_drawdown_pct"],
                             "holdout_trades": holdout["trade_count"],
                             "double_cost_return_pct": stress["return_pct"],
                             "curve": [point for i, point in enumerate(full["curve"])
                                       if i % 25 == 0 or i == len(full["curve"]) - 1],
                             "trades": full["trades"][:20]})
            print(f"{market} {symbol}: evaluated", flush=True)
    segments = ("US_ETF", "US_STOCK", "HK", "CN")
    groups = [{"segment": segment, "strategy": strategy, **stats([r for r in rows if r["segment"] == segment and r["strategy"] == strategy])}
              for segment in segments for strategy in STRATEGIES if any(r["segment"] == segment and r["strategy"] == strategy for r in rows)]
    report = {"generated_at": datetime.now(timezone.utc).isoformat(), "universe": UNIVERSE,
              "selection_note": "Fixed 2026-09-17 convenience sample of established liquid representatives; current constituents create survivorship bias. No historical membership, point-in-time liquidity or delisted names.",
              "groups": groups, "assets": rows, "missing": missing}
    (output / "universe_summary.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({"groups": groups, "missing": missing}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
