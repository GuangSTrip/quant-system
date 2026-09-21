"""Intraday enhanced-reversion strategy kernel and auto-trading state machine.

Simulation/paper only — no real-money path exists. The decision kernel is
shared verbatim by the backtest and the live runner (``scripts/auto_trade_intraday.py``)
so research and execution cannot drift apart.

Default parameters are research settings, not an independently verified optimum.
The original ZIP did not supply the claimed parameter-grid evidence.
"""

from __future__ import annotations

import datetime as dt
import json
import math
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, List, Optional

SESSION_OPEN = 570  # 9:30 Eastern, minutes of day
SESSION_CLOSE = 960  # 16:00 Eastern

# In-sample winner config (documented caveat above); override via config/CLI.
DEFAULT_CONFIG: Dict[str, Any] = {
    "threshold_bps": 60.0,
    "time_stop_bars": 60,
    "entry_start_minute": 600,  # skip the first 30 minutes
    "max_entries_per_day": 1,
    "guard_sigma": 1.5,
    "lookback": 20,
}


# --- Eastern-time helpers (no third-party timezone dependency) --------------


def _nth_sunday(year: int, month: int, n: int) -> dt.date:
    first = dt.date(year, month, 1)
    sunday = first + dt.timedelta(days=(6 - first.weekday()) % 7)
    return sunday + dt.timedelta(weeks=n - 1)


def eastern_utc_offset_hours(day: dt.date) -> int:
    """US Eastern: UTC-5, except DST (second Sunday of March .. first Sunday of November)."""
    return -4 if _nth_sunday(day.year, 3, 2) <= day <= _nth_sunday(day.year, 11, 1) else -5


def eastern_local(moment_utc: dt.datetime) -> dt.datetime:
    return moment_utc + dt.timedelta(hours=eastern_utc_offset_hours(moment_utc.date()))


def bar_eastern(bar: Dict[str, Any]) -> dt.datetime:
    stamp = dt.datetime.fromisoformat(str(bar["t"]).replace("Z", "+00:00"))
    if stamp.tzinfo is None:
        stamp = stamp.replace(tzinfo=dt.timezone.utc)
    return eastern_local(stamp.astimezone(dt.timezone.utc).replace(tzinfo=None))


def split_sessions(bars: List[Dict[str, Any]]) -> Dict[dt.date, List[Dict[str, Any]]]:
    """Group minute bars into Eastern regular-session days, chronological within each."""
    sessions: Dict[dt.date, List[Dict[str, Any]]] = {}
    for bar in bars:
        local = bar_eastern(bar)
        minute = local.hour * 60 + local.minute
        if SESSION_OPEN <= minute < SESSION_CLOSE:
            sessions.setdefault(local.date(), []).append({**bar, "_minute": minute, "_local": local})
    for day in sessions:
        sessions[day].sort(key=lambda b: (b["_local"], b["t"]))
    return sessions


# --- decision kernel (shared by backtest and live runner) -------------------


@dataclass
class Decision:
    action: str  # "buy" | "sell" | "hold"
    reason: str
    held_bars: Optional[int] = None


@dataclass
class IntradayState:
    """Per-symbol live state; `entry_time` anchors the time stop across runs."""

    symbol: str
    day: str = ""
    qty: float = 0.0
    avg_price: float = 0.0
    entry_time: str = ""
    entries_today: int = 0
    realized_pnl: float = 0.0

    def rollover(self, day: str) -> None:
        if self.day != day:
            self.day = day
            # Keep any residual holding until actual sell fills reconcile it.
            self.entries_today = 0

    def to_dict(self) -> Dict[str, Any]:
        return {"symbol": self.symbol, "day": self.day, "qty": self.qty,
                "avg_price": self.avg_price, "entry_time": self.entry_time,
                "entries_today": self.entries_today, "realized_pnl": self.realized_pnl}

    @classmethod
    def from_dict(cls, raw: Dict[str, Any]) -> "IntradayState":
        return cls(symbol=str(raw["symbol"]), day=str(raw.get("day", "")),
                   qty=float(raw.get("qty", 0.0)), avg_price=float(raw.get("avg_price", 0.0)),
                   entry_time=str(raw.get("entry_time", "")),
                   entries_today=int(raw.get("entries_today", 0)),
                   realized_pnl=float(raw.get("realized_pnl", 0.0)))


def vwap_upto(bars: List[Dict[str, Any]], upto: int) -> Optional[float]:
    """Volume-weighted typical price over bars[:upto]; None when volume is zero."""
    volume = 0.0
    tpv = 0.0
    for bar in bars[:upto]:
        typical = (bar["h"] + bar["l"] + bar["c"]) / 3.0
        volume += bar["v"]
        tpv += typical * bar["v"]
    if volume <= 0:
        return None
    return tpv / volume


def momentum_guard_ok(bars: List[Dict[str, Any]], upto: int, lookback: int, guard_sigma: float) -> bool:
    """False when the `lookback` bars BEFORE the evaluated bar are in free fall.

    The evaluated bar is the dip being priced; what we block is a tape that was
    already collapsing before the dip arrived. Flat tape (sigma=rise=0) passes.
    """
    if upto <= lookback:
        return False
    recent = bars[upto - 1 - lookback:upto - 1]
    rets = [recent[i + 1]["c"] / recent[i]["c"] - 1.0 for i in range(len(recent) - 1)]
    sigma = math.sqrt(sum(r * r for r in rets) / len(rets))
    rise = recent[-1]["c"] / recent[0]["c"] - 1.0
    return rise >= -guard_sigma * sigma


def decide(session_bars: List[Dict[str, Any]], state: IntradayState, config: Dict[str, Any]) -> Decision:
    """Decide on the LAST completed bar of `session_bars` (all same session, chronological).

    Live semantics: evaluate after a bar closes, submit immediately (fills ~next
    bar open). Backtest semantics: same decision, fill at the next bar's open.
    """
    if not session_bars:
        return Decision("hold", "无行情")
    upto = len(session_bars)
    bar = session_bars[-1]
    minute = bar["_minute"]
    if minute >= SESSION_CLOSE - 15:
        if state.qty > 0:
            return Decision("sell", "收盘前15分钟窗口:强制离场")
        return Decision("hold", "收盘前窗口,空仓等待收盘")
    if state.qty > 0:
        vwap = vwap_upto(session_bars, upto)
        if vwap is not None and bar["c"] >= vwap:
            return Decision("sell", "回归VWAP:止盈")
        held = _held_bars(session_bars, state)
        if held is not None and held >= int(config["time_stop_bars"]):
            return Decision("sell", "时间止损:持仓 %d 棒未回归" % held)
        return Decision("hold", "持有中", held_bars=held)
    if state.entries_today >= int(config["max_entries_per_day"]):
        return Decision("hold", "当日入场次数已用尽")
    if minute < int(config["entry_start_minute"]):
        return Decision("hold", "开盘观察窗口")
    vwap = vwap_upto(session_bars, upto)
    if vwap is None:
        return Decision("hold", "无成交量")
    deviation = (vwap - bar["c"]) / vwap
    if deviation >= float(config["threshold_bps"]) / 10000.0:
        if momentum_guard_ok(session_bars, upto, int(config["lookback"]), float(config["guard_sigma"])):
            return Decision("buy", "低于VWAP %.0fbp(阈值 %.0fbp)且非自由落体" % (deviation * 1e4, float(config["threshold_bps"])))
        return Decision("hold", "偏差达标但前%d棒自由落体,放弃" % int(config["lookback"]))
    return Decision("hold", "偏差 %.0fbp 未达阈值" % (deviation * 1e4 if deviation > 0 else 0.0))


def _held_bars(session_bars: List[Dict[str, Any]], state: IntradayState) -> Optional[int]:
    """Bars held since the entry fill, anchored on the entry bar's timestamp."""
    if not state.entry_time:
        return None
    for index, bar in enumerate(session_bars):
        if bar["t"] == state.entry_time:
            return len(session_bars) - 1 - index
    return None


# --- backtest (same kernel; used by tests and strategy sanity checks) -------


def backtest_intraday(days: List[List[Dict[str, Any]]], config: Dict[str, Any],
                      budget: float, cost_bps: float, initial_cash: float = 100_000.0):
    """Replay full sessions: decide on bar i-1, fill at bar i open, force flat at day end."""
    fee = cost_bps / 10_000.0
    cash = initial_cash
    trades: List[Dict[str, Any]] = []
    daily: List[float] = []
    prev_cash = initial_cash
    for day in days:
        state = IntradayState(symbol="", day=day[0]["t"][:10])
        for i in range(1, len(day)):
            decision = decide(day[:i], state, config)
            bar = day[i]
            if decision.action == "buy":
                target = min(int(budget / bar["o"]), int(cash / (bar["o"] * (1.0 + fee))))
                if target > 0:
                    cost = target * bar["o"] * fee
                    cash -= target * bar["o"] + cost
                    state.qty = target
                    state.avg_price = bar["o"]
                    state.entry_time = day[i - 1]["t"]
                    state.entries_today += 1
                    trades.append({"t": bar["t"], "side": "buy", "qty": target,
                                   "price": bar["o"], "cost": cost, "reason": decision.reason})
            elif decision.action == "sell" and state.qty > 0:
                qty = state.qty
                proceeds = qty * bar["o"] * (1.0 - fee)
                cash += proceeds
                state.realized_pnl += proceeds - qty * state.avg_price
                trades.append({"t": bar["t"], "side": "sell", "qty": qty,
                               "price": bar["o"], "cost": qty * bar["o"] * fee, "reason": decision.reason})
                state.qty = 0.0
                state.avg_price = 0.0
                state.entry_time = ""
        if state.qty > 0:  # backstop: force flat at the day's final close
            last = day[-1]
            qty = state.qty
            cash += qty * last["c"] * (1.0 - fee)
            state.realized_pnl += qty * last["c"] * (1.0 - fee) - qty * state.avg_price
            trades.append({"t": last["t"], "side": "sell", "qty": qty,
                           "price": last["c"], "cost": qty * last["c"] * fee, "reason": "日末强制平仓"})
            state.qty = 0.0
        daily.append(cash / prev_cash - 1.0)
        prev_cash = cash
    return {"total_return": cash / initial_cash - 1.0, "day_returns": daily,
            "trades": trades, "final_cash": cash}


def load_state(path: Path) -> Dict[str, IntradayState]:
    if not path.exists():
        return {}
    raw = json.loads(path.read_text(encoding="utf-8"))
    return {symbol: IntradayState.from_dict(entry) for symbol, entry in raw.items()}


def save_state(states: Dict[str, IntradayState], path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = {symbol: state.to_dict() for symbol, state in sorted(states.items())}
    path.write_text(json.dumps(payload, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
