"""Test predeclared volatility and drawdown overlays on dynamic stock selection.

Signals use the current close, with any orders simulated at the next open.
This is research only; no live or paper broker is contacted.
"""
from __future__ import annotations

import json
from datetime import datetime, timezone

import numpy as np

from evaluate_dynamic_stock_selection import (
    CANDIDATES, HOLDOUT_START, MARKETS, ROOT, START_CASH, WARMUP,
    _trade, load_panel, metrics, run, select,
)


# Fixed before examining the following evaluations. Values are annualized.
OVERLAYS = (
    {"name": "vol_06", "target_vol": 0.06, "brake": None},
    {"name": "vol_10", "target_vol": 0.10, "brake": None},
    {"name": "vol_06_brake", "target_vol": 0.06, "brake": 0.02},
    {"name": "vol_10_brake", "target_vol": 0.10, "brake": 0.02},
)


def forecast_vol(panel, day: int, composition: dict[str, float]) -> float:
    """Use only the previous 60 observed close-to-close returns."""
    indices = [panel.symbols.index(s) for s in composition]
    if not indices:
        return 0.0
    close = panel.closes[day - 60:day + 1, indices]
    with np.errstate(divide="ignore", invalid="ignore"):
        returns = np.diff(np.log(close), axis=0)
    if not np.isfinite(returns).all():
        return float("inf")
    weights = np.array([composition[panel.symbols[i]] for i in indices], dtype=float)
    weights /= weights.sum()
    portfolio_returns = returns @ weights
    return float(max(np.std(portfolio_returns, ddof=1) * np.sqrt(252), 0.01))


def run_overlay(panel, market: str, candidate: str, target_vol: float,
                brake: float | None, cost_multiplier: float = 1.0) -> dict:
    config = MARKETS[market]
    fee = config["fee_bps"] * cost_multiplier / 10000
    cash = START_CASH
    shares = np.zeros(len(panel.symbols), dtype=int)
    entry_day = np.full(len(panel.symbols), -10000, dtype=int)
    curve, trades, decisions = [], [], []
    pending = None
    composition = {}
    peak = START_CASH
    interval = 5 if candidate == "pullback_trend" else 21
    for day in range(WARMUP, len(panel.dates)):
        if pending is not None:
            cash = _trade(day, pending, panel, cash, shares, entry_day,
                          fee, config["lot"], trades)
        equity = cash + float(np.nansum(shares * panel.valuation[day]))
        peak = max(peak, equity)
        curve.append({"date": panel.dates[day], "equity": equity})
        pending = None
        selection_day = (day - WARMUP) % interval == 0
        if selection_day:
            composition, picks = select(panel, day, candidate)
            decisions.append({"signal_date": panel.dates[day], "picks": picks})
        drawdown = 1 - equity / peak
        brake_active = brake is not None and drawdown >= brake
        if selection_day or (day - WARMUP) % 5 == 0 or brake_active:
            risk = forecast_vol(panel, day, composition)
            base_gross = sum(composition.values())
            gross = min(base_gross, base_gross * target_vol / risk) if risk > 0 else 0.0
            if brake_active:
                gross = min(gross, 0.10)
            multiplier = gross / base_gross if base_gross else 0.0
            pending = {symbol: weight * multiplier for symbol, weight in composition.items()}
    return {"curve": curve, "trades": trades, "decisions": decisions}


def before_holdout(curve):
    return curve[:next(i for i, row in enumerate(curve) if row["date"] >= HOLDOUT_START)]


def main():
    report = {"generated_at": datetime.now(timezone.utc).isoformat(),
              "holdout_start": HOLDOUT_START, "target": {"annual_return_pct": 10,
              "max_drawdown_pct": -3}, "overlays": list(OVERLAYS), "markets": {}}
    for market in MARKETS:
        panel = load_panel(market)
        candidates = {}
        for candidate in CANDIDATES[market]:
            variants = {}
            base = run(panel, market, candidate)
            variants["original"] = {"development": metrics(before_holdout(base["curve"])),
                                    "holdout": metrics(base["curve"], HOLDOUT_START),
                                    "full": metrics(base["curve"])}
            for overlay in OVERLAYS:
                result = run_overlay(panel, market, candidate, overlay["target_vol"], overlay["brake"])
                stress = run_overlay(panel, market, candidate, overlay["target_vol"], overlay["brake"], 2)
                variants[overlay["name"]] = {
                    "development": metrics(before_holdout(result["curve"])),
                    "holdout": metrics(result["curve"], HOLDOUT_START),
                    "full": metrics(result["curve"]),
                    "double_cost_holdout": metrics(stress["curve"], HOLDOUT_START),
                    "trade_count": len(result["trades"]),
                    "curve": result["curve"][::5] + [result["curve"][-1]],
                    "latest_selection": result["decisions"][-1] if result["decisions"] else None,
                }
            candidates[candidate] = variants
        # Select by development-period risk-adjusted performance, with a
        # predeclared 3% drawdown eligibility gate. Never inspect holdout here.
        eligible = [(c, o) for c in candidates for o in candidates[c]
                    if o != "original" and candidates[c][o]["development"]["max_drawdown_pct"] > -3]
        selected = max(eligible, key=lambda pair: (
            candidates[pair[0]][pair[1]]["development"]["cagr_pct"],
            candidates[pair[0]][pair[1]]["development"]["max_drawdown_pct"])) if eligible else None
        report["markets"][market] = {"symbols": panel.symbols,
                                     "selected_on_development": selected,
                                     "candidates": candidates}
        print(market, "selected", selected, flush=True)
        for candidate in candidates:
            for name, item in candidates[candidate].items():
                h = item["holdout"]
                print(" ", candidate, name, "CAGR", round(h["cagr_pct"], 2),
                      "DD", round(h["max_drawdown_pct"], 2), flush=True)
    output = ROOT / "reports" / "risk_budget"
    output.mkdir(parents=True, exist_ok=True)
    (output / "report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print("saved", output / "report.json")


if __name__ == "__main__":
    main()
