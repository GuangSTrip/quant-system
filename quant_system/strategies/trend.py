"""Diversified time-series trend strategy with inverse-volatility sizing."""

from collections import defaultdict, deque
from typing import Deque, Dict

import numpy as np
import pandas as pd

from .base import Strategy
from ..portfolio import allocate


class TrendFollowingStrategy(Strategy):
    """Blend medium/long momentum and size active assets by inverse volatility."""

    def __init__(
        self,
        medium_window: int = 63,
        long_window: int = 252,
        volatility_window: int = 40,
        allocation: float = 0.95,
        rebalance_interval: int = 5,
        long_short: bool = False,
        allocation_method: str = "inverse_volatility",
    ) -> None:
        if min(medium_window, volatility_window, rebalance_interval) <= 1:
            raise ValueError("trend windows and rebalance_interval must be > 1")
        if long_window <= medium_window:
            raise ValueError("long_window must exceed medium_window")
        self.medium_window = medium_window
        self.long_window = long_window
        self.volatility_window = volatility_window
        self.allocation = allocation
        self.rebalance_interval = rebalance_interval
        self.long_short = long_short
        self.allocation_method = allocation_method
        self.history: Dict[str, Deque[float]] = defaultdict(
            lambda: deque(maxlen=self.long_window + 1)
        )
        self.counter = 0
        self.last_targets: Dict[str, float] = {}

    def on_bar(self, timestamp: pd.Timestamp, bars: Dict[str, pd.Series]) -> Dict[str, float]:
        del timestamp
        self.counter += 1
        for symbol, bar in bars.items():
            self.history[symbol].append(float(bar["close"]))
        if self.counter % self.rebalance_interval and self.last_targets:
            return dict(self.last_targets)

        signals: Dict[str, float] = {}
        return_series: Dict[str, pd.Series] = {}
        for symbol in sorted(bars):
            prices = np.asarray(self.history[symbol], dtype=float)
            if len(prices) < self.long_window + 1:
                signals[symbol] = 0.0
                continue
            medium_return = prices[-1] / prices[-self.medium_window - 1] - 1.0
            long_return = prices[-1] / prices[0] - 1.0
            signal = np.sign(0.5 * medium_return + 0.5 * long_return)
            if not self.long_short and signal < 0:
                signal = 0.0
            recent_returns = np.diff(np.log(prices[-self.volatility_window - 1 :]))
            annual_vol = max(float(recent_returns.std(ddof=1) * np.sqrt(252.0)), 0.03)
            signals[symbol] = float(signal)
            return_series[symbol] = pd.Series(
                np.diff(np.log(prices[-self.volatility_window - 1 :]))
            )

        self.last_targets = {symbol: 0.0 for symbol in signals}
        long_symbols = [symbol for symbol, signal in signals.items() if signal > 0]
        if long_symbols:
            returns = pd.DataFrame({symbol: return_series[symbol] for symbol in long_symbols})
            self.last_targets.update(
                allocate(returns, long_symbols, self.allocation, self.allocation_method)
            )
        short_symbols = [symbol for symbol, signal in signals.items() if signal < 0]
        if short_symbols:
            returns = pd.DataFrame({symbol: return_series[symbol] for symbol in short_symbols})
            short_weights = allocate(
                returns, short_symbols, self.allocation, self.allocation_method
            )
            self.last_targets.update({symbol: -weight for symbol, weight in short_weights.items()})
            gross = sum(abs(weight) for weight in self.last_targets.values())
            if gross:
                self.last_targets = {
                    symbol: self.allocation * weight / gross
                    for symbol, weight in self.last_targets.items()
                }
        return dict(self.last_targets)

    def reset(self) -> None:
        self.history.clear()
        self.counter = 0
        self.last_targets = {}
