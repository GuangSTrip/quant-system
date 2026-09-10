"""Portfolio performance and risk statistics."""

from typing import Any, Dict
from statistics import NormalDist

import numpy as np
import pandas as pd


TRADING_DAYS = 252.0


def probabilistic_sharpe_ratio(
    returns: pd.Series, benchmark_annual_sharpe: float = 0.0
) -> float:
    """Probability that the true Sharpe exceeds a benchmark, adjusted for non-normality."""
    values = returns.replace([np.inf, -np.inf], np.nan).dropna().astype(float)
    if len(values) < 3 or values.std(ddof=1) <= 0:
        return 0.0
    daily_sharpe = float(values.mean() / values.std(ddof=1))
    benchmark = benchmark_annual_sharpe / np.sqrt(TRADING_DAYS)
    skewness = float(values.skew())
    kurtosis = float(values.kurt()) + 3.0
    denominator = np.sqrt(
        max(
            1e-12,
            1.0
            - skewness * daily_sharpe
            + ((kurtosis - 1.0) / 4.0) * daily_sharpe**2,
        )
    )
    z_score = (daily_sharpe - benchmark) * np.sqrt(len(values) - 1.0) / denominator
    return float(NormalDist().cdf(z_score))


def expected_maximum_sharpe(trial_annual_sharpes: pd.Series) -> float:
    """Expected best Sharpe under multiple trials, used as a deflation hurdle."""
    values = pd.Series(trial_annual_sharpes, dtype=float).dropna()
    if len(values) <= 1 or values.std(ddof=1) <= 0:
        return max(0.0, float(values.iloc[0]) if len(values) else 0.0)
    trials = len(values)
    gamma = 0.5772156649015329
    normal = NormalDist()
    first = normal.inv_cdf(1.0 - 1.0 / trials)
    second = normal.inv_cdf(1.0 - 1.0 / (trials * np.e))
    return float(values.mean() + values.std(ddof=1) * ((1.0 - gamma) * first + gamma * second))


def calculate_metrics(
    equity_curve: pd.DataFrame, trades: pd.DataFrame, annual_risk_free_rate: float = 0.0
) -> Dict[str, Any]:
    if equity_curve.empty:
        raise ValueError("Cannot calculate metrics for an empty equity curve")

    equity = equity_curve["equity"].astype(float)
    returns = equity.pct_change().replace([np.inf, -np.inf], np.nan).dropna()
    daily_risk_free = annual_risk_free_rate / TRADING_DAYS
    excess_returns = returns - daily_risk_free
    total_return = float(equity.iloc[-1] / equity.iloc[0] - 1.0)
    elapsed_days = max(1, (equity.index[-1] - equity.index[0]).days)
    years = elapsed_days / 365.25
    cagr = float((equity.iloc[-1] / equity.iloc[0]) ** (1.0 / years) - 1.0)

    annual_volatility = float(returns.std(ddof=1) * np.sqrt(TRADING_DAYS)) if len(returns) > 1 else 0.0
    if len(returns) > 1 and returns.std(ddof=1) > 0:
        sharpe = float(excess_returns.mean() / returns.std(ddof=1) * np.sqrt(TRADING_DAYS))
    else:
        sharpe = 0.0
    drawdowns = equity / equity.cummax() - 1.0
    max_drawdown = float(drawdowns.min())
    calmar = float(cagr / abs(max_drawdown)) if max_drawdown < 0 else 0.0
    win_rate = float((returns > 0).mean()) if len(returns) else 0.0
    downside = excess_returns[excess_returns < 0]
    downside_volatility = (
        float(np.sqrt((downside**2).mean()) * np.sqrt(TRADING_DAYS)) if len(downside) else 0.0
    )
    sortino = (
        float(excess_returns.mean() * TRADING_DAYS / downside_volatility)
        if downside_volatility > 0
        else 0.0
    )
    value_at_risk_95 = float(returns.quantile(0.05)) if len(returns) else 0.0
    tail = returns[returns <= value_at_risk_95]
    expected_shortfall_95 = float(tail.mean()) if len(tail) else 0.0
    ulcer_index = float(np.sqrt(np.mean(np.square(drawdowns))))

    traded_notional = float(trades["notional"].abs().sum()) if not trades.empty else 0.0
    average_equity = float(equity.mean())
    turnover = traded_notional / average_equity if average_equity else 0.0
    total_commission = float(trades["commission"].sum()) if not trades.empty else 0.0
    impact_cost = float(trades["impact_cost"].sum()) if not trades.empty and "impact_cost" in trades else 0.0

    benchmark_return = 0.0
    benchmark_cagr = 0.0
    benchmark_volatility = 0.0
    benchmark_sharpe = 0.0
    benchmark_max_drawdown = 0.0
    excess_return = 0.0
    information_ratio = 0.0
    beta = 0.0
    alpha = 0.0
    if "benchmark_equity" in equity_curve:
        benchmark = equity_curve["benchmark_equity"].astype(float)
        benchmark_return = float(benchmark.iloc[-1] / benchmark.iloc[0] - 1.0)
        benchmark_returns = benchmark.pct_change().reindex(returns.index).fillna(0.0)
        benchmark_cagr = float(
            (benchmark.iloc[-1] / benchmark.iloc[0]) ** (1.0 / years) - 1.0
        )
        if len(benchmark_returns) > 1:
            benchmark_volatility = float(
                benchmark_returns.std(ddof=1) * np.sqrt(TRADING_DAYS)
            )
            if benchmark_returns.std(ddof=1) > 0:
                benchmark_sharpe = float(
                (benchmark_returns - daily_risk_free).mean()
                / benchmark_returns.std(ddof=1)
                    * np.sqrt(TRADING_DAYS)
                )
        benchmark_max_drawdown = float((benchmark / benchmark.cummax() - 1.0).min())
        active_returns = returns - benchmark_returns
        excess_return = total_return - benchmark_return
        if len(active_returns) > 1 and active_returns.std(ddof=1) > 0:
            information_ratio = float(
                active_returns.mean() / active_returns.std(ddof=1) * np.sqrt(TRADING_DAYS)
            )
        variance = float(benchmark_returns.var(ddof=1)) if len(benchmark_returns) > 1 else 0.0
        if variance > 0:
            beta = float(returns.cov(benchmark_returns) / variance)
            alpha = float(
                (
                    returns.mean()
                    - daily_risk_free
                    - beta * (benchmark_returns.mean() - daily_risk_free)
                )
                * TRADING_DAYS
            )

    return {
        "start_equity": float(equity.iloc[0]),
        "annual_risk_free_rate": float(annual_risk_free_rate),
        "end_equity": float(equity.iloc[-1]),
        "total_return": total_return,
        "cagr": cagr,
        "annual_volatility": annual_volatility,
        "sharpe_ratio": sharpe,
        "max_drawdown": max_drawdown,
        "calmar_ratio": calmar,
        "sortino_ratio": sortino,
        "daily_win_rate": win_rate,
        "value_at_risk_95": value_at_risk_95,
        "expected_shortfall_95": expected_shortfall_95,
        "ulcer_index": ulcer_index,
        "best_day": float(returns.max()) if len(returns) else 0.0,
        "worst_day": float(returns.min()) if len(returns) else 0.0,
        "turnover": float(turnover),
        "trade_count": int(len(trades)),
        "total_commission": total_commission,
        "estimated_impact_cost": impact_cost,
        "benchmark_return": benchmark_return,
        "benchmark_cagr": benchmark_cagr,
        "benchmark_annual_volatility": benchmark_volatility,
        "benchmark_sharpe_ratio": benchmark_sharpe,
        "benchmark_max_drawdown": benchmark_max_drawdown,
        "excess_return": excess_return,
        "information_ratio": information_ratio,
        "beta": beta,
        "annualized_alpha": alpha,
        "average_gross_exposure": float(
            (equity_curve["gross_exposure"] / equity).mean()
        ) if "gross_exposure" in equity_curve else 0.0,
    }
