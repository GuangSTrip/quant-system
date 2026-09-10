"""Equal-weight moving-average crossover strategy."""

from collections import defaultdict, deque
from typing import Deque, Dict

import numpy as np
import pandas as pd

from .base import Strategy


class SmaCrossStrategy(Strategy):
    def __init__(
        self,
        fast_window: int = 20,
        slow_window: int = 100,
        allocation: float = 0.95,
        long_short: bool = False,
    ) -> None:
        if fast_window <= 0 or slow_window <= fast_window:
            raise ValueError("Require 0 < fast_window < slow_window")
        if not 0 < allocation <= 2:
            raise ValueError("allocation must be in (0, 2]")
        self.fast_window = fast_window
        self.slow_window = slow_window
        self.allocation = allocation
        self.long_short = long_short
        self.history: Dict[str, Deque[float]] = defaultdict(
            lambda: deque(maxlen=self.slow_window)
        )

    def on_bar(self, timestamp: pd.Timestamp, bars: Dict[str, pd.Series]) -> Dict[str, float]:
        del timestamp
        signals: Dict[str, float] = {}
        for symbol, bar in bars.items():
            history = self.history[symbol]
            history.append(float(bar["close"]))
            if len(history) < self.slow_window:
                signals[symbol] = 0.0
                continue
            values = np.asarray(history, dtype=float)
            fast = float(values[-self.fast_window :].mean())
            slow = float(values.mean())
            if fast > slow:
                signals[symbol] = 1.0
            elif self.long_short and fast < slow:
                signals[symbol] = -1.0
            else:
                signals[symbol] = 0.0

        active = sum(abs(value) for value in signals.values())
        if active == 0:
            return signals
        return {symbol: self.allocation * signal / active for symbol, signal in signals.items()}

    def reset(self) -> None:
        self.history.clear()
