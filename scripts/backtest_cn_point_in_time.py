"""Backtest A-share stock selection against historical daily market screens.

Universe membership and liquidity use only information available at each
signal close. Signals fill at the following session's open; no broker is used.
"""
from __future__ import annotations

import gzip
import json
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import pandas as pd

from evaluate_dynamic_stock_selection import Panel, _trade, features, metrics, select
from evaluate_risk_budget import forecast_vol
from fetch_daily_strategy_data import ROOT


CACHE = ROOT / "data" / "point_in_time_cn"
OUTPUT = ROOT / "reports" / "point_in_time_cn" / "report.json"
START_CASH = 1_000_000.0
LOT = 100
FEE_BPS = 15
WARMUP = 252
SCREEN_SIZE = 300
HOLDOUT_START = "2026-01-01"
STRATEGIES = ("liquidity_only", "relative_momentum", "trend_momentum",
              "near_52week_high", "pullback_trend", "low_volatility")
OVERLAYS = ("original", "vol_06", "vol_10", "vol_06_brake", "vol_10_brake")


def load_panel():
    manifest = json.loads((CACHE / "manifest.json").read_text(encoding="utf-8"))
    files = sorted(CACHE.glob("*.csv.gz"))
    if len(files) != manifest["sessions"]:
        raise RuntimeError(f"Incomplete history cache: {len(files)} / {manifest['sessions']}")
    access = json.loads((ROOT / "data" / "universe_access.json").read_text(encoding="utf-8"))
    records = access["lists"]["CN_listed"] + access["lists"]["CN_delisted"]
    listing = {row["ts_code"]: row for row in records}
    symbols = sorted(listing)
    lookup = {symbol: i for i, symbol in enumerate(symbols)}
    dates = [path.stem.split(".")[0] for path in files]
    shape = len(dates), len(symbols)
    opens = np.full(shape, np.nan, dtype=np.float32)
    closes = np.full(shape, np.nan, dtype=np.float32)
    valuation = np.full(shape, np.nan, dtype=np.float32)
    volumes = np.full(shape, np.nan, dtype=np.float32)
    turnover = np.full(shape, np.nan, dtype=np.float32)
    for day, path in enumerate(files):
        with gzip.open(path, "rt", encoding="utf-8") as stream:
            frame = pd.read_csv(stream, dtype={"ts_code": str, "trade_date": str})
        index = frame.ts_code.map(lookup)
        valid = index.notna() & (frame.close > 0) & (frame.pre_close > 0)
        frame, ids = frame.loc[valid], index.loc[valid].to_numpy(dtype=int)
        close = frame.close.to_numpy(dtype=float)
        previous = frame.pre_close.to_numpy(dtype=float)
        earlier = valuation[day - 1, ids] if day else np.full(len(ids), np.nan)
        adjusted = np.where(np.isfinite(earlier), earlier * close / previous, close)
        closes[day, ids] = adjusted
        opens[day, ids] = adjusted * frame.open.to_numpy(dtype=float) / close
        volumes[day, ids] = frame.vol.to_numpy(dtype=float) * 100
        turnover[day, ids] = frame.amount.to_numpy(dtype=float) * 1000
        if day:
            valuation[day] = valuation[day - 1]
        valuation[day, ids] = adjusted
        if day % 100 == 0:
            print("loaded", day + 1, "/", len(files), flush=True)
    calendar = [pd.Timestamp(day) for day in dates]
    panel = Panel([day.strftime("%Y-%m-%d") for day in calendar], symbols,
                  opens, closes, valuation, volumes, turnover)
    list_dates = np.array([pd.Timestamp(str(listing[s]["list_date"]))
                           if listing[s].get("list_date") else pd.Timestamp("2100-01-01")
                           for s in symbols], dtype="datetime64[ns]")
    return panel, list_dates, manifest


def market_screen(panel: Panel, list_dates: np.ndarray, day: int) -> np.ndarray:
    """Filter on that day's exchange listing, age, positive trading and value."""
    date = np.datetime64(panel.dates[day])
    age = (date - list_dates).astype("timedelta64[D]").astype(int)
    amount = panel.turnover[day]
    valid = (age >= 180) & np.isfinite(amount) & (amount > 0)
    valid &= np.isfinite(panel.closes[day]) & (panel.volumes[day] > 0)
    valid &= np.array([s.endswith((".SH", ".SZ")) for s in panel.symbols])
    indices = np.flatnonzero(valid)
    order = sorted(indices, key=lambda i: (-float(amount[i]), panel.symbols[i]))
    return np.array(order[:SCREEN_SIZE], dtype=int)


def selected_targets(panel: Panel, list_dates: np.ndarray, day: int, strategy: str):
    indices = market_screen(panel, list_dates, day)
    subset = Panel(panel.dates, [panel.symbols[i] for i in indices],
                   panel.opens[:, indices], panel.closes[:, indices],
                   panel.valuation[:, indices], panel.volumes[:, indices],
                   panel.turnover[:, indices])
    if strategy == "liquidity_only":
        picks = [{"symbol": subset.symbols[i], "score": float(panel.turnover[day, indices[i]]),
                  "target_weight": 0.18} for i in range(min(5, len(indices)))]
        return {p["symbol"]: p["target_weight"] for p in picks}, picks, len(indices)
    if strategy == "low_volatility":
        signals = features(subset, day)
        eligible = signals["valid"] & signals["trend"]
        ranked = sorted(np.flatnonzero(eligible),
                        key=lambda i: (float(signals["volatility"][i]), subset.symbols[i]))[:10]
        picks = [{"symbol": subset.symbols[i], "score": float(signals["volatility"][i]),
                  "target_weight": 0.09} for i in ranked]
        return {p["symbol"]: p["target_weight"] for p in picks}, picks, len(indices)
    targets, picks = select(subset, day, strategy)
    return targets, picks, len(indices)


def overlay_target(panel, day, composition, variant, peak, equity):
    if variant == "original":
        return composition
    target_vol = 0.06 if "06" in variant else 0.10
    risk = forecast_vol(panel, day, composition)
    gross = sum(composition.values())
    multiplier = min(1.0, target_vol / risk) if risk > 0 else 0.0
    if "brake" in variant and peak > 0 and 1 - equity / peak >= 0.02:
        multiplier = min(multiplier, 0.10 / gross) if gross else 0.0
    return {symbol: weight * multiplier for symbol, weight in composition.items()}


def run(panel, list_dates, strategy, variant, fee_multiplier=1.0):
    cash = START_CASH
    shares = np.zeros(len(panel.symbols), dtype=int)
    entry_day = np.full(len(panel.symbols), -10000, dtype=int)
    curve, trades, decisions = [], [], []
    pending = None
    composition = {}
    peak = START_CASH
    interval = 5 if strategy == "pullback_trend" else 21
    for day in range(WARMUP, len(panel.dates)):
        if pending is not None:
            cash = _trade(day, pending, panel, cash, shares, entry_day,
                          FEE_BPS / 10000 * fee_multiplier, LOT, trades)
        equity = cash + float(np.nansum(shares * panel.valuation[day]))
        peak = max(peak, equity)
        curve.append({"date": panel.dates[day], "equity": equity})
        pending = None
        selection_day = (day - WARMUP) % interval == 0
        if selection_day:
            composition, picks, screened = selected_targets(panel, list_dates, day, strategy)
            decisions.append({"signal_date": panel.dates[day], "screened": screened,
                              "picks": picks})
        if selection_day or (variant != "original" and ((day - WARMUP) % 5 == 0 or
            ("brake" in variant and 1 - equity / peak >= 0.02))):
            pending = overlay_target(panel, day, composition, variant, peak, equity)
    return {"curve": curve, "trades": trades, "decisions": decisions}


def main():
    panel, list_dates, manifest = load_panel()
    report = {"generated_at": datetime.now(timezone.utc).isoformat(),
              "data": {"source": "Tushare market-wide daily compact cache",
                       "from": panel.dates[0], "to": panel.dates[-1],
                       "sessions": len(panel.dates), "symbols_in_list": len(panel.symbols),
                       "cache_mb": round(manifest["bytes"] / 1024**2, 2)},
              "initial_cash_cny": START_CASH, "holdout_start": HOLDOUT_START,
              "goal": {"min_cagr_pct": 8, "max_drawdown_pct": -5},
              "results": {}}
    for strategy in STRATEGIES:
        variants = {}
        for variant in OVERLAYS:
            result = run(panel, list_dates, strategy, variant)
            split = next(i for i, row in enumerate(result["curve"])
                         if row["date"] >= HOLDOUT_START)
            item = {"full": metrics(result["curve"]),
                    "development": metrics(result["curve"][:split]),
                    "holdout": metrics(result["curve"], HOLDOUT_START),
                    "trade_count": len(result["trades"]),
                    "curve": result["curve"][::5] + [result["curve"][-1]],
                    "latest_decision": result["decisions"][-1] if result["decisions"] else None}
            variants[variant] = item
            print(strategy, variant, "development", round(item["development"]["cagr_pct"], 2),
                  round(item["development"]["max_drawdown_pct"], 2),
                  "holdout", round(item["holdout"]["cagr_pct"], 2),
                  round(item["holdout"]["max_drawdown_pct"], 2), flush=True)
        report["results"][strategy] = variants
    eligible = [(name, variant) for name, group in report["results"].items()
                for variant, item in group.items()
                if item["development"]["cagr_pct"] >= 8 and
                item["development"]["max_drawdown_pct"] >= -5]
    report["selected_on_development"] = max(eligible, key=lambda pair: (
        report["results"][pair[0]][pair[1]]["development"]["sharpe"],
        report["results"][pair[0]][pair[1]]["development"]["cagr_pct"])) if eligible else None
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT.write_text(json.dumps(report, ensure_ascii=False, indent=2,
                                 default=lambda value: value.item() if isinstance(value, np.generic)
                                 else str(value)), encoding="utf-8")
    print("saved", OUTPUT, "selected", report["selected_on_development"])


if __name__ == "__main__":
    main()
