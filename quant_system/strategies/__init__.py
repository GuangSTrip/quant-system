"""Built-in strategy registry."""

from typing import Any, Dict

from .base import Strategy
from .allocation import DualMomentumStrategy, EqualWeightStrategy, RollingRiskParityStrategy
from .ensemble import EnsembleStrategy, OnlineExpertEnsembleStrategy
from .momentum import CrossSectionalMomentumStrategy
from .multi_horizon import MultiHorizonTrendStrategy
from .sma_cross import SmaCrossStrategy
from .trend import TrendFollowingStrategy


def build_strategy(name: str, params: Dict[str, Any]) -> Strategy:
    strategies = {
        "sma_cross": SmaCrossStrategy,
        "trend": TrendFollowingStrategy,
        "cross_sectional_momentum": CrossSectionalMomentumStrategy,
        "multi_horizon_trend": MultiHorizonTrendStrategy,
        "equal_weight": EqualWeightStrategy,
        "rolling_risk_parity": RollingRiskParityStrategy,
        "dual_momentum": DualMomentumStrategy,
    }
    try:
        strategy_type = strategies[name]
    except KeyError as exc:
        raise ValueError("Unknown strategy %r. Available: %s" % (name, sorted(strategies))) from exc
    return strategy_type(**params)


def build_ensemble(sleeves: list, params: Dict[str, Any] = None) -> Strategy:
    if not sleeves:
        raise ValueError("strategy.sleeves cannot be empty for an ensemble")
    built = []
    for sleeve in sleeves:
        built.append(
            (
                build_strategy(sleeve["name"], sleeve.get("params", {})),
                float(sleeve.get("weight", 1.0)),
            )
        )
    return EnsembleStrategy(built, **(params or {}))


__all__ = [
    "Strategy",
    "SmaCrossStrategy",
    "TrendFollowingStrategy",
    "CrossSectionalMomentumStrategy",
    "MultiHorizonTrendStrategy",
    "EqualWeightStrategy",
    "RollingRiskParityStrategy",
    "DualMomentumStrategy",
    "EnsembleStrategy",
    "OnlineExpertEnsembleStrategy",
    "build_strategy",
    "build_ensemble",
]
