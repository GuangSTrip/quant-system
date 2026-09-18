"""Standalone daily strategy study; never submits broker orders.

Rule (fixed before viewing data): at close t, enter when close exceeds the
previous 20-session high and the 80-session SMA. Exit below the previous
10-session low or the SMA. Fill at session t+1 open. Position size is capped
at 100% and scaled toward 12% annualized volatility using trailing 20 returns.
"""

from __future__ import annotations

import hashlib
import json
import math
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import pandas as pd


ROOT = Path(__file__).resolve().parents[1]
SPECS = {"US": ("SPY", 1, 10), "HK": ("0700.HK", 100, 20),
         "CN": ("600000.SH", 100, 15)}
STRATEGIES = {
    "donchian_vol": {"name": "区间突破与波动率控制", "family": "趋势突破",
                     "rule": "收盘突破此前20日最高且高于80日均线买入；跌破此前10日最低或80日均线退出。"},
    "time_series_momentum": {"name": "中期时间序列动量", "family": "趋势动量",
                             "rule": "60日收盘涨幅为正且高于80日均线买入；60日涨幅转负或跌破均线退出。"},
    "short_reversal": {"name": "短期回撤修复", "family": "均值回归",
                       "rule": "3日跌幅至少3%且仍高于80日均线买入；回到5日均线、跌破80日均线或持有5日退出。"},
}
START_CASH = 100_000.0


def backtest(frame: pd.DataFrame, market: str, first: int, last: int,
             cost_multiplier: float = 1, strategy: str = "donchian_vol", symbol: str | None = None) -> dict:
    """Index range [first,last); pre-range observations are signal warmup only."""
    default_symbol, lot, base_bps = SPECS[market]
    symbol = symbol or default_symbol
    if strategy not in STRATEGIES:
        raise ValueError(f"unknown daily strategy: {strategy}")
    fee = base_bps * cost_multiplier / 10_000
    opens = frame.open.to_numpy(dtype=float)
    highs = frame.high.to_numpy(dtype=float)
    lows = frame.low.to_numpy(dtype=float)
    closes = frame.close.to_numpy(dtype=float)
    dates = frame.date.tolist()
    cash, shares = START_CASH, 0
    bench_cash = START_CASH
    bench_shares = math.floor(bench_cash / (opens[first] * (1 + fee) * lot)) * lot
    bench_cash -= bench_shares * opens[first] * (1 + fee)
    peak, max_dd, fees, trades, entry_index = START_CASH, 0.0, 0.0, [], None
    curve = []
    for i in range(first, last):
        # All indicators stop at the prior close. The prior-20 high excludes
        # the signal day's own high and all observations from the fill day.
        j = i - 1
        if j >= 80:
            high20 = float(np.max(highs[j - 20:j]))
            low10 = float(np.min(lows[j - 10:j]))
            sma80 = float(np.mean(closes[j - 79:j + 1]))
            daily_returns = np.diff(np.log(closes[j - 20:j + 1]))
            annual_vol = max(float(np.std(daily_returns, ddof=1) * np.sqrt(252)), 0.01)
            if strategy == "donchian_vol":
                enter = closes[j] > high20 and closes[j] > sma80
                exit_signal = closes[j] < low10 or closes[j] < sma80
            elif strategy == "time_series_momentum":
                enter = closes[j] > closes[j - 60] and closes[j] > sma80
                exit_signal = closes[j] <= closes[j - 60] or closes[j] < sma80
            else:
                enter = closes[j] / closes[j - 3] - 1 <= -0.03 and closes[j] > sma80
                exit_signal = (closes[j] >= float(np.mean(closes[j - 4:j + 1]))
                               or closes[j] < sma80 or (entry_index is not None and i - entry_index >= 5))
            if shares and exit_signal:
                charge = shares * opens[i] * fee
                cash += shares * opens[i] - charge
                fees += charge
                trades.append({"date": dates[i], "side": "sell", "shares": shares, "price": opens[i], "cost": charge})
                shares = 0
                entry_index = None
            elif not shares and enter:
                target_fraction = min(1.0, 0.12 / annual_vol)
                amount = math.floor(min(cash * target_fraction / (opens[i] * (1 + fee)),
                                        cash / (opens[i] * (1 + fee))) / lot) * lot
                if amount:
                    charge = amount * opens[i] * fee
                    cash -= amount * opens[i] + charge
                    fees += charge
                    shares = amount
                    entry_index = i
                    trades.append({"date": dates[i], "side": "buy", "shares": shares,
                                   "price": opens[i], "cost": charge, "target_fraction": target_fraction})
        equity = cash + shares * closes[i]
        benchmark = bench_cash + bench_shares * closes[i]
        peak = max(peak, equity)
        max_dd = min(max_dd, equity / peak - 1)
        curve.append({"date": dates[i], "equity": equity, "benchmark": benchmark,
                      "drawdown": equity / peak - 1})
    return {"market": market, "symbol": symbol, "strategy": strategy, "from": dates[first], "to": dates[last - 1],
            "sessions": last - first, "cost_bps_each_side": base_bps * cost_multiplier,
            "return_pct": 100 * (curve[-1]["equity"] / START_CASH - 1),
            "benchmark_pct": 100 * (curve[-1]["benchmark"] / START_CASH - 1),
            "max_drawdown_pct": 100 * max_dd, "total_cost": fees,
            "trade_count": len(trades), "open_shares": shares, "trades": trades, "curve": curve}


def main() -> int:
    summary = []
    directory = ROOT / "reports" / "daily_strategy"
    directory.mkdir(parents=True, exist_ok=True)
    for market, (symbol, _, _) in SPECS.items():
        path = ROOT / "data" / ("daily_adjusted" if market == "CN" else "daily") / f"{market}_{symbol.replace('.', '_')}.csv"
        if not path.is_file():
            summary.append({"market": market, "symbol": symbol, "status": "missing_real_daily_data"})
            continue
        frame = pd.read_csv(path)
        if len(frame) < 252 or frame.date.duplicated().any() or not frame.date.is_monotonic_increasing:
            summary.append({"market": market, "symbol": symbol, "status": "invalid_or_short_data"})
            continue
        split = int(len(frame) * 0.7)
        if split < 160 or len(frame) - split < 60:
            summary.append({"market": market, "symbol": symbol, "status": "insufficient_holdout"})
            continue
        # No strategy selection or parameter tuning uses the holdout period.
        for strategy, definition in STRATEGIES.items():
            full = backtest(frame, market, 80, len(frame), strategy=strategy)
            development = backtest(frame, market, 80, split, strategy=strategy)
            holdout = backtest(frame, market, split, len(frame), strategy=strategy)
            stress = backtest(frame, market, 80, len(frame), cost_multiplier=2, strategy=strategy)
            details = {"market": market, "symbol": symbol, "source_csv_sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
                       "status": "historical_daily_test_only", "rules_version": strategy + "_v1",
                       "strategy": strategy, "definition": definition, "full": full,
                       "development": development, "holdout": holdout, "double_costs": stress}
            (directory / f"{market}_{symbol.replace('.', '_')}_{strategy}.json").write_text(
                json.dumps(details, ensure_ascii=False, indent=2), encoding="utf-8")
            summary.append({"market": market, "symbol": symbol, "strategy": strategy, "status": details["status"],
                            "full_return_pct": full["return_pct"], "full_max_drawdown_pct": full["max_drawdown_pct"],
                            "holdout_return_pct": holdout["return_pct"], "holdout_max_drawdown_pct": holdout["max_drawdown_pct"],
                            "holdout_benchmark_pct": holdout["benchmark_pct"],
                            "double_cost_return_pct": stress["return_pct"], "trades": full["trade_count"]})
    (directory / "summary.json").write_text(json.dumps({"generated_at": datetime.now(timezone.utc).isoformat(),
                                                          "results": summary}, ensure_ascii=False, indent=2), encoding="utf-8")
    for item in summary:
        print(item)
    return 0 if all(x["status"] == "historical_daily_test_only" for x in summary) else 1


if __name__ == "__main__":
    raise SystemExit(main())
