"""Reproducible parameter research with untouched holdout and cost stress tests."""

import copy
import itertools
import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, Iterable, List, Tuple

import numpy as np
import pandas as pd

from .backtest import BacktestResult, Backtester
from .config import SystemConfig
from .performance import (
    calculate_metrics,
    expected_maximum_sharpe,
    probabilistic_sharpe_ratio,
)
from .strategies import build_strategy


def expand_grid(grid: Dict[str, Iterable[Any]]) -> List[Dict[str, Any]]:
    if not grid:
        return [{}]
    keys = sorted(grid)
    values = [list(grid[key]) for key in keys]
    if any(not value for value in values):
        raise ValueError("Every parameter grid dimension needs at least one value")
    return [dict(zip(keys, combination)) for combination in itertools.product(*values)]


def robust_score(metrics: Dict[str, Any], minimum_trades: int = 5) -> float:
    """Favor risk-adjusted return while penalizing drawdown, churn and tiny samples."""
    if metrics["trade_count"] < minimum_trades:
        return -1_000_000.0
    return float(
        metrics["sharpe_ratio"]
        + 0.35 * metrics["sortino_ratio"]
        + 0.20 * metrics["calmar_ratio"]
        - 0.50 * abs(metrics["max_drawdown"])
        - 0.01 * metrics["turnover"]
    )


def _slice_result(result: BacktestResult, start: pd.Timestamp) -> BacktestResult:
    curve = result.equity_curve.loc[result.equity_curve.index >= start].copy()
    if curve.empty:
        raise ValueError("Holdout slice is empty")
    trades = result.trades.copy()
    if not trades.empty:
        trades["timestamp"] = pd.to_datetime(trades["timestamp"])
        trades = trades.loc[trades["timestamp"] >= start].reset_index(drop=True)
    positions = result.positions.copy()
    if not positions.empty:
        positions["timestamp"] = pd.to_datetime(positions["timestamp"])
        positions = positions.loc[positions["timestamp"] >= start].reset_index(drop=True)
    risk_free = float(result.metrics.get("annual_risk_free_rate", 0.0))
    return BacktestResult(
        curve, trades, positions, calculate_metrics(curve, trades, risk_free)
    )


@dataclass
class ResearchResult:
    best_params: Dict[str, Any]
    leaderboard: pd.DataFrame
    train_metrics: Dict[str, Any]
    holdout_metrics: Dict[str, Any]
    stress_results: pd.DataFrame
    split_timestamp: pd.Timestamp
    walk_forward_results: pd.DataFrame
    bootstrap: Dict[str, float]
    validation_gate: Dict[str, bool]
    statistical_significance: Dict[str, float]

    def save(self, output_dir: str) -> None:
        destination = Path(output_dir)
        destination.mkdir(parents=True, exist_ok=True)
        self.leaderboard.to_csv(destination / "parameter_leaderboard.csv", index=False)
        self.stress_results.to_csv(destination / "cost_stress.csv", index=False)
        self.walk_forward_results.to_csv(destination / "walk_forward.csv", index=False)
        payload = {
            "best_params": self.best_params,
            "split_timestamp": self.split_timestamp.isoformat(),
            "train_metrics": self.train_metrics,
            "holdout_metrics": self.holdout_metrics,
            "bootstrap": self.bootstrap,
            "validation_gate": self.validation_gate,
            "statistical_significance": self.statistical_significance,
        }
        with (destination / "research_summary.json").open("w", encoding="utf-8") as handle:
            json.dump(payload, handle, indent=2, ensure_ascii=False, allow_nan=False)
        with (destination / "research_report.md").open("w", encoding="utf-8") as handle:
            handle.write(self._markdown())

    def _markdown(self) -> str:
        h = self.holdout_metrics
        profitable_stresses = int((self.stress_results["total_return"] > 0).sum())
        profitable_folds = int((self.walk_forward_results["total_return"] > 0).sum())
        return "\n".join(
            [
                "# 策略研究报告",
                "",
                "- 训练/验证切分点：`%s`" % self.split_timestamp.date(),
                "- 训练集选择参数：`%s`" % self.best_params,
                "- 样本外总收益：`%.2f%%`" % (100 * h["total_return"]),
                "- 样本外 Sharpe：`%.3f`" % h["sharpe_ratio"],
                "- 样本外基准 Sharpe：`%.3f`" % h["benchmark_sharpe_ratio"],
                "- 样本外最大回撤：`%.2f%%`" % (100 * h["max_drawdown"]),
                "- 样本外基准最大回撤：`%.2f%%`"
                % (100 * h["benchmark_max_drawdown"]),
                "- 成本压力下保持正收益的场景：`%d/%d`"
                % (profitable_stresses, len(self.stress_results)),
                "- Walk-forward 正收益折数：`%d/%d`"
                % (profitable_folds, len(self.walk_forward_results)),
                "- 区块 Bootstrap 年化收益为正概率：`%.1f%%`"
                % (100 * self.bootstrap["probability_positive_annual_return"]),
                "- 验证门禁总结果：`%s`"
                % ("PASS" if all(self.validation_gate.values()) else "FAIL"),
                "- 概率 Sharpe 比率：`%.1f%%`"
                % (100 * self.statistical_significance["probabilistic_sharpe_ratio"]),
                "- 多重试验校正后 Sharpe 概率：`%.1f%%`"
                % (100 * self.statistical_significance["deflated_sharpe_ratio"]),
                "",
                "参数只由训练集选择；样本外结果不参与选择。该流程降低过拟合风险，但不能保证未来收益。",
                "",
            ]
        )


class ResearchRunner:
    def __init__(self, config: SystemConfig) -> None:
        if config.strategy.name == "ensemble":
            raise ValueError("Parameter research currently targets a single strategy, not ensemble")
        self.config = config

    def run(self, market_data: pd.DataFrame) -> ResearchResult:
        dates = pd.Index(sorted(pd.to_datetime(market_data["timestamp"]).unique()))
        split_index = int(len(dates) * self.config.research.train_fraction)
        if split_index < 30 or len(dates) - split_index < 20:
            raise ValueError("Research requires at least 30 train and 20 holdout bars")
        split_timestamp = pd.Timestamp(dates[split_index])
        train_data = market_data.loc[pd.to_datetime(market_data["timestamp"]) < split_timestamp]

        best_params, leaderboard, train_result = self._fit_parameters(train_data)
        base_params = dict(self.config.strategy.params)
        selected_params = dict(base_params)
        selected_params.update(best_params)
        full_result = Backtester(
            self.config, build_strategy(self.config.strategy.name, selected_params)
        ).run(market_data)
        holdout = _slice_result(full_result, split_timestamp)

        stress_rows = []
        for multiplier in self.config.research.cost_stress_multipliers:
            stressed = copy.deepcopy(self.config)
            stressed.costs.commission_rate *= multiplier
            stressed.costs.slippage_bps *= multiplier
            stressed.costs.spread_bps *= multiplier
            stressed.costs.market_impact *= multiplier
            result = Backtester(
                stressed, build_strategy(stressed.strategy.name, selected_params)
            ).run(market_data)
            test = _slice_result(result, split_timestamp)
            stress_rows.append(
                {
                    "cost_multiplier": multiplier,
                    "total_return": test.metrics["total_return"],
                    "sharpe_ratio": test.metrics["sharpe_ratio"],
                    "max_drawdown": test.metrics["max_drawdown"],
                    "total_commission": test.metrics["total_commission"],
                }
            )
        stress_results = pd.DataFrame(stress_rows)
        walk_forward = self._walk_forward(market_data, dates, split_index)
        bootstrap = self._block_bootstrap(holdout.equity_curve["equity"].pct_change().dropna())
        holdout_returns = (
            holdout.equity_curve["equity"].pct_change().dropna()
            - self.config.costs.annual_cash_rate / 252.0
        )
        multiple_testing_hurdle = expected_maximum_sharpe(leaderboard["sharpe_ratio"])
        statistical_significance = {
            "probabilistic_sharpe_ratio": probabilistic_sharpe_ratio(holdout_returns, 0.0),
            "multiple_testing_sharpe_hurdle": multiple_testing_hurdle,
            "deflated_sharpe_ratio": probabilistic_sharpe_ratio(
                holdout_returns, multiple_testing_hurdle
            ),
            "parameter_trials": float(len(leaderboard)),
        }
        validation_gate = {
            "holdout_profitable": bool(holdout.metrics["total_return"] > 0),
            "holdout_sharpe_above_0_5": bool(holdout.metrics["sharpe_ratio"] > 0.5),
            "positive_after_all_cost_stresses": bool((stress_results["total_return"] > 0).all()),
            "majority_profitable_walk_forward_folds": bool(
                (walk_forward["total_return"] > 0).mean() >= 2.0 / 3.0
            ),
            "bootstrap_positive_probability_above_70pct": bool(
                bootstrap["probability_positive_annual_return"] >= 0.70
            ),
            "risk_adjusted_return_above_benchmark": bool(
                holdout.metrics["sharpe_ratio"]
                > holdout.metrics["benchmark_sharpe_ratio"]
            ),
            "deflated_sharpe_probability_above_50pct": bool(
                statistical_significance["deflated_sharpe_ratio"] >= 0.50
            ),
        }
        return ResearchResult(
            best_params=best_params,
            leaderboard=leaderboard,
            train_metrics=train_result.metrics,
            holdout_metrics=holdout.metrics,
            stress_results=stress_results,
            split_timestamp=split_timestamp,
            walk_forward_results=walk_forward,
            bootstrap=bootstrap,
            validation_gate=validation_gate,
            statistical_significance=statistical_significance,
        )

    def _fit_parameters(
        self, train_data: pd.DataFrame
    ) -> Tuple[Dict[str, Any], pd.DataFrame, BacktestResult]:
        rows: List[Dict[str, Any]] = []
        train_results: Dict[Tuple[Tuple[str, Any], ...], BacktestResult] = {}
        base_params = dict(self.config.strategy.params)
        for candidate in expand_grid(self.config.research.parameter_grid):
            params = dict(base_params)
            params.update(candidate)
            strategy = build_strategy(self.config.strategy.name, params)
            result = Backtester(self.config, strategy).run(train_data)
            key = tuple(sorted(candidate.items()))
            train_results[key] = result
            rows.append(
                {
                    **candidate,
                    "robust_score": robust_score(
                        result.metrics, self.config.research.minimum_trades
                    ),
                    "total_return": result.metrics["total_return"],
                    "sharpe_ratio": result.metrics["sharpe_ratio"],
                    "sortino_ratio": result.metrics["sortino_ratio"],
                    "max_drawdown": result.metrics["max_drawdown"],
                    "turnover": result.metrics["turnover"],
                    "trade_count": result.metrics["trade_count"],
                }
            )
        leaderboard = pd.DataFrame(rows).sort_values("robust_score", ascending=False).reset_index(drop=True)
        parameter_names = sorted(self.config.research.parameter_grid)
        best_params = {name: leaderboard.iloc[0][name] for name in parameter_names}
        for name in best_params:
            original_values = list(self.config.research.parameter_grid[name])
            best_params[name] = min(original_values, key=lambda value: abs(float(value) - float(best_params[name])))
        best_key = tuple(sorted(best_params.items()))
        train_result = train_results[best_key]
        return best_params, leaderboard, train_result

    def _walk_forward(
        self, market_data: pd.DataFrame, dates: pd.Index, initial_split: int
    ) -> pd.DataFrame:
        folds = self.config.research.walk_forward_folds
        boundaries = np.linspace(initial_split, len(dates), folds + 1, dtype=int)
        timestamp_values = pd.to_datetime(market_data["timestamp"])
        rows = []
        for fold in range(folds):
            test_start_index = int(boundaries[fold])
            test_end_index = int(boundaries[fold + 1])
            if test_end_index <= test_start_index:
                continue
            start = pd.Timestamp(dates[test_start_index])
            end = pd.Timestamp(dates[test_end_index - 1])
            train = market_data.loc[timestamp_values < start]
            best_params, _, _ = self._fit_parameters(train)
            params = dict(self.config.strategy.params)
            params.update(best_params)
            through_test = market_data.loc[timestamp_values <= end]
            result = Backtester(
                self.config, build_strategy(self.config.strategy.name, params)
            ).run(through_test)
            test = _slice_result(result, start)
            rows.append(
                {
                    "fold": fold + 1,
                    "train_end": (start - pd.Timedelta(days=1)).date().isoformat(),
                    "test_start": start.date().isoformat(),
                    "test_end": end.date().isoformat(),
                    "best_params": json.dumps(best_params, sort_keys=True),
                    "total_return": test.metrics["total_return"],
                    "cagr": test.metrics["cagr"],
                    "sharpe_ratio": test.metrics["sharpe_ratio"],
                    "max_drawdown": test.metrics["max_drawdown"],
                    "trade_count": test.metrics["trade_count"],
                }
            )
        return pd.DataFrame(rows)

    def _block_bootstrap(self, returns: pd.Series) -> Dict[str, float]:
        values = returns.to_numpy(dtype=float)
        n = len(values)
        block_size = min(self.config.research.bootstrap_block_size, n)
        if n < 2:
            raise ValueError("Not enough holdout returns for bootstrap")
        rng = np.random.default_rng(20260813)
        annualized = []
        max_start = max(1, n - block_size + 1)
        for _ in range(self.config.research.bootstrap_samples):
            sample = []
            while len(sample) < n:
                start = int(rng.integers(0, max_start))
                sample.extend(values[start : start + block_size])
            growth = float(np.prod(1.0 + np.asarray(sample[:n])))
            annualized.append(growth ** (252.0 / n) - 1.0 if growth > 0 else -1.0)
        distribution = np.asarray(annualized)
        return {
            "probability_positive_annual_return": float((distribution > 0).mean()),
            "annual_return_p05": float(np.quantile(distribution, 0.05)),
            "annual_return_median": float(np.quantile(distribution, 0.50)),
            "annual_return_p95": float(np.quantile(distribution, 0.95)),
        }
