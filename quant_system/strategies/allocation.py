"""Allocation-only baselines used by the benchmark suite."""

from collections import defaultdict, deque
from typing import Deque, Dict, Iterable

import numpy as np
import pandas as pd

from ..portfolio import allocate
from .base import Strategy


class EqualWeightStrategy(Strategy):
    def __init__(self, allocation: float = 0.95) -> None:
        self.allocation = allocation

    def on_bar(self, timestamp: pd.Timestamp, bars: Dict[str, pd.Series]) -> Dict[str, float]:
        del timestamp
        weight = self.allocation / len(bars) if bars else 0.0
        return {symbol: weight for symbol in bars}


class RollingRiskParityStrategy(Strategy):
    def __init__(
        self,
        lookback: int = 63,
        allocation: float = 0.95,
        rebalance_interval: int = 21,
        method: str = "inverse_volatility",
    ) -> None:
        if lookback < 2 or rebalance_interval < 1:
            raise ValueError("invalid risk parity lookback or interval")
        self.lookback = lookback
        self.allocation = allocation
        self.rebalance_interval = rebalance_interval
        self.method = method
        self.history: Dict[str, Deque[float]] = defaultdict(
            lambda: deque(maxlen=lookback + 1)
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
        ready = [symbol for symbol in bars if len(self.history[symbol]) == self.lookback + 1]
        self.last_targets = {symbol: 0.0 for symbol in bars}
        if ready:
            returns = pd.DataFrame(
                {
                    symbol: np.diff(np.log(np.asarray(self.history[symbol], dtype=float)))
                    for symbol in ready
                }
            )
            self.last_targets.update(allocate(returns, ready, self.allocation, self.method))
        return dict(self.last_targets)

    def reset(self) -> None:
        self.history.clear()
        self.counter = 0
        self.last_targets = {}


class DualMomentumStrategy(Strategy):
    """Absolute + relative momentum rotation with an explicit defensive universe."""

    def __init__(
        self,
        offensive_symbols: Iterable[str],
        defensive_symbols: Iterable[str],
        lookback: int = 252,
        skip: int = 5,
        top_k: int = 3,
        allocation: float = 0.95,
        rebalance_interval: int = 21,
    ) -> None:
        self.offensive = tuple(offensive_symbols)
        self.defensive = tuple(defensive_symbols)
        if not self.offensive or not self.defensive or lookback <= skip or top_k < 1:
            raise ValueError("invalid dual momentum universe or parameters")
        self.lookback = lookback
        self.skip = skip
        self.top_k = top_k
        self.allocation = allocation
        self.rebalance_interval = rebalance_interval
        self.history: Dict[str, Deque[float]] = defaultdict(
            lambda: deque(maxlen=lookback + skip + 1)
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
        required = self.lookback + self.skip + 1
        scores = {}
        for symbol in set(self.offensive) | set(self.defensive):
            prices = np.asarray(self.history[symbol], dtype=float)
            if len(prices) == required:
                scores[symbol] = float(prices[-self.skip - 1] / prices[0] - 1.0)
        positive_offensive = sorted(
            [symbol for symbol in self.offensive if scores.get(symbol, -np.inf) > 0],
            key=scores.get,
            reverse=True,
        )[: self.top_k]
        selected = positive_offensive
        if not selected:
            positive_defensive = sorted(
                [symbol for symbol in self.defensive if scores.get(symbol, -np.inf) > 0],
                key=scores.get,
                reverse=True,
            )
            selected = positive_defensive[:1]
        self.last_targets = {symbol: 0.0 for symbol in bars}
        if selected:
            weight = self.allocation / len(selected)
            self.last_targets.update({symbol: weight for symbol in selected})
        return dict(self.last_targets)

    def reset(self) -> None:
        self.history.clear()
        self.counter = 0
        self.last_targets = {}
