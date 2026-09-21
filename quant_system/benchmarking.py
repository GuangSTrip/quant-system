"""Apples-to-apples strategy benchmark and regime evaluation suite."""

import copy
import json
from dataclasses import dataclass
from pathlib import Path
from typing import Dict

import numpy as np
import pandas as pd

from .backtest import BacktestResult, Backtester
from .config import SystemConfig
from .performance import (
    calculate_metrics,
    expected_maximum_sharpe,
    probabilistic_sharpe_ratio,
)
from .strategies import (
    CrossSectionalMomentumStrategy,
    DualMomentumStrategy,
    EnsembleStrategy,
    EqualWeightStrategy,
    MultiHorizonTrendStrategy,
    OnlineExpertEnsembleStrategy,
    RollingRiskParityStrategy,
    SmaCrossStrategy,
    TrendFollowingStrategy,
)


REGIMES = {
    "global_financial_crisis": ("2007-10-01", "2009-03-31"),
    "post_gfc_expansion": ("2009-04-01", "2020-02-18"),
    "covid_crash": ("2020-02-19", "2020-04-30"),
    "inflation_shock_2022": ("2022-01-01", "2022-12-31"),
    "recent": ("2023-01-01", "2099-12-31"),
}


def _period_metrics(result: BacktestResult, start: str, end: str) -> Dict[str, float]:
    curve = result.equity_curve.loc[start:end].copy()
    if len(curve) < 2:
        return {
            "total_return": 0.0,
            "cagr": 0.0,
            "sharpe_ratio": 0.0,
            "max_drawdown": 0.0,
        }
    trades = result.trades.copy()
    if not trades.empty:
        timestamps = pd.to_datetime(trades["timestamp"])
        trades = trades.loc[
            (timestamps >= pd.Timestamp(start)) & (timestamps <= pd.Timestamp(end))
        ]
    metrics = calculate_metrics(
        curve, trades, float(result.metrics.get("annual_risk_free_rate", 0.0))
    )
    return {
        key: metrics[key]
        for key in ("total_return", "cagr", "sharpe_ratio", "max_drawdown")
    }


@dataclass
class BenchmarkResult:
    comparison: pd.DataFrame
    regime_results: pd.DataFrame
    yearly_returns: pd.DataFrame
    risk_overlay_ablation: pd.DataFrame
    cost_stress: pd.DataFrame
    split_timestamp: pd.Timestamp
    selection_statistics: Dict[str, object]
    equity_curves: pd.DataFrame
    capacity_stress: pd.DataFrame

    def save(self, output_dir: str) -> None:
        destination = Path(output_dir)
        destination.mkdir(parents=True, exist_ok=True)
        self.comparison.to_csv(destination / "strategy_comparison.csv", index=False)
        self.regime_results.to_csv(destination / "regime_analysis.csv", index=False)
        self.yearly_returns.to_csv(destination / "yearly_returns.csv", index=False)
        self.risk_overlay_ablation.to_csv(destination / "risk_overlay_ablation.csv", index=False)
        self.cost_stress.to_csv(destination / "cost_stress.csv", index=False)
        self.equity_curves.to_csv(destination / "strategy_equity_curves.csv", index=False)
        self.capacity_stress.to_csv(destination / "capacity_stress.csv", index=False)
        with (destination / "selection_statistics.json").open("w", encoding="utf-8") as handle:
            json.dump(self.selection_statistics, handle, indent=2, ensure_ascii=False)
        best_sharpe = self.comparison.sort_values("sharpe_ratio", ascending=False).iloc[0]
        best_calmar = self.comparison.sort_values("calmar_ratio", ascending=False).iloc[0]
        selected = self.comparison.loc[self.comparison["selected_on_development"]].iloc[0]
        validated_capacity = self.capacity_stress.loc[
            self.capacity_stress["capacity_pass"], "initial_cash"
        ].max()
        with (destination / "benchmark_report.md").open("w", encoding="utf-8") as handle:
            handle.write(
                "\n".join(
                    [
                        "# 策略基准报告",
                        "",
                        "- 风险调整收益最佳：`%s`（Sharpe %.3f）"
                        % (best_sharpe["strategy"], best_sharpe["sharpe_ratio"]),
                        "- 回撤效率最佳：`%s`（Calmar %.3f）"
                        % (best_calmar["strategy"], best_calmar["calmar_ratio"]),
                        "- 所有策略使用相同数据、成本、执行与风险约束。",
                        "- 开发/留出切分点：`%s`。" % self.split_timestamp.date(),
                        "- 仅按开发集选出的策略：`%s`；其留出集 Sharpe 为 `%.3f`。"
                        % (selected["strategy"], selected["holdout_sharpe_ratio"]),
                        "- 多重试验校正后 Sharpe 概率：`%.1f%%`。"
                        % (100 * self.selection_statistics["deflated_sharpe_ratio"]),
                        "- 区块 Bootstrap 留出期年化收益为正概率：`%.1f%%`。"
                        % (
                            100
                            * self.selection_statistics[
                                "bootstrap_probability_positive_annual_return"
                            ]
                        ),
                        "- 当前模型通过成交完整性门槛的最高已测试资金：`$%s`。"
                        % format(validated_capacity, ",.0f"),
                        "- SOTA 验证门禁：`%s`。"
                        % (
                            "PASS"
                            if all(self.selection_statistics["validation_gates"].values())
                            else "FAIL"
                        ),
                        "",
                        _markdown_table(self.comparison),
                        "",
                    ]
                )
            )


class BenchmarkRunner:
    def __init__(self, config: SystemConfig) -> None:
        self.config = config

    def _strategies(self):
        symbols_by_group: Dict[str, list] = {}
        for symbol, group in self.config.risk.asset_groups.items():
            symbols_by_group.setdefault(group, []).append(symbol)
        offensive = symbols_by_group.get("equity", ["SPY", "QQQ", "IWM", "EFA", "EEM"])
        defensive = (
            symbols_by_group.get("rates", ["IEF", "TLT"])
            + symbols_by_group.get("inflation", ["TIP", "GLD", "DBC"])
            + symbols_by_group.get("cash", ["BIL"])
        )
        def multi():
            return MultiHorizonTrendStrategy(
                horizons=(21, 63, 126, 252), allocation=0.95, target_smoothing=0.35
            )
        def long_short_multi():
            return MultiHorizonTrendStrategy(
                horizons=(21, 63, 126, 252),
                allocation=0.95,
                target_smoothing=0.35,
                long_short=True,
            )
        return {
            "equal_weight": EqualWeightStrategy(0.95),
            "sma_cross_50_200": SmaCrossStrategy(50, 200, 0.95),
            "risk_parity": RollingRiskParityStrategy(
                63, 0.95, 21, method="equal_risk_contribution"
            ),
            "single_horizon_trend": TrendFollowingStrategy(84, 168, 40, 0.95, 5),
            "multi_horizon_trend": multi(),
            "cross_sectional_momentum": CrossSectionalMomentumStrategy(
                lookback=126,
                skip=5,
                top_k=min(3, max(1, len(offensive))),
                allocation=0.95,
                rebalance_interval=21,
            ),
            "long_short_multi_horizon": long_short_multi(),
            "dual_momentum": DualMomentumStrategy(
                offensive, defensive, 252, 5, 3, 0.95, 21
            ),
            "adaptive_multi_alpha": EnsembleStrategy(
                [
                    (multi(), 0.60),
                    (
                        CrossSectionalMomentumStrategy(
                            lookback=126,
                            skip=5,
                            top_k=4,
                            allocation=0.95,
                            rebalance_interval=21,
                        ),
                        0.40,
                    ),
                ],
                adaptive=True,
                adaptive_lookback=126,
                minimum_history=60,
                weight_shrinkage=0.60,
            ),
            "balanced_multi_alpha": EnsembleStrategy(
                [
                    (RollingRiskParityStrategy(63, 0.95, 21), 0.35),
                    (multi(), 0.40),
                    (
                        DualMomentumStrategy(
                            offensive, defensive, 252, 5, 3, 0.95, 21
                        ),
                        0.25,
                    ),
                ],
                adaptive=True,
                adaptive_lookback=126,
                minimum_history=60,
                weight_shrinkage=0.75,
                minimum_sleeve_weight=0.10,
                maximum_sleeve_weight=0.65,
            ),
            "crisis_balanced_alpha": EnsembleStrategy(
                [
                    (RollingRiskParityStrategy(63, 0.95, 21), 0.30),
                    (long_short_multi(), 0.45),
                    (
                        CrossSectionalMomentumStrategy(
                            lookback=126,
                            skip=5,
                            top_k=4,
                            allocation=0.95,
                            rebalance_interval=21,
                        ),
                        0.25,
                    ),
                ],
                adaptive=True,
                adaptive_lookback=126,
                minimum_history=60,
                weight_shrinkage=0.75,
            ),
            "online_expert_ensemble": OnlineExpertEnsembleStrategy(
                [
                    (
                        RollingRiskParityStrategy(
                            63, 0.95, 21, method="equal_risk_contribution"
                        ),
                        0.25,
                    ),
                    (multi(), 0.35),
                    (
                        CrossSectionalMomentumStrategy(
                            lookback=126,
                            skip=5,
                            top_k=4,
                            allocation=0.95,
                            rebalance_interval=21,
                        ),
                        0.25,
                    ),
                    (
                        DualMomentumStrategy(
                            offensive, defensive, 252, 5, 3, 0.95, 21
                        ),
                        0.15,
                    ),
                ],
                learning_rate=0.05,
                score_decay=0.99,
                prior_shrinkage=0.60,
                estimated_cost_bps=5.0,
            ),
        }

    def run(self, market_data: pd.DataFrame) -> BenchmarkResult:
        comparison_rows = []
        regime_rows = []
        yearly_rows = []
        equity_rows = []
        dates = pd.Index(sorted(pd.to_datetime(market_data["timestamp"]).unique()))
        split_timestamp = pd.Timestamp(dates[int(len(dates) * 0.70)])
        results: Dict[str, BacktestResult] = {}
        for name, strategy in self._strategies().items():
            result = Backtester(copy.deepcopy(self.config), strategy).run(market_data)
            results[name] = result
            curve_export = result.equity_curve.reset_index()[
                ["timestamp", "equity", "gross_exposure", "drawdown"]
            ].copy()
            curve_export.insert(0, "strategy", name)
            equity_rows.append(curve_export)
            development = _period_metrics(result, str(dates[0]), str(split_timestamp - pd.Timedelta(days=1)))
            holdout = _period_metrics(result, str(split_timestamp), str(dates[-1]))
            comparison_rows.append(
                {
                    "strategy": name,
                    **{
                        key: result.metrics[key]
                        for key in (
                            "cagr",
                            "annual_volatility",
                            "sharpe_ratio",
                            "sortino_ratio",
                            "max_drawdown",
                            "calmar_ratio",
                            "turnover",
                            "total_commission",
                            "annualized_alpha",
                        )
                    },
                    "development_sharpe_ratio": development["sharpe_ratio"],
                    "holdout_cagr": holdout["cagr"],
                    "holdout_sharpe_ratio": holdout["sharpe_ratio"],
                    "holdout_max_drawdown": holdout["max_drawdown"],
                }
            )
            for regime, (start, end) in REGIMES.items():
                regime_rows.append(
                    {"strategy": name, "regime": regime, **_period_metrics(result, start, end)}
                )
            annual = result.equity_curve["equity"].resample(pd.offsets.YearEnd()).last().pct_change().dropna()
            for timestamp, value in annual.items():
                yearly_rows.append(
                    {"strategy": name, "year": timestamp.year, "return": float(value)}
                )
        comparison = pd.DataFrame(comparison_rows)
        selected_name = str(
            comparison.sort_values("development_sharpe_ratio", ascending=False).iloc[0]["strategy"]
        )
        comparison["selected_on_development"] = comparison["strategy"].eq(selected_name)
        comparison["sharpe_rank"] = comparison["sharpe_ratio"].rank(
            method="min", ascending=False
        ).astype(int)
        ablation_rows = []
        for scenario in ("legacy_slow_hard", "fast_volatility", "full_overlay"):
            scenario_config = copy.deepcopy(self.config)
            if scenario == "legacy_slow_hard":
                scenario_config.risk.fast_volatility_lookback = (
                    scenario_config.risk.volatility_lookback
                )
                scenario_config.risk.minimum_drawdown_scale = 1.0
            elif scenario == "fast_volatility":
                scenario_config.risk.minimum_drawdown_scale = 1.0
            strategy = self._strategies()[selected_name]
            result = Backtester(scenario_config, strategy).run(market_data)
            ablation_rows.append(
                {
                    "scenario": scenario,
                    **{
                        key: result.metrics[key]
                        for key in ("cagr", "sharpe_ratio", "max_drawdown", "calmar_ratio")
                    },
                }
            )

        stress_rows = []
        for multiplier in (1.0, 2.0, 3.0, 5.0):
            stressed = copy.deepcopy(self.config)
            stressed.costs.commission_rate *= multiplier
            stressed.costs.slippage_bps *= multiplier
            stressed.costs.spread_bps *= multiplier
            stressed.costs.market_impact *= multiplier
            result = Backtester(stressed, self._strategies()[selected_name]).run(market_data)
            holdout = _period_metrics(result, str(split_timestamp), str(dates[-1]))
            stress_rows.append(
                {
                    "cost_multiplier": multiplier,
                    "holdout_cagr": holdout["cagr"],
                    "holdout_sharpe_ratio": holdout["sharpe_ratio"],
                    "holdout_max_drawdown": holdout["max_drawdown"],
                }
            )
        cost_stress = pd.DataFrame(stress_rows)
        selected_result = results[selected_name]
        selected_curve = selected_result.equity_curve.loc[
            selected_result.equity_curve.index >= split_timestamp, "equity"
        ]
        raw_holdout_returns = selected_curve.pct_change().dropna()
        excess_holdout_returns = (
            raw_holdout_returns - self.config.costs.annual_cash_rate / 252.0
        )
        multiple_testing_hurdle = expected_maximum_sharpe(
            comparison["development_sharpe_ratio"]
        )
        bootstrap_probability = _block_bootstrap_positive_probability(
            raw_holdout_returns, samples=2000, block_size=20
        )
        deflated = probabilistic_sharpe_ratio(
            excess_holdout_returns, multiple_testing_hurdle
        )
        selected_row = comparison.loc[comparison["strategy"].eq(selected_name)].iloc[0]
        selection_statistics = {
            "selected_strategy": selected_name,
            "split_timestamp": split_timestamp.isoformat(),
            "parameter_and_strategy_trials": int(len(comparison)),
            "multiple_testing_sharpe_hurdle": multiple_testing_hurdle,
            "probabilistic_sharpe_ratio": probabilistic_sharpe_ratio(
                excess_holdout_returns, 0.0
            ),
            "deflated_sharpe_ratio": deflated,
            "bootstrap_probability_positive_annual_return": bootstrap_probability,
            "validation_gates": {
                "holdout_cagr_positive": bool(selected_row["holdout_cagr"] > 0),
                "holdout_sharpe_positive": bool(
                    selected_row["holdout_sharpe_ratio"] > 0
                ),
                "deflated_sharpe_probability_above_50pct": bool(deflated >= 0.50),
                "positive_cagr_at_5x_cost": bool(
                    cost_stress.iloc[-1]["holdout_cagr"] > 0
                ),
                "bootstrap_positive_probability_above_70pct": bool(
                    bootstrap_probability >= 0.70
                ),
            },
        }
        capacity_rows = []
        for initial_cash in (100_000.0, 1_000_000.0, 10_000_000.0, 100_000_000.0):
            capacity_config = copy.deepcopy(self.config)
            capacity_config.engine.initial_cash = initial_cash
            result = Backtester(
                capacity_config, self._strategies()[selected_name]
            ).run(market_data)
            holdout = _period_metrics(result, str(split_timestamp), str(dates[-1]))
            capacity_rows.append(
                {
                    "initial_cash": initial_cash,
                    "holdout_cagr": holdout["cagr"],
                    "holdout_sharpe_ratio": holdout["sharpe_ratio"],
                    "holdout_max_drawdown": holdout["max_drawdown"],
                    "average_fill_ratio": float(result.trades["fill_ratio"].mean())
                    if not result.trades.empty
                    else 1.0,
                    "max_participation_rate": float(
                        result.trades["participation_rate"].max()
                    )
                    if not result.trades.empty
                    else 0.0,
                }
            )
        capacity_stress = pd.DataFrame(capacity_rows)
        capacity_stress["capacity_pass"] = capacity_stress["average_fill_ratio"].ge(0.95)
        validated_capacity = float(
            capacity_stress.loc[capacity_stress["capacity_pass"], "initial_cash"].max()
        )
        selection_statistics["maximum_tested_capacity_with_95pct_average_fill"] = (
            validated_capacity
        )
        selection_statistics["validation_gates"]["ten_million_capacity_fill_above_95pct"] = bool(
            capacity_stress.loc[
                capacity_stress["initial_cash"].eq(10_000_000.0), "capacity_pass"
            ].iloc[0]
        )
        return BenchmarkResult(
            comparison.sort_values("sharpe_ratio", ascending=False).reset_index(drop=True),
            pd.DataFrame(regime_rows),
            pd.DataFrame(yearly_rows),
            pd.DataFrame(ablation_rows),
            cost_stress,
            split_timestamp,
            selection_statistics,
            pd.concat(equity_rows, ignore_index=True),
            capacity_stress,
        )


def _markdown_table(frame: pd.DataFrame) -> str:
    columns = list(frame.columns)
    lines = [
        "| " + " | ".join(columns) + " |",
        "|" + "|".join(["---"] + ["---:"] * (len(columns) - 1)) + "|",
    ]
    for _, row in frame.iterrows():
        values = []
        for column in columns:
            value = row[column]
            values.append("%.4f" % value if isinstance(value, float) else str(value))
        lines.append("| " + " | ".join(values) + " |")
    return "\n".join(lines)


def _block_bootstrap_positive_probability(
    returns: pd.Series, samples: int, block_size: int
) -> float:
    values = returns.dropna().to_numpy(dtype=float)
    if len(values) < 2:
        return 0.0
    block_size = min(block_size, len(values))
    max_start = max(1, len(values) - block_size + 1)
    rng = np.random.default_rng(20260813)
    positive = 0
    for _ in range(samples):
        sample = []
        while len(sample) < len(values):
            start = int(rng.integers(0, max_start))
            sample.extend(values[start : start + block_size])
        if float(np.prod(1.0 + np.asarray(sample[: len(values)]))) > 1.0:
            positive += 1
    return positive / samples
