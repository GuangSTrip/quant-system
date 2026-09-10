"""Signal-level multi-strategy ensemble."""

from collections import deque
from typing import Deque, Dict, Iterable, Tuple

import numpy as np

import pandas as pd

from .base import Strategy


class EnsembleStrategy(Strategy):
    def __init__(
        self,
        sleeves: Iterable[Tuple[Strategy, float]],
        adaptive: bool = False,
        adaptive_lookback: int = 126,
        minimum_history: int = 60,
        weight_shrinkage: float = 0.50,
        minimum_sleeve_weight: float = 0.10,
        maximum_sleeve_weight: float = 0.75,
    ) -> None:
        self.sleeves = list(sleeves)
        if not self.sleeves or any(weight <= 0 for _, weight in self.sleeves):
            raise ValueError("ensemble requires positively weighted sleeves")
        total = sum(weight for _, weight in self.sleeves)
        self.sleeves = [(strategy, weight / total) for strategy, weight in self.sleeves]
        if adaptive_lookback < 2 or minimum_history < 2:
            raise ValueError("adaptive ensemble history must be >= 2")
        if not 0 <= weight_shrinkage <= 1:
            raise ValueError("weight_shrinkage must be in [0, 1]")
        if not 0 <= minimum_sleeve_weight <= maximum_sleeve_weight <= 1:
            raise ValueError("invalid sleeve weight bounds")
        self.adaptive = adaptive
        self.minimum_history = minimum_history
        self.weight_shrinkage = weight_shrinkage
        self.minimum_sleeve_weight = minimum_sleeve_weight
        self.maximum_sleeve_weight = maximum_sleeve_weight
        self.sleeve_returns: Tuple[Deque[float], ...] = tuple(
            deque(maxlen=adaptive_lookback) for _ in self.sleeves
        )
        self.previous_targets: Tuple[Dict[str, float], ...] = tuple({} for _ in self.sleeves)
        self.last_closes: Dict[str, float] = {}

    def on_bar(self, timestamp: pd.Timestamp, bars: Dict[str, pd.Series]) -> Dict[str, float]:
        closes = {symbol: float(bar["close"]) for symbol, bar in bars.items()}
        if self.last_closes:
            asset_returns = {
                symbol: closes[symbol] / self.last_closes[symbol] - 1.0
                for symbol in closes
                if symbol in self.last_closes
            }
            for index, targets in enumerate(self.previous_targets):
                self.sleeve_returns[index].append(
                    float(sum(targets.get(symbol, 0.0) * value for symbol, value in asset_returns.items()))
                )
        base_weights = np.asarray([weight for _, weight in self.sleeves], dtype=float)
        sleeve_weights = base_weights
        if self.adaptive and all(len(history) >= self.minimum_history for history in self.sleeve_returns):
            volatilities = np.asarray(
                [max(float(np.std(history, ddof=1)), 1e-6) for history in self.sleeve_returns]
            )
            inverse_volatility = (1.0 / volatilities) / (1.0 / volatilities).sum()
            sleeve_weights = (
                self.weight_shrinkage * base_weights
                + (1.0 - self.weight_shrinkage) * inverse_volatility
            )
            sleeve_weights = np.clip(
                sleeve_weights, self.minimum_sleeve_weight, self.maximum_sleeve_weight
            )
            sleeve_weights /= sleeve_weights.sum()
        combined = {symbol: 0.0 for symbol in bars}
        current_targets = []
        for (strategy, _), sleeve_weight in zip(self.sleeves, sleeve_weights):
            targets = strategy.on_bar(timestamp, bars)
            current_targets.append(targets)
            for symbol, target in targets.items():
                combined[symbol] = combined.get(symbol, 0.0) + sleeve_weight * target
        self.previous_targets = tuple(current_targets)
        self.last_closes = closes
        return combined

    def reset(self) -> None:
        for strategy, _ in self.sleeves:
            strategy.reset()
        for history in self.sleeve_returns:
            history.clear()
        self.previous_targets = tuple({} for _ in self.sleeves)
        self.last_closes = {}


class OnlineExpertEnsembleStrategy(Strategy):
    """Cost-aware, leakage-free online aggregation of strategy experts.

    Expert scores use only the return earned by yesterday's targets. Scores decay
    over time, returns are volatility-normalized and weights shrink toward priors.
    """

    def __init__(
        self,
        experts: Iterable[Tuple[Strategy, float]],
        learning_rate: float = 0.05,
        score_decay: float = 0.99,
        volatility_decay: float = 0.97,
        prior_shrinkage: float = 0.60,
        minimum_weight: float = 0.05,
        maximum_weight: float = 0.60,
        estimated_cost_bps: float = 5.0,
    ) -> None:
        self.experts = list(experts)
        if not self.experts or any(weight <= 0 for _, weight in self.experts):
            raise ValueError("online ensemble requires positively weighted experts")
        if learning_rate <= 0 or not 0 < score_decay <= 1 or not 0 < volatility_decay < 1:
            raise ValueError("invalid online learning parameters")
        if not 0 <= prior_shrinkage <= 1:
            raise ValueError("prior_shrinkage must be in [0, 1]")
        if not 0 <= minimum_weight <= maximum_weight <= 1:
            raise ValueError("invalid online expert weight bounds")
        priors = np.asarray([weight for _, weight in self.experts], dtype=float)
        self.priors = priors / priors.sum()
        self.learning_rate = learning_rate
        self.score_decay = score_decay
        self.volatility_decay = volatility_decay
        self.prior_shrinkage = prior_shrinkage
        self.minimum_weight = minimum_weight
        self.maximum_weight = maximum_weight
        self.estimated_cost = estimated_cost_bps / 10_000.0
        self.scores = np.zeros(len(self.experts), dtype=float)
        self.variances = np.full(len(self.experts), (0.10 / np.sqrt(252.0)) ** 2)
        self.previous_targets: Tuple[Dict[str, float], ...] = tuple({} for _ in self.experts)
        self.last_turnovers = np.zeros(len(self.experts), dtype=float)
        self.last_closes: Dict[str, float] = {}
        self.current_weights = self.priors.copy()
        self.weight_history = []

    def on_bar(self, timestamp: pd.Timestamp, bars: Dict[str, pd.Series]) -> Dict[str, float]:
        closes = {symbol: float(bar["close"]) for symbol, bar in bars.items()}
        if self.last_closes:
            asset_returns = {
                symbol: closes[symbol] / self.last_closes[symbol] - 1.0
                for symbol in closes
                if symbol in self.last_closes
            }
            for index, targets in enumerate(self.previous_targets):
                gross_return = float(
                    sum(targets.get(symbol, 0.0) * value for symbol, value in asset_returns.items())
                )
                net_return = gross_return - self.estimated_cost * self.last_turnovers[index]
                self.variances[index] = (
                    self.volatility_decay * self.variances[index]
                    + (1.0 - self.volatility_decay) * net_return**2
                )
                standardized = np.clip(
                    net_return / max(np.sqrt(self.variances[index]), 1e-6), -3.0, 3.0
                )
                self.scores[index] = (
                    self.score_decay * self.scores[index]
                    + self.learning_rate * standardized
                )
            stable_scores = self.scores - self.scores.max()
            learned = np.exp(stable_scores)
            learned /= learned.sum()
            weights = self.prior_shrinkage * self.priors + (1.0 - self.prior_shrinkage) * learned
            weights = np.clip(weights, self.minimum_weight, self.maximum_weight)
            self.current_weights = weights / weights.sum()

        combined = {symbol: 0.0 for symbol in bars}
        current_targets = []
        for (expert, _), expert_weight in zip(self.experts, self.current_weights):
            targets = expert.on_bar(timestamp, bars)
            previous = self.previous_targets[len(current_targets)]
            symbols = set(targets) | set(previous)
            self.last_turnovers[len(current_targets)] = sum(
                abs(targets.get(symbol, 0.0) - previous.get(symbol, 0.0))
                for symbol in symbols
            )
            current_targets.append(targets)
            for symbol, target in targets.items():
                combined[symbol] = combined.get(symbol, 0.0) + float(expert_weight) * target
        self.previous_targets = tuple(current_targets)
        self.last_closes = closes
        self.weight_history.append(
            {"timestamp": pd.Timestamp(timestamp), **{
                "expert_%d" % index: float(weight)
                for index, weight in enumerate(self.current_weights)
            }}
        )
        return combined

    def reset(self) -> None:
        for expert, _ in self.experts:
            expert.reset()
        self.scores.fill(0.0)
        self.variances.fill((0.10 / np.sqrt(252.0)) ** 2)
        self.previous_targets = tuple({} for _ in self.experts)
        self.last_turnovers.fill(0.0)
        self.last_closes = {}
        self.current_weights = self.priors.copy()
        self.weight_history = []
