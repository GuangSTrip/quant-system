"""Robust continuous multi-horizon time-series momentum."""

from collections import defaultdict, deque
from typing import Deque, Dict, Iterable

import numpy as np
import pandas as pd

from .base import Strategy


class MultiHorizonTrendStrategy(Strategy):
    """Blend several fixed trend horizons and size by signal strength / volatility.

    The signal at every horizon is normalized by realized volatility and compressed
    with tanh, preventing one extreme observation from dominating the portfolio.
    """

    def __init__(
        self,
        horizons: Iterable[int] = (21, 63, 126, 252),
        volatility_window: int = 40,
        allocation: float = 0.95,
        rebalance_interval: int = 5,
        long_short: bool = False,
        signal_scale: float = 0.75,
        target_smoothing: float = 0.35,
    ) -> None:
        self.horizons = tuple(sorted({int(value) for value in horizons}))
        if not self.horizons or min(self.horizons) < 2:
            raise ValueError("horizons must contain integers >= 2")
        if volatility_window < 2 or rebalance_interval < 1:
            raise ValueError("invalid volatility or rebalance interval")
        if not 0 < allocation <= 2 or signal_scale <= 0:
            raise ValueError("invalid allocation or signal scale")
        if not 0 < target_smoothing <= 1:
            raise ValueError("target_smoothing must be in (0, 1]")
        self.volatility_window = volatility_window
        self.allocation = allocation
        self.rebalance_interval = rebalance_interval
        self.long_short = long_short
        self.signal_scale = signal_scale
        self.target_smoothing = target_smoothing
        self.max_history = max(max(self.horizons), volatility_window) + 1
        self.history: Dict[str, Deque[float]] = defaultdict(
            lambda: deque(maxlen=self.max_history)
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
        for symbol in sorted(bars):
            prices = np.asarray(self.history[symbol], dtype=float)
            if len(prices) < self.max_history:
                scores[symbol] = 0.0
                continue
            recent = np.diff(np.log(prices[-self.volatility_window - 1 :]))
            daily_vol = max(float(recent.std(ddof=1)), 0.03 / np.sqrt(252.0))
            normalized = []
            for horizon in self.horizons:
                momentum = float(np.log(prices[-1] / prices[-horizon - 1]))
                normalized.append(momentum / (daily_vol * np.sqrt(horizon)))
            signal = float(np.tanh(self.signal_scale * np.mean(normalized)))
            if not self.long_short:
                signal = max(0.0, signal)
            annual_vol = daily_vol * np.sqrt(252.0)
            scores[symbol] = signal / annual_vol

        gross = sum(abs(score) for score in scores.values())
        raw = (
            {symbol: self.allocation * score / gross for symbol, score in scores.items()}
            if gross
            else {symbol: 0.0 for symbol in scores}
        )
        symbols = set(raw) | set(self.last_targets)
        smooth = {
            symbol: self.target_smoothing * raw.get(symbol, 0.0)
            + (1.0 - self.target_smoothing) * self.last_targets.get(symbol, 0.0)
            for symbol in symbols
        }
        smooth_gross = sum(abs(weight) for weight in smooth.values())
        if smooth_gross > self.allocation:
            smooth = {
                symbol: weight * self.allocation / smooth_gross
                for symbol, weight in smooth.items()
            }
        self.last_targets = smooth
        return dict(self.last_targets)

    def reset(self) -> None:
        self.history.clear()
        self.counter = 0
        self.last_targets = {}
