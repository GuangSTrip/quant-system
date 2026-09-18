"""Build current CN daily selection from the market list, without fixed tickers.

Read-only data gathering and order intentions only; never sends broker orders.
The selection must be refreshed after the latest close before any next-open plan
is treated as current.
"""
from __future__ import annotations

import argparse
import json
from datetime import datetime, time, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

import numpy as np
import pandas as pd
import tushare as ts

from evaluate_dynamic_stock_selection import Panel, select
from evaluate_risk_budget import forecast_vol
from fetch_daily_strategy_data import ROOT, token


LOCAL_TZ = ZoneInfo("Asia/Shanghai")
HISTORY_START = "20250801"
LIQUID_HISTORY_SIZE = 100
INITIAL_CASH = 1_000_000.0
CN_LOT = 100
CN_FEE = 0.0015


def latest_complete_day(api, now):
    # Tushare publishes A-share daily bars after the close. Avoid treating
    # today's partially available information as a complete daily signal.
    first = now.date() if now.hour >= 17 else now.date() - timedelta(days=1)
    for offset in range(7):
        day = (first - timedelta(days=offset)).strftime("%Y%m%d")
        bars = api.daily(trade_date=day)
        if len(bars) > 1000:
            return day, bars
    raise RuntimeError("No complete broad A-share trading day in the last week")


def save_history(api, symbol, asof, output):
    stem = symbol.replace(".", "_")
    path = output / f"{stem}.csv"
    if path.exists():
        existing = pd.read_csv(path)
        if len(existing) >= 252 and existing.date.iloc[-1] == pd.to_datetime(asof).strftime("%Y-%m-%d"):
            return existing
    bars = api.daily(ts_code=symbol, start_date=HISTORY_START, end_date=asof)
    factors = api.adj_factor(ts_code=symbol, start_date=HISTORY_START, end_date=asof)
    if len(bars) < 252 or factors.empty:
        return None
    merged = bars.merge(factors[["trade_date", "adj_factor"]], on="trade_date", validate="one_to_one")
    merged = merged.sort_values("trade_date")
    if len(merged) < 252 or merged.adj_factor.isna().any() or merged.trade_date.iloc[-1] != asof:
        return None
    # The latest factor is only a common price scale; ratios use factors no
    # later than each signal date. Raw prices are kept for execution estimates.
    scale = merged.adj_factor / float(merged.adj_factor.iloc[-1])
    frame = pd.DataFrame({"date": pd.to_datetime(merged.trade_date).dt.strftime("%Y-%m-%d"),
                          "volume": merged.vol.astype(float) * 100,
                          "raw_close": merged.close.astype(float)})
    for field in ("open", "high", "low", "close"):
        frame[field] = merged[field].astype(float) * scale
    frame.to_csv(path, index=False)
    return frame


def make_panel(frames):
    symbols = list(frames)
    calendar = pd.Index(frames[symbols[0]].date)
    dates = list(calendar)
    def column(field):
        return np.column_stack([frames[s].set_index("date").reindex(calendar)[field].to_numpy(dtype=float)
                                for s in symbols])
    opens, closes, volume, raw_close = (column(field) for field in ("open", "close", "volume", "raw_close"))
    valuation = pd.DataFrame(closes).ffill().to_numpy(dtype=float)
    return Panel(dates, symbols, opens, closes, valuation, volume, raw_close * volume)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--limit", type=int, default=LIQUID_HISTORY_SIZE)
    args = parser.parse_args()
    now = datetime.now(LOCAL_TZ)
    api = ts.pro_api(token())
    asof, bars = latest_complete_day(api, now)
    listed = api.stock_basic(exchange="", list_status="L", fields="ts_code,name,market,list_date")
    meta = listed.set_index("ts_code")
    liquid = bars.join(meta, on="ts_code", how="inner")
    cutoff = (pd.Timestamp(asof) - pd.Timedelta(days=180)).strftime("%Y%m%d")
    liquid = liquid[(liquid.ts_code.str.endswith((".SH", ".SZ")))
                    & (liquid.list_date <= cutoff)
                    & (~liquid.name.str.contains("ST|退", na=False, regex=True))
                    & (liquid.amount > 0) & (liquid.vol > 0)]
    liquid = liquid.sort_values(["amount", "ts_code"], ascending=[False, True])
    ranked = liquid.ts_code.head(args.limit).tolist()
    output = ROOT / "data" / "current_daily" / asof
    output.mkdir(parents=True, exist_ok=True)
    frames, failed = {}, []
    for index, symbol in enumerate(ranked, 1):
        try:
            frame = save_history(api, symbol, asof, output)
            if frame is None:
                failed.append(symbol)
            else:
                frames[symbol] = frame
        except Exception:
            failed.append(symbol)
        if index % 20 == 0:
            print("history", index, "valid", len(frames), flush=True)
    if len(frames) < 20:
        raise RuntimeError(f"Only {len(frames)} candidate histories passed checks")
    history_valid = len(frames)
    # A 100-share order must fit the stock's risk-sized target budget. Re-rank
    # after removing candidates that are impossible to buy with the account.
    unaffordable = []
    for _ in range(history_valid):
        panel = make_panel(frames)
        if panel.dates[-1] != pd.to_datetime(asof).strftime("%Y-%m-%d"):
            raise RuntimeError("Panel calendar does not end at latest complete session")
        day = len(panel.dates) - 1
        targets, picks = select(panel, day, "trend_momentum")
        risk = forecast_vol(panel, day, targets)
        exposure = min(1.0, 0.06 / risk) if risk > 0 else 0.0
        weights = {symbol: weight * exposure for symbol, weight in targets.items()}
        impossible = [p["symbol"] for p in picks
                      if INITIAL_CASH * weights[p["symbol"]] <
                      CN_LOT * float(frames[p["symbol"]].raw_close.iloc[-1]) * (1 + CN_FEE)]
        if not impossible:
            break
        unaffordable.extend(impossible)
        for symbol in impossible:
            del frames[symbol]
    else:
        raise RuntimeError("No affordable selection after all candidates were checked")
    # On an intraday refresh, yesterday's next-open instruction has expired.
    signal_date = pd.Timestamp(asof).date()
    calendar = api.trade_cal(exchange="SSE", start_date=asof,
                             end_date=(signal_date + timedelta(days=14)).strftime("%Y%m%d"))
    next_sessions = sorted(calendar.loc[(calendar.is_open.astype(str) == "1") &
                                        (calendar.cal_date.astype(str) > asof), "cal_date"].astype(str))
    if not next_sessions:
        raise RuntimeError("Cannot determine the next exchange session")
    next_open_date = pd.Timestamp(next_sessions[0]).date()
    expired = now.date() > next_open_date or (now.date() == next_open_date and now.time() >= time(9, 30))
    indicative_shares = {p["symbol"]: int(np.floor(
        INITIAL_CASH * weights[p["symbol"]] /
        (float(frames[p["symbol"]].raw_close.iloc[-1]) * (1 + CN_FEE)) / CN_LOT) * CN_LOT)
        for p in picks}
    indicative_stock_value = sum(indicative_shares[p["symbol"]] *
                                 float(frames[p["symbol"]].raw_close.iloc[-1]) for p in picks)
    report = {
        "generated_at": now.isoformat(), "market": "CN", "signal_date": str(signal_date),
        "next_open_date": str(next_open_date),
        "status": "expired_daily_open_signal" if expired else "research_signal_ready",
        "initial_cash": INITIAL_CASH, "currency": "CNY", "current_holdings": [],
        "universe": {"listed": len(listed), "daily_rows": len(bars),
                     "eligible_after_basic_filters": len(liquid),
                     "history_screen_size": len(ranked), "history_valid": history_valid,
                     "affordable_candidates": len(frames), "unaffordable_removed": unaffordable,
                     "history_failed": failed},
        "rule": "全市场日成交额排序取前100只作为高流动性研究范围；历史满252日、流动性过滤、120日趋势和6个月动量/60日波动率选前5；以6%预测组合波动率调整总仓位，剔除目标仓位买不起100股的股票。",
        "forecast_volatility_pct": round(risk * 100, 3),
        "selected": [{"symbol": p["symbol"], "name": str(meta.loc[p["symbol"], "name"]),
                      "score": p["score"], "target_weight_pct": round(weights[p["symbol"]] * 100, 3),
                      "reference_close": float(bars.set_index("ts_code").loc[p["symbol"], "close"]),
                      "indicative_shares_at_reference_close": indicative_shares[p["symbol"]],
                      "indicative_position_weight_pct": round(
                          indicative_shares[p["symbol"]] *
                          float(frames[p["symbol"]].raw_close.iloc[-1]) / INITIAL_CASH * 100, 3)}
                     for p in picks],
        "total_stock_weight_pct": round(sum(weights.values()) * 100, 3),
        "indicative_stock_weight_pct": round(indicative_stock_value / INITIAL_CASH * 100, 3),
        "indicative_cash_after_fees": round(INITIAL_CASH - indicative_stock_value * (1 + CN_FEE), 2),
        "sell_intentions": [],
        "order_intentions": [] if expired else [
            {"symbol": p["symbol"], "side": "BUY", "target_weight_pct": round(weights[p["symbol"]] * 100, 3),
             "reference_shares": indicative_shares[p["symbol"]],
             "execution": "next session open after rechecking market rules and price"} for p in picks],
        "broker_submitted": False,
        "limitations": ["今日收盘前没有今日完整日线；已过的开盘不能补成交。",
                        "没有当前账户持仓，无法计算卖出数量；订单仅为目标仓位意向。",
                        "本动态股票池尚未完成点时全市场历史回测，不能据此宣称达成收益或回撤目标。"],
    }
    path = ROOT / "reports" / "current_daily" / "CN.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({key: report[key] for key in ("signal_date", "status", "universe", "selected", "total_stock_weight_pct")}, ensure_ascii=False), flush=True)
    print("saved", path, flush=True)


if __name__ == "__main__":
    main()
