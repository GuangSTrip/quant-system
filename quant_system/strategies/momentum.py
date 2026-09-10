"""Cross-sectional momentum strategy with absolute-momentum protection."""

from collections import defaultdict, deque
from typing import Deque, Dict

import numpy as np
import pandas as pd

from .base import Strategy
from ..portfolio import allocate


class CrossSectionalMomentumStrategy(Strategy):
    def __init__(
        self,
        lookback: int = 126,
        skip: int = 5,
        top_k: int = 3,
        volatility_window: int = 40,
        allocation: float = 0.95,
        rebalance_interval: int = 21,
        allocation_method: str = "inverse_volatility",
    ) -> None:
        if lookback <= skip or top_k <= 0 or volatility_window < 2:
            raise ValueError("invalid momentum parameters")
        self.lookback = lookback
        self.skip = skip
        self.top_k = top_k
        self.volatility_window = volatility_window
        self.allocation = allocation
        self.rebalance_interval = rebalance_interval
        self.allocation_method = allocation_method
        self.history: Dict[str, Deque[float]] = defaultdict(
            lambda: deque(maxlen=max(lookback + skip + 1, volatility_window + 1))
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

        scores: Dict[str, float] = {}
        return_series: Dict[str, pd.Series] = {}
        required = self.lookback + self.skip + 1
        for symbol in bars:
            prices = np.asarray(self.history[symbol], dtype=float)
            if len(prices) < required:
                continue
            score = prices[-self.skip - 1] / prices[-required] - 1.0
            if score <= 0:
                continue
            log_returns = np.diff(np.log(prices[-self.volatility_window - 1 :]))
            scores[symbol] = float(score)
            return_series[symbol] = pd.Series(log_returns)

        selected = sorted(scores, key=scores.get, reverse=True)[: self.top_k]
        self.last_targets = {symbol: 0.0 for symbol in bars}
        if selected:
            returns = pd.DataFrame({symbol: return_series[symbol] for symbol in selected})
            self.last_targets.update(
                allocate(returns, selected, self.allocation, self.allocation_method)
            )
        return dict(self.last_targets)

    def reset(self) -> None:
        self.history.clear()
        self.counter = 0
        self.last_targets = {}
