"""Pre-trade portfolio risk controls."""

from typing import Dict, Optional

import numpy as np

from .config import RiskConfig


class RiskManager:
    def __init__(self, config: RiskConfig) -> None:
        self.config = config

    def adjust_targets(
        self, targets: Dict[str, float], drawdown: float, realized_volatility: Optional[float] = None
    ) -> Dict[str, float]:
        """Validate and constrain desired weights before orders are created."""
        if drawdown <= -self.config.max_drawdown:
            return {symbol: 0.0 for symbol in targets}

        original: Dict[str, float] = {}
        constrained: Dict[str, float] = {}
        limit = self.config.max_position_weight
        for symbol, raw_weight in targets.items():
            weight = float(raw_weight)
            if not np.isfinite(weight):
                raise ValueError("Non-finite target weight for %s" % symbol)
            if not self.config.allow_short:
                weight = max(0.0, weight)
            original[symbol] = weight
            constrained[symbol] = min(limit, max(-limit, weight))

        gross = sum(abs(weight) for weight in constrained.values())
        if gross > self.config.max_gross_leverage:
            scale = self.config.max_gross_leverage / gross
            constrained = {symbol: weight * scale for symbol, weight in constrained.items()}
        grouped: Dict[str, list] = {}
        for symbol in constrained:
            group = self.config.asset_groups.get(symbol)
            if group:
                grouped.setdefault(group, []).append(symbol)
        for symbols in grouped.values():
            group_gross = sum(abs(constrained[symbol]) for symbol in symbols)
            if group_gross > self.config.max_group_weight:
                scale = self.config.max_group_weight / group_gross
                for symbol in symbols:
                    constrained[symbol] *= scale
        if constrained and all(weight >= 0 for weight in original.values()):
            constrained = self._redistribute_long_only(constrained, original)
        if realized_volatility is not None and realized_volatility > 0:
            vol_scale = self.config.target_volatility / realized_volatility
            vol_scale = min(
                self.config.max_volatility_scale,
                max(self.config.min_volatility_scale, vol_scale),
            )
            constrained = {symbol: weight * vol_scale for symbol, weight in constrained.items()}
            constrained = self._uniformly_enforce_caps(constrained)
        if drawdown < -self.config.drawdown_soft_limit:
            progress = min(
                1.0,
                (
                    abs(drawdown) - self.config.drawdown_soft_limit
                )
                / (self.config.max_drawdown - self.config.drawdown_soft_limit),
            )
            drawdown_scale = 1.0 - progress * (1.0 - self.config.minimum_drawdown_scale)
            constrained = {
                symbol: weight * drawdown_scale for symbol, weight in constrained.items()
            }
        return constrained

    def _uniformly_enforce_caps(self, weights: Dict[str, float]) -> Dict[str, float]:
        """Scale a portfolio uniformly after volatility targeting to retain all caps."""
        scales = [1.0]
        gross = sum(abs(weight) for weight in weights.values())
        if gross > 0:
            scales.append(self.config.max_gross_leverage / gross)
        largest = max((abs(weight) for weight in weights.values()), default=0.0)
        if largest > 0:
            scales.append(self.config.max_position_weight / largest)
        group_gross: Dict[str, float] = {}
        for symbol, weight in weights.items():
            group = self.config.asset_groups.get(symbol)
            if group:
                group_gross[group] = group_gross.get(group, 0.0) + abs(weight)
        for exposure in group_gross.values():
            if exposure > 0:
                scales.append(self.config.max_group_weight / exposure)
        scale = min(scales)
        return {symbol: weight * scale for symbol, weight in weights.items()}

    def _redistribute_long_only(
        self, constrained: Dict[str, float], original: Dict[str, float]
    ) -> Dict[str, float]:
        """Project long-only targets onto caps without discarding feasible budget."""
        target_gross = min(sum(original.values()), self.config.max_gross_leverage)
        weights = dict(constrained)
        for _ in range(30):
            remaining = target_gross - sum(weights.values())
            if remaining <= 1e-10:
                break
            group_usage: Dict[str, float] = {}
            for symbol, weight in weights.items():
                group = self.config.asset_groups.get(symbol)
                if group:
                    group_usage[group] = group_usage.get(group, 0.0) + weight
            eligible = {
                symbol: desired
                for symbol, desired in original.items()
                if desired > 0
                and weights.get(symbol, 0.0) < self.config.max_position_weight - 1e-12
                and (
                    not self.config.asset_groups.get(symbol)
                    or group_usage.get(self.config.asset_groups[symbol], 0.0)
                    < self.config.max_group_weight - 1e-12
                )
            }
            score_total = sum(eligible.values())
            if score_total <= 0:
                break
            proposals = {
                symbol: min(
                    remaining * score / score_total,
                    self.config.max_position_weight - weights.get(symbol, 0.0),
                )
                for symbol, score in eligible.items()
            }
            by_group: Dict[str, list] = {}
            for symbol in proposals:
                group = self.config.asset_groups.get(symbol)
                if group:
                    by_group.setdefault(group, []).append(symbol)
            for group, symbols in by_group.items():
                room = max(0.0, self.config.max_group_weight - group_usage.get(group, 0.0))
                proposed = sum(proposals[symbol] for symbol in symbols)
                if proposed > room and proposed > 0:
                    scale = room / proposed
                    for symbol in symbols:
                        proposals[symbol] *= scale
            added = sum(proposals.values())
            if added <= 1e-12:
                break
            for symbol, amount in proposals.items():
                weights[symbol] = weights.get(symbol, 0.0) + amount
        return weights
