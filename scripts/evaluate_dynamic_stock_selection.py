"""Daily stock-selection portfolio research; no broker integration.

Research candidates are fixed before the time-split evaluation. Each signal
uses only bars through that session's close and fills at the next open.
"""
from __future__ import annotations

import json
import math
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import pandas as pd

from expand_daily_universe import ROOT, UNIVERSE


START_CASH = 10_000_000.0
HOLDOUT_START = "2024-01-02"
WARMUP = 252
MARKETS = {"US": {"symbols": UNIVERSE["US"][10:], "lot": 1, "fee_bps": 10},
           "HK": {"symbols": UNIVERSE["HK"], "lot": 100, "fee_bps": 20},
           "CN": {"symbols": UNIVERSE["CN"], "lot": 100, "fee_bps": 15}}
CANDIDATES = {
    "US": ("relative_momentum", "trend_momentum", "near_52week_high"),
    "HK": ("relative_momentum", "trend_momentum", "near_52week_high"),
    "CN": ("relative_momentum", "trend_momentum", "pullback_trend"),
}
RULES = {
    "relative_momentum": "每21个交易日，从流动性合格股票中按过去约6个月涨幅（避开最近5日）选前5只；持有到下一次排名，等权分配90%资金。",
    "trend_momentum": "每21个交易日，先要求价格高于120日均线且6个月动量为正，再按动量/波动率选前5只；按波动率倒数分配至多90%资金。",
    "near_52week_high": "每21个交易日，在上涨趋势中按当前价格接近过去252日最高价的程度选前5只；等权分配90%资金。",
    "pullback_trend": "每5个交易日，在120日上涨趋势且6个月动量为正的股票中，选最近5日回撤最大的前5只；等权分配90%资金。",
}


@dataclass
class Panel:
    dates: list[str]
    symbols: list[str]
    opens: np.ndarray
    closes: np.ndarray
    valuation: np.ndarray
    volumes: np.ndarray
    turnover: np.ndarray


def load_panel(market: str) -> Panel:
    frames = {}
    root = ROOT / "data" / ("daily_adjusted" if market == "CN" else "daily")
    for symbol in MARKETS[market]["symbols"]:
        path = root / f"{market}_{symbol.replace('.', '_')}.csv"
        if path.exists():
            frame = pd.read_csv(path).set_index("date").sort_index()
            if len(frame) >= 1000 and not frame.index.duplicated().any():
                frames[symbol] = frame
    if len(frames) < 10:
        raise ValueError(f"{market}: fewer than 10 quality checked daily histories")
    # A fixed reference stock supplies the exchange calendar; choosing the
    # longest series after inspecting future data would leak information.
    calendar = frames[MARKETS[market]["symbols"][0]].index
    dates = list(calendar)
    symbols = list(frames)
    def column(name):
        return np.column_stack([frames[s].reindex(calendar)[name].to_numpy(dtype=float) for s in symbols])
    opens, closes, volumes = column("open"), column("close"), column("volume")
    valuation = pd.DataFrame(closes).ffill().to_numpy(dtype=float)
    raw_close = column("raw_close") if market == "CN" else closes
    turnover = raw_close * volumes
    return Panel(dates, symbols, opens, closes, valuation, volumes, turnover)


def features(panel: Panel, day: int) -> dict[str, np.ndarray]:
    """Compute features only from observed dates through the signal close."""
    c, v, t = panel.closes, panel.volumes, panel.turnover
    with np.errstate(divide="ignore", invalid="ignore"):
        momentum = c[day - 5] / c[day - 126] - 1
        recent = c[day] / c[day - 5] - 1
        sma120 = np.nanmean(c[day - 119:day + 1], axis=0)
        high252 = np.nanmax(c[day - 251:day + 1], axis=0)
        near_high = c[day] / high252
        returns = np.diff(np.log(c[day - 60:day + 1]), axis=0)
        volatility = np.nanstd(returns, axis=0, ddof=1) * np.sqrt(252)
        liquidity = np.nanmedian(t[day - 19:day + 1], axis=0)
        observed = np.sum(np.isfinite(c[:day + 1]), axis=0)
    valid = (np.isfinite(c[day]) & np.isfinite(v[day]) & (v[day] > 0)
             & (observed >= 120) & np.isfinite(momentum) & np.isfinite(volatility)
             & (volatility > 0) & np.isfinite(liquidity) & (liquidity > 0))
    if valid.any():
        cutoff = float(np.quantile(liquidity[valid], 0.20))
        valid &= liquidity >= cutoff
    return {"valid": valid, "momentum": momentum, "recent": recent,
            "trend": c[day] > sma120, "near_high": near_high,
            "volatility": volatility, "liquidity": liquidity}


def select(panel: Panel, day: int, candidate: str) -> tuple[dict[str, float], list[dict]]:
    f = features(panel, day)
    eligible = f["valid"].copy()
    if candidate == "relative_momentum":
        score = f["momentum"]
    elif candidate == "trend_momentum":
        eligible &= f["trend"] & (f["momentum"] > 0)
        score = f["momentum"] / np.maximum(f["volatility"], 0.05)
    elif candidate == "near_52week_high":
        eligible &= f["trend"]
        score = f["near_high"]
    elif candidate == "pullback_trend":
        eligible &= f["trend"] & (f["momentum"] > 0)
        score = -f["recent"]
    else:
        raise ValueError(f"unknown candidate: {candidate}")
    indices = sorted(np.flatnonzero(eligible), key=lambda i: (-float(score[i]), panel.symbols[i]))[:5]
    if not indices:
        return {}, []
    if candidate == "trend_momentum":
        raw = 1 / np.maximum(f["volatility"][indices], 0.05)
        weights = np.minimum(raw / raw.sum() * 0.90, 0.25)
    else:
        weights = np.full(len(indices), 0.90 / len(indices))
    picks = [{"symbol": panel.symbols[i], "score": float(score[i]),
              "liquidity": float(f["liquidity"][i]), "target_weight": float(w)}
             for i, w in zip(indices, weights)]
    return {x["symbol"]: x["target_weight"] for x in picks}, picks


def _trade(day: int, target: dict[str, float], panel: Panel, cash: float,
           shares: np.ndarray, entry_day: np.ndarray, fee: float, lot: int,
           history: list[dict]) -> float:
    prices = np.where(np.isfinite(panel.opens[day]), panel.opens[day], panel.valuation[day - 1])
    equity = cash + float(np.nansum(shares * prices))
    desired = np.zeros(len(panel.symbols), dtype=int)
    for index, symbol in enumerate(panel.symbols):
        opened = panel.opens[day, index]
        if not np.isfinite(opened) or opened <= 0 or panel.volumes[day, index] <= 0:
            desired[index] = int(shares[index])
            continue
        desired[index] = int(math.floor(equity * target.get(symbol, 0) / opened / lot) * lot)
    for side in ("sell", "buy"):
        for index, symbol in enumerate(panel.symbols):
            delta = desired[index] - shares[index]
            if (side == "sell" and delta >= 0) or (side == "buy" and delta <= 0):
                continue
            if side == "sell" and day - entry_day[index] < 1:
                continue
            opened = panel.opens[day, index]
            if not np.isfinite(opened) or panel.volumes[day, index] <= 0:
                continue
            max_qty = int(math.floor(panel.volumes[day, index] * 0.01 / lot) * lot)
            qty = min(abs(int(delta)), max_qty)
            if side == "buy":
                affordable = int(math.floor(cash / (opened * (1 + fee)) / lot) * lot)
                qty = min(qty, affordable)
            if qty <= 0:
                continue
            cost = qty * opened * fee
            cash += qty * opened - cost if side == "sell" else -qty * opened - cost
            shares[index] += -qty if side == "sell" else qty
            if side == "buy":
                entry_day[index] = day
            history.append({"date": panel.dates[day], "symbol": symbol, "side": side,
                            "shares": qty, "price": float(opened), "cost": float(cost)})
    return cash


def run(panel: Panel, market: str, candidate: str, cost_multiplier: float = 1.0) -> dict:
    config = MARKETS[market]
    fee = config["fee_bps"] / 10000 * cost_multiplier
    lot = config["lot"]
    cash = START_CASH
    shares = np.zeros(len(panel.symbols), dtype=int)
    entry_day = np.full(len(panel.symbols), -10000, dtype=int)
    trades, decisions, curve = [], [], []
    pending = None
    interval = 5 if candidate == "pullback_trend" else 21
    for day in range(WARMUP, len(panel.dates)):
        if pending is not None:
            cash = _trade(day, pending, panel, cash, shares, entry_day, fee, lot, trades)
        equity = cash + float(np.nansum(shares * panel.valuation[day]))
        curve.append({"date": panel.dates[day], "equity": equity})
        pending = None
        if (day - WARMUP) % interval == 0:
            target, picks = select(panel, day, candidate)
            pending = target
            decisions.append({"signal_date": panel.dates[day], "fill_date": panel.dates[day + 1] if day + 1 < len(panel.dates) else None,
                              "eligible_count": int(features(panel, day)["valid"].sum()), "picks": picks})
    return {"market": market, "strategy": candidate, "curve": curve, "trades": trades,
            "decisions": decisions, "cost_bps_each_side": config["fee_bps"] * cost_multiplier}


def run_baseline(panel: Panel, market: str) -> dict:
    """Passive buy/hold of the same available fixed list, at the same costs."""
    fee = MARKETS[market]["fee_bps"] / 10000
    lot = MARKETS[market]["lot"]
    target = {s: 0.90 / len(panel.symbols) for s in panel.symbols}
    cash, shares = START_CASH, np.zeros(len(panel.symbols), dtype=int)
    entry_day = np.full(len(panel.symbols), -10000, dtype=int)
    trades, curve = [], []
    for day in range(WARMUP, len(panel.dates)):
        if day == WARMUP + 1:
            cash = _trade(day, target, panel, cash, shares, entry_day, fee, lot, trades)
        equity = cash + float(np.nansum(shares * panel.valuation[day]))
        curve.append({"date": panel.dates[day], "equity": equity})
    return {"market": market, "strategy": "fixed_pool_buy_hold", "curve": curve, "trades": trades}


def metrics(curve: list[dict], start: str | None = None) -> dict:
    subset = [x for x in curve if start is None or x["date"] >= start]
    if len(subset) < 30:
        raise ValueError("too few equity observations")
    anchor = next((curve[i - 1]["equity"] for i,x in enumerate(curve)
                   if start is not None and x["date"] >= start and i > 0), None)
    equity = np.array(([anchor] if anchor is not None else []) + [x["equity"] for x in subset], dtype=float)
    returns = np.diff(equity) / equity[:-1]
    peak = np.maximum.accumulate(equity)
    first_date = next((curve[i - 1]["date"] for i,x in enumerate(curve)
                       if start is not None and x["date"] >= start and i > 0), subset[0]["date"])
    years = (pd.Timestamp(subset[-1]["date"]) - pd.Timestamp(first_date)).days / 365.25
    volatility = float(np.std(returns, ddof=1))
    return {"from": subset[0]["date"], "to": subset[-1]["date"], "sessions": len(subset),
            "total_return_pct": float((equity[-1] / equity[0] - 1) * 100),
            "cagr_pct": float(((equity[-1] / equity[0]) ** (1 / years) - 1) * 100),
            "max_drawdown_pct": float(np.min(equity / peak - 1) * 100),
            "annual_volatility_pct": volatility * np.sqrt(252) * 100,
            "sharpe": float(np.mean(returns) / volatility * np.sqrt(252)) if volatility > 0 else 0.0}


def main():
    report = {"generated_at": datetime.now(timezone.utc).isoformat(), "holdout_start": HOLDOUT_START,
              "initial_cash_per_market_currency": START_CASH, "rules": RULES, "markets": {}}
    for market in MARKETS:
        panel = load_panel(market)
        base = run_baseline(panel, market)
        items = {}
        for candidate in CANDIDATES[market]:
            result = run(panel, market, candidate)
            stress = run(panel, market, candidate, 2)
            items[candidate] = {"full": metrics(result["curve"]),
                                "development": metrics(result["curve"][:next(i for i,x in enumerate(result["curve"]) if x["date"] >= HOLDOUT_START)]),
                                "holdout": metrics(result["curve"], HOLDOUT_START),
                                "double_cost_holdout": metrics(stress["curve"], HOLDOUT_START),
                                "trade_count": len(result["trades"]),
                                "cost_total": sum(x["cost"] for x in result["trades"]),
                                "decisions": result["decisions"],
                                "curve": result["curve"][::5] + [result["curve"][-1]]}
            print(market, candidate, items[candidate]["holdout"]["total_return_pct"], flush=True)
        selected = max(items, key=lambda name: (items[name]["development"]["sharpe"],
                                                items[name]["development"]["max_drawdown_pct"]))
        report["markets"][market] = {"symbols": panel.symbols, "selected_on_development": selected,
                                     "candidates": items,
                                     "benchmark": {"full": metrics(base["curve"]),
                                                   "development": metrics(base["curve"][:next(i for i,x in enumerate(base["curve"]) if x["date"] >= HOLDOUT_START)]),
                                                   "holdout": metrics(base["curve"], HOLDOUT_START),
                                                   "curve": base["curve"][::5] + [base["curve"][-1]]}}
    output = ROOT / "reports" / "dynamic_selection"
    output.mkdir(parents=True, exist_ok=True)
    (output / "report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print("saved", output / "report.json")


if __name__ == "__main__":
    main()
