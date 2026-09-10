"""Reusable portfolio construction primitives."""

from typing import Dict, Iterable

import numpy as np
import pandas as pd


def shrink_covariance(returns: pd.DataFrame, shrinkage: float = 0.20) -> np.ndarray:
    """Estimate a numerically stable covariance matrix via diagonal shrinkage."""
    if not 0 <= shrinkage <= 1:
        raise ValueError("shrinkage must be in [0, 1]")
    if returns.shape[0] < 2 or returns.shape[1] < 1:
        raise ValueError("insufficient observations for covariance")
    sample = returns.cov().to_numpy(dtype=float)
    diagonal = np.diag(np.diag(sample))
    return (1.0 - shrinkage) * sample + shrinkage * diagonal


def exponentially_weighted_covariance(
    returns: pd.DataFrame, span: int = 60, shrinkage: float = 0.20
) -> np.ndarray:
    """Exponentially weighted covariance with diagonal shrinkage."""
    if span < 2 or not 0 <= shrinkage <= 1:
        raise ValueError("invalid covariance span or shrinkage")
    values = returns.dropna().to_numpy(dtype=float)
    if values.shape[0] < 2 or values.shape[1] < 1:
        raise ValueError("insufficient observations for covariance")
    decay = 2.0 / (span + 1.0)
    weights = (1.0 - decay) ** np.arange(len(values) - 1, -1, -1)
    weights /= weights.sum()
    mean = np.sum(values * weights[:, None], axis=0)
    centered = values - mean
    covariance = (centered * weights[:, None]).T @ centered
    effective_correction = 1.0 - float(np.sum(weights**2))
    if effective_correction > 0:
        covariance /= effective_correction
    diagonal = np.diag(np.diag(covariance))
    return (1.0 - shrinkage) * covariance + shrinkage * diagonal


def equal_risk_contribution_weights(
    covariance: np.ndarray, tolerance: float = 1e-8, max_iterations: int = 1000
) -> np.ndarray:
    """Approximate an equal-risk-contribution long-only portfolio."""
    covariance = np.asarray(covariance, dtype=float)
    if covariance.ndim != 2 or covariance.shape[0] != covariance.shape[1]:
        raise ValueError("covariance must be square")
    diagonal = np.diag(covariance)
    if len(diagonal) == 0 or np.any(diagonal <= 0):
        raise ValueError("covariance diagonal must be positive")
    weights = 1.0 / np.sqrt(diagonal)
    weights /= weights.sum()
    target_share = 1.0 / len(weights)
    for _ in range(max_iterations):
        marginal = covariance @ weights
        contributions = weights * marginal
        total = float(contributions.sum())
        if total <= 0 or np.any(contributions <= 0):
            break
        shares = contributions / total
        if float(np.max(np.abs(shares - target_share))) <= tolerance:
            return weights
        adjustment = np.clip(target_share / shares, 0.2, 5.0)
        weights *= np.sqrt(adjustment)
        weights = np.maximum(weights, 1e-12)
        weights /= weights.sum()
    return weights


def allocate(
    returns: pd.DataFrame,
    symbols: Iterable[str],
    gross_allocation: float = 1.0,
    method: str = "inverse_volatility",
) -> Dict[str, float]:
    """Long-only risk allocation for a selected group of assets."""
    selected = list(symbols)
    if not selected:
        return {}
    subset = returns.loc[:, selected].dropna()
    if len(subset) < 2:
        return {symbol: gross_allocation / len(selected) for symbol in selected}
    if method == "equal_weight":
        raw = np.ones(len(selected))
    elif method == "inverse_volatility":
        volatility = subset.std(ddof=1).to_numpy(dtype=float)
        raw = 1.0 / np.maximum(volatility, 1e-8)
    elif method == "minimum_variance":
        covariance = shrink_covariance(subset)
        raw = np.linalg.pinv(covariance) @ np.ones(len(selected))
        raw = np.maximum(raw, 0.0)
        if raw.sum() <= 1e-12:
            raw = 1.0 / np.sqrt(np.maximum(np.diag(covariance), 1e-12))
    elif method == "equal_risk_contribution":
        covariance = exponentially_weighted_covariance(
            subset, span=min(60, len(subset)), shrinkage=0.25
        )
        raw = equal_risk_contribution_weights(covariance)
    else:
        raise ValueError("Unknown allocation method: %s" % method)
    raw = raw / raw.sum() * gross_allocation
    return {symbol: float(weight) for symbol, weight in zip(selected, raw)}


def risk_contributions(weights: np.ndarray, covariance: np.ndarray) -> np.ndarray:
    """Return each asset's share of total portfolio variance."""
    portfolio_variance = float(weights @ covariance @ weights)
    if portfolio_variance <= 0:
        return np.zeros_like(weights, dtype=float)
    return weights * (covariance @ weights) / portfolio_variance
