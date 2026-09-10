"""Daily Alpaca paper-trading orchestration.

This module is deliberately small: research code creates a target weight, while
the broker adapter owns account state and orders.  The function below has a dry
run by default, making it suitable for a scheduled course demonstration.
"""

from dataclasses import dataclass
from typing import Dict, List

import pandas as pd

from .broker import AccountSnapshot, AlpacaPaperBroker, Order
from .config import SystemConfig
from .risk import RiskManager
from .strategies import build_ensemble, build_strategy


@dataclass(frozen=True)
class PaperTradingPlan:
    signal_timestamp: pd.Timestamp
    targets: Dict[str, float]
    prices: Dict[str, float]
    account: AccountSnapshot
    orders: List[Order]


def _strategy(config: SystemConfig):
    return (
        build_ensemble(config.strategy.sleeves, config.strategy.params)
        if config.strategy.name == "ensemble"
        else build_strategy(config.strategy.name, config.strategy.params)
    )


def build_paper_plan(config: SystemConfig, broker: AlpacaPaperBroker) -> PaperTradingPlan:
    """Build a plan from completed Alpaca daily bars, without sending an order."""
    symbols = list(config.data.get("symbols", []))
    if not symbols:
        raise ValueError("paper trading requires data.symbols in the configuration")
    # Longest bundled strategy lookback is 252 days; request extra calendar days
    # for market holidays, warmup and indicator windows.
    history = broker.daily_bars(symbols, pd.Timestamp.now(tz="UTC") - pd.Timedelta(days=430))
    history["timestamp"] = pd.to_datetime(history["timestamp"], utc=True).dt.tz_convert(None)
    completed = history.groupby("timestamp")["symbol"].nunique()
    required = set(symbols)
    usable_dates = completed[completed.eq(len(required))].index
    history = history[history["timestamp"].isin(usable_dates)]
    if history["timestamp"].nunique() < 253:
        raise ValueError("Alpaca history is too short for the configured daily strategy")

    strategy = _strategy(config)
    strategy.reset()
    target: Dict[str, float] = {}
    signal_timestamp = pd.Timestamp(history["timestamp"].max())
    for timestamp, rows in history.groupby("timestamp", sort=True):
        bars = {str(row["symbol"]): row for _, row in rows.iterrows()}
        target = strategy.on_bar(pd.Timestamp(timestamp), bars)
    # The strategy has already applied its own signal-volatility sizing. This
    # final pass applies hard portfolio and group caps before any order is built.
    targets = RiskManager(config.risk).adjust_targets(target, current_drawdown=0.0)
    account = broker.account()
    prices = broker.latest_mid_prices(symbols)
    orders = broker.plan_target_orders(
        targets, prices, account, plan_id=signal_timestamp.strftime("%Y%m%d")
    )
    return PaperTradingPlan(signal_timestamp, targets, prices, account, orders)

