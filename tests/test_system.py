import tempfile
import unittest
import copy
import os
from pathlib import Path
from unittest.mock import patch

import pandas as pd

from quant_system.backtest import Backtester
from quant_system.benchmarking import BenchmarkRunner
from quant_system.broker import AlpacaPaperBroker, Order, OrderStatus, PaperBroker
from quant_system.config import CostConfig, PaperTradingConfig, RiskConfig, SystemConfig, load_config
from quant_system.data import align_panel, data_quality_report, generate_synthetic_data, validate_bars
from quant_system.performance import (
    calculate_metrics,
    expected_maximum_sharpe,
    probabilistic_sharpe_ratio,
)
from quant_system.research import ResearchRunner, expand_grid
from quant_system.portfolio import (
    allocate,
    equal_risk_contribution_weights,
    exponentially_weighted_covariance,
    risk_contributions,
    shrink_covariance,
)
from quant_system.risk import RiskManager
from quant_system.strategies import build_strategy
from quant_system.strategies.base import Strategy


class AlwaysLongStrategy(Strategy):
    def on_bar(self, timestamp, bars):
        return {symbol: 0.5 for symbol in bars}


class QuantSystemTests(unittest.TestCase):
    def test_close_signal_executes_on_next_bar_open(self):
        data = generate_synthetic_data(["AAA"], periods=4, seed=9)
        config = SystemConfig.from_dict(
            {
                "engine": {"initial_cash": 100_000},
                "risk": {"max_position_weight": 0.8, "max_gross_leverage": 1.0},
            }
        )
        result = Backtester(config, AlwaysLongStrategy()).run(data)
        self.assertEqual(
            pd.Timestamp(result.trades.iloc[0]["timestamp"]),
            pd.Timestamp(data["timestamp"].sort_values().iloc[1]),
        )
        self.assertAlmostEqual(
            float(result.trades.iloc[0]["reference_price"]),
            float(data.sort_values("timestamp").iloc[1]["open"]),
        )

    def test_synthetic_data_is_valid_and_deterministic(self):
        first = generate_synthetic_data(["AAA", "BBB"], periods=30, seed=11)
        second = generate_synthetic_data(["AAA", "BBB"], periods=30, seed=11)
        pd.testing.assert_frame_equal(first, second)
        self.assertEqual(len(first), 60)

    def test_panel_intersection_removes_incomplete_dates(self):
        data = generate_synthetic_data(["AAA", "BBB"], periods=5)
        missing_date = data.loc[data["symbol"].eq("BBB"), "timestamp"].iloc[0]
        incomplete = data.loc[
            ~((data["symbol"] == "BBB") & (data["timestamp"] == missing_date))
        ]
        aligned = align_panel(incomplete, "intersection")
        self.assertEqual(aligned["timestamp"].nunique(), 4)
        self.assertTrue(aligned.groupby("timestamp")["symbol"].nunique().eq(2).all())

    def test_bad_ohlc_is_rejected(self):
        data = generate_synthetic_data(["AAA"], periods=3)
        data.loc[0, "high"] = data.loc[0, "low"] * 0.5
        with self.assertRaisesRegex(ValueError, "High price"):
            validate_bars(data)

    def test_risk_manager_caps_and_scales_targets(self):
        risk = RiskManager(
            RiskConfig(max_position_weight=0.4, max_gross_leverage=0.6, allow_short=False)
        )
        targets = risk.adjust_targets({"AAA": 0.8, "BBB": 0.5, "CCC": -0.2}, 0.0)
        self.assertAlmostEqual(sum(abs(value) for value in targets.values()), 0.6)
        self.assertEqual(targets["CCC"], 0.0)

    def test_risk_manager_redistributes_feasible_long_only_budget(self):
        risk = RiskManager(
            RiskConfig(
                max_position_weight=0.4,
                max_gross_leverage=0.9,
                max_group_weight=0.5,
                asset_groups={"AAA": "equity", "BBB": "equity", "CCC": "rates"},
            )
        )
        targets = risk.adjust_targets({"AAA": 0.7, "BBB": 0.1, "CCC": 0.1}, 0.0)
        self.assertAlmostEqual(sum(targets.values()), 0.9, places=8)
        self.assertLessEqual(targets["AAA"] + targets["BBB"], 0.5 + 1e-10)
        self.assertTrue(all(value <= 0.4 + 1e-10 for value in targets.values()))

    def test_volatility_amplification_still_respects_all_caps(self):
        risk = RiskManager(
            RiskConfig(
                max_position_weight=0.30,
                max_gross_leverage=0.60,
                max_group_weight=0.40,
                target_volatility=0.20,
                max_volatility_scale=2.0,
                asset_groups={"AAA": "equity", "BBB": "equity", "CCC": "rates"},
            )
        )
        targets = risk.adjust_targets(
            {"AAA": 0.2, "BBB": 0.2, "CCC": 0.2}, 0.0, realized_volatility=0.05
        )
        self.assertLessEqual(sum(abs(value) for value in targets.values()), 0.60 + 1e-10)
        self.assertLessEqual(max(abs(value) for value in targets.values()), 0.30 + 1e-10)
        self.assertLessEqual(targets["AAA"] + targets["BBB"], 0.40 + 1e-10)

    def test_drawdown_circuit_breaker_flattens_targets(self):
        risk = RiskManager(RiskConfig(max_drawdown=0.1))
        self.assertEqual(risk.adjust_targets({"AAA": 0.5}, -0.11), {"AAA": 0.0})

    def test_end_to_end_backtest_and_report(self):
        config = SystemConfig.from_dict(
            {
                "engine": {"initial_cash": 100_000, "allow_fractional": False},
                "strategy": {
                    "name": "sma_cross",
                    "params": {"fast_window": 3, "slow_window": 8, "allocation": 0.8},
                },
                "risk": {"max_position_weight": 0.8, "max_gross_leverage": 1.0},
            }
        )
        strategy = build_strategy(config.strategy.name, config.strategy.params)
        result = Backtester(config, strategy).run(
            generate_synthetic_data(["AAA"], periods=80, seed=3)
        )
        self.assertEqual(len(result.equity_curve), 80)
        self.assertGreater(result.metrics["trade_count"], 0)
        self.assertIn("sharpe_ratio", result.metrics)
        with tempfile.TemporaryDirectory() as tmp:
            result.save(tmp)
            self.assertTrue((Path(tmp) / "metrics.json").exists())
            self.assertTrue((Path(tmp) / "equity_curve.csv").exists())
            self.assertTrue((Path(tmp) / "trades.csv").exists())
            self.assertTrue((Path(tmp) / "positions.csv").exists())
            self.assertTrue((Path(tmp) / "tearsheet.md").exists())

    def test_demo_config_loads(self):
        config = load_config("configs/demo.yaml")
        self.assertEqual(config.strategy.name, "sma_cross")

    def test_sota_production_config_loads(self):
        config = load_config("configs/sota_production.yaml")
        self.assertEqual(config.strategy.name, "ensemble")
        self.assertEqual(len(config.strategy.sleeves), 2)
        self.assertTrue(config.strategy.params["adaptive"])

    def test_alpaca_paper_template_is_safe_by_default(self):
        config = load_config("configs/alpaca_paper.yaml")
        self.assertFalse(config.paper_trading.enabled)
        self.assertEqual(config.paper_trading.data_feed, "iex")

    def test_legacy_config_without_asset_groups_remains_valid(self):
        config = load_config("configs/real_research.yaml")
        self.assertFalse(config.risk.asset_groups)
        self.assertEqual(config.risk.max_gross_leverage, 0.95)

    def test_data_quality_report_covers_every_symbol(self):
        data = generate_synthetic_data(["AAA", "BBB"], periods=12)
        report = data_quality_report(data)
        self.assertEqual(report["symbols"], 2)
        self.assertEqual(set(report["symbol_details"]), {"AAA", "BBB"})

    def test_paper_broker_partial_fill_lifecycle(self):
        bars = generate_synthetic_data(["AAA"], periods=2)
        first = bars.iloc[0]
        broker = PaperBroker(CostConfig(), max_volume_participation=0.01)
        requested = float(first["volume"]) * 0.01 + float(bars.iloc[1]["volume"]) * 0.005
        order = Order("AAA", requested, pd.Timestamp(first["timestamp"]))
        broker.submit(order)
        fills = broker.on_bar(pd.Timestamp(first["timestamp"]), {"AAA": first})
        self.assertEqual(len(fills), 1)
        self.assertEqual(order.status, OrderStatus.PARTIALLY_FILLED)
        second = bars.iloc[1]
        broker.on_bar(pd.Timestamp(second["timestamp"]), {"AAA": second})
        self.assertEqual(order.status, OrderStatus.FILLED)

    def test_parameter_grid_and_small_research(self):
        self.assertEqual(len(expand_grid({"a": [1, 2], "b": [3, 4]})), 4)
        config = SystemConfig.from_dict(
            {
                "engine": {"initial_cash": 100_000, "rebalance_threshold": 0.01},
                "risk": {"max_position_weight": 0.8, "max_gross_leverage": 1.0},
                "strategy": {
                    "name": "trend",
                    "params": {
                        "medium_window": 8,
                        "long_window": 20,
                        "volatility_window": 5,
                        "rebalance_interval": 3,
                    },
                },
                "research": {
                    "train_fraction": 0.6,
                    "parameter_grid": {"medium_window": [6, 8]},
                    "cost_stress_multipliers": [1, 2],
                    "walk_forward_folds": 2,
                    "bootstrap_samples": 100,
                    "bootstrap_block_size": 5,
                    "minimum_trades": 1,
                },
            }
        )
        data = generate_synthetic_data(
            ["AAA", "BBB"], periods=160, seed=4, autocorrelation=0.1
        )
        result = ResearchRunner(config).run(data)
        self.assertEqual(len(result.walk_forward_results), 2)
        self.assertEqual(len(result.stress_results), 2)
        self.assertIn("holdout_profitable", result.validation_gate)

    def test_multiple_testing_hurdle_and_psr_are_bounded(self):
        hurdle = expected_maximum_sharpe(pd.Series([0.2, 0.5, 0.8, 0.4]))
        self.assertGreater(hurdle, 0.5)
        probability = probabilistic_sharpe_ratio(
            pd.Series([0.01, -0.002, 0.008, 0.004, -0.001] * 30), hurdle
        )
        self.assertGreaterEqual(probability, 0.0)
        self.assertLessEqual(probability, 1.0)

    def test_sharpe_uses_excess_not_total_return(self):
        dates = pd.bdate_range("2024-01-01", periods=80)
        equity = pd.Series(100_000 * (1.0004 ** pd.RangeIndex(80)), index=dates)
        curve = pd.DataFrame({"equity": equity, "benchmark_equity": equity}, index=dates)
        trades = pd.DataFrame(columns=["notional", "commission"])
        zero_rate = calculate_metrics(curve, trades, 0.0)
        high_rate = calculate_metrics(curve, trades, 0.10)
        self.assertLess(high_rate["sharpe_ratio"], zero_rate["sharpe_ratio"])

    def test_multi_horizon_strategy_has_full_warmup(self):
        config = SystemConfig.from_dict(
            {
                "engine": {"initial_cash": 100_000},
                "risk": {"max_position_weight": 0.8, "max_gross_leverage": 1.0},
                "strategy": {
                    "name": "multi_horizon_trend",
                    "params": {
                        "horizons": [10, 30],
                        "volatility_window": 10,
                        "rebalance_interval": 1,
                    },
                },
            }
        )
        data = generate_synthetic_data(["AAA"], periods=60, seed=18, drift=0.002)
        result = Backtester(
            config, build_strategy(config.strategy.name, config.strategy.params)
        ).run(data)
        if not result.trades.empty:
            dates = sorted(pd.to_datetime(data["timestamp"]).unique())
            self.assertGreaterEqual(pd.Timestamp(result.trades.iloc[0]["timestamp"]), dates[31])

    def test_higher_costs_do_not_improve_same_deterministic_run(self):
        config = SystemConfig.from_dict(
            {
                "engine": {"initial_cash": 100_000},
                "risk": {"max_position_weight": 0.8, "max_gross_leverage": 1.0},
                "strategy": {
                    "name": "sma_cross",
                    "params": {"fast_window": 3, "slow_window": 8, "allocation": 0.8},
                },
            }
        )
        data = generate_synthetic_data(["AAA"], periods=120, seed=23)
        low = Backtester(
            config, build_strategy(config.strategy.name, config.strategy.params)
        ).run(data)
        expensive = copy.deepcopy(config)
        expensive.costs.commission_rate = 0.01
        expensive.costs.slippage_bps = 50
        high = Backtester(
            expensive, build_strategy(expensive.strategy.name, expensive.strategy.params)
        ).run(data)
        self.assertLessEqual(high.metrics["end_equity"], low.metrics["end_equity"])

    def test_benchmark_suite_selects_only_on_development_period(self):
        config = SystemConfig.from_dict(
            {
                "engine": {"initial_cash": 100_000},
                "costs": {"annual_cash_rate": 0.01},
                "risk": {
                    "max_position_weight": 0.5,
                    "max_gross_leverage": 0.95,
                    "max_group_weight": 0.7,
                    "asset_groups": {
                        "VTI": "equity",
                        "IEF": "rates",
                        "GLD": "inflation",
                        "BIL": "cash",
                    },
                },
            }
        )
        data = generate_synthetic_data(
            ["VTI", "IEF", "GLD", "BIL"], periods=320, seed=42, autocorrelation=0.05
        )
        result = BenchmarkRunner(config).run(data)
        self.assertEqual(int(result.comparison["selected_on_development"].sum()), 1)
        self.assertEqual(len(result.cost_stress), 4)
        self.assertIn("deflated_sharpe_ratio", result.selection_statistics)

    def test_portfolio_construction_is_long_only_and_normalized(self):
        returns = pd.DataFrame(
            {"AAA": [0.01, -0.01, 0.02, 0.0], "BBB": [0.003, 0.004, -0.002, 0.005]}
        )
        weights = allocate(returns, ["AAA", "BBB"], 0.9, "minimum_variance")
        self.assertAlmostEqual(sum(weights.values()), 0.9)
        self.assertTrue(all(weight >= 0 for weight in weights.values()))
        covariance = shrink_covariance(returns)
        contributions = risk_contributions(
            pd.Series(weights).reindex(["AAA", "BBB"]).to_numpy(), covariance
        )
        self.assertAlmostEqual(float(contributions.sum()), 1.0)

    def test_equal_risk_contribution_balances_diagonal_covariance(self):
        covariance = pd.DataFrame(
            [[0.04, 0.0, 0.0], [0.0, 0.01, 0.0], [0.0, 0.0, 0.0025]]
        ).to_numpy()
        weights = equal_risk_contribution_weights(covariance)
        contributions = risk_contributions(weights, covariance)
        self.assertAlmostEqual(float(weights.sum()), 1.0)
        self.assertLess(float(contributions.max() - contributions.min()), 1e-6)

    def test_exponential_covariance_is_finite_and_positive_diagonal(self):
        returns = pd.DataFrame(
            {"A": [0.01, -0.02, 0.015, 0.003], "B": [0.002, 0.004, -0.003, 0.005]}
        )
        covariance = exponentially_weighted_covariance(returns, span=3)
        self.assertTrue(pd.notna(covariance).all())
        self.assertTrue((covariance.diagonal() > 0).all())

    def test_alpaca_paper_plan_is_risk_checked_and_side_effect_free(self):
        with tempfile.TemporaryDirectory() as tmp:
            settings = PaperTradingConfig(
                enabled=True, state_directory=tmp, audit_log_path=str(Path(tmp) / "audit.jsonl")
            )
            calls = []

            def fake_request(method, path, headers, payload):
                calls.append((method, path, payload))
                if path == "/v2/account":
                    return {"equity": "1000", "cash": "1000", "buying_power": "1000"}
                if path == "/v2/positions":
                    return [{"symbol": "AAA", "qty": "2"}]
                raise AssertionError(path)

            with patch.dict(os.environ, {settings.api_key_env: "key", settings.api_secret_env: "secret"}):
                broker = AlpacaPaperBroker(settings, RiskConfig(max_position_weight=0.6), fake_request)
                account = broker.account()
                plan = broker.plan_target_orders({"AAA": 0.5}, {"AAA": 100}, account)
            self.assertEqual(len(plan), 1)
            self.assertEqual(plan[0].symbol, "AAA")
            self.assertAlmostEqual(plan[0].quantity, 3.0)
            self.assertTrue(all(method == "GET" for method, _, _ in calls))

    def test_alpaca_paper_submit_recovers_same_client_order_id(self):
        with tempfile.TemporaryDirectory() as tmp:
            settings = PaperTradingConfig(enabled=True, state_directory=tmp, audit_log_path=str(Path(tmp) / "audit.jsonl"))
            posted = []

            def fake_request(method, path, headers, payload):
                if path == "/v2/account":
                    return {"equity": "1000", "cash": "1000", "buying_power": "1000"}
                if method == "GET" and path.startswith("/v2/orders:by_client_order_id"):
                    return {"id": "remote-1", "status": "new", "filled_qty": "0"}
                if method == "POST":
                    posted.append(payload)
                    return {"id": "remote-2", "status": "new", "filled_qty": "0"}
                raise AssertionError((method, path))

            with patch.dict(os.environ, {settings.api_key_env: "key", settings.api_secret_env: "secret"}):
                broker = AlpacaPaperBroker(settings, request_fn=fake_request)
                remote = broker.submit(Order("AAA", 1, pd.Timestamp("2025-01-01"), order_id="same"))
            self.assertEqual(remote, "remote-1")
            self.assertEqual(posted, [])

    def test_alpaca_kill_switch_refuses_submission(self):
        with tempfile.TemporaryDirectory() as tmp:
            settings = PaperTradingConfig(enabled=True, state_directory=tmp, audit_log_path=str(Path(tmp) / "audit.jsonl"))
            with patch.dict(os.environ, {settings.api_key_env: "key", settings.api_secret_env: "secret"}):
                broker = AlpacaPaperBroker(settings, request_fn=lambda *args: {})
                broker.set_halted(True, "test")
                with self.assertRaisesRegex(PermissionError, "kill switch"):
                    broker.submit(Order("AAA", 1, pd.Timestamp("2025-01-01")))


if __name__ == "__main__":
    unittest.main()
