"""Command-line entry point."""

import argparse
import json
import platform
import sys
import hashlib
from dataclasses import asdict
from pathlib import Path
from typing import Optional, Sequence

import pandas as pd

from .backtest import Backtester
from .benchmarking import BenchmarkRunner
from .broker import AlpacaPaperBroker
from .config import load_config
from .data import load_data
from .data import data_quality_report
from .research import ResearchRunner
from .live import build_paper_plan
from .strategies import build_ensemble, build_strategy
from .dashboard import add_dashboard_arguments, serve_dashboard


def _percent(value: float) -> str:
    return "%8.2f%%" % (value * 100.0)


def run(config_path: str, output_dir: str) -> int:
    config = load_config(config_path)
    market_data = load_data(config.data)
    strategy = (
        build_ensemble(config.strategy.sleeves, config.strategy.params)
        if config.strategy.name == "ensemble"
        else build_strategy(config.strategy.name, config.strategy.params)
    )
    result = Backtester(config, strategy).run(market_data)
    result.save(output_dir)
    _save_run_context(output_dir, config_path, config, market_data)

    print("Backtest complete: %s" % Path(output_dir).resolve())
    print("  total return : %s" % _percent(result.metrics["total_return"]))
    print("  CAGR         : %s" % _percent(result.metrics["cagr"]))
    print("  max drawdown : %s" % _percent(result.metrics["max_drawdown"]))
    print("  Sharpe ratio : %8.2f" % result.metrics["sharpe_ratio"])
    print("  trades       : %8d" % result.metrics["trade_count"])
    return 0


def run_research(config_path: str, output_dir: str) -> int:
    config = load_config(config_path)
    market_data = load_data(config.data)
    result = ResearchRunner(config).run(market_data)
    result.save(output_dir)
    _save_run_context(output_dir, config_path, config, market_data)
    print("Research complete: %s" % Path(output_dir).resolve())
    print("  best params     : %s" % result.best_params)
    print("  holdout return  : %s" % _percent(result.holdout_metrics["total_return"]))
    print("  holdout Sharpe  : %8.2f" % result.holdout_metrics["sharpe_ratio"])
    print("  holdout drawdown: %s" % _percent(result.holdout_metrics["max_drawdown"]))
    return 0


def run_benchmark(config_path: str, output_dir: str) -> int:
    config = load_config(config_path)
    market_data = load_data(config.data)
    result = BenchmarkRunner(config).run(market_data)
    result.save(output_dir)
    _save_run_context(output_dir, config_path, config, market_data)
    best = result.comparison.iloc[0]
    print("Benchmark complete: %s" % Path(output_dir).resolve())
    print("  best strategy: %s" % best["strategy"])
    print("  best Sharpe  : %8.2f" % best["sharpe_ratio"])
    return 0


def run_paper_status(config_path: str) -> int:
    config = load_config(config_path)
    broker = AlpacaPaperBroker.from_environment(config.paper_trading, config.risk)
    account = broker.account()
    clock = broker.clock()
    positions = broker.positions()
    open_orders = broker.open_orders()
    expected = broker.load_expected_positions()
    print("Alpaca paper status")
    print("  market open : %s" % bool(clock.get("is_open", False)))
    print("  equity      : %.2f" % account.equity)
    print("  cash        : %.2f" % account.cash)
    print("  positions   : %s" % positions)
    print("  open orders : %d" % len(open_orders))
    if expected is not None:
        reconciliation = broker.reconcile(expected)
        print("  reconciliation: %s" % ("matched" if reconciliation.matched else reconciliation.differences))
    print("  kill switch : %s" % ("ACTIVE" if broker.is_halted() else "clear"))
    return 0


def run_paper_plan(config_path: str, confirm: bool) -> int:
    config = load_config(config_path)
    broker = AlpacaPaperBroker.from_environment(config.paper_trading, config.risk)
    plan = build_paper_plan(config, broker)
    print("Paper plan (no orders submitted yet)")
    print("  signal date : %s" % plan.signal_timestamp.date())
    print("  equity      : %.2f" % plan.account.equity)
    print("  targets     : %s" % {key: round(value, 4) for key, value in plan.targets.items()})
    for order in plan.orders:
        print("  %s %s %.6f" % ("BUY" if order.quantity > 0 else "SELL", order.symbol, abs(order.quantity)))
    if confirm:
        order_ids = broker.submit_plan(plan.orders)
        current = broker.positions()
        expected = dict(current)
        for order in plan.orders:
            expected[order.symbol] = expected.get(order.symbol, 0.0) + order.quantity
        broker.save_expected_positions(expected)
        print("Submitted %d Alpaca paper orders: %s" % (len(order_ids), order_ids))
    else:
        print("Dry run only. Add --confirm-paper-orders to submit this plan to Alpaca paper.")
    return 0


def run_paper_kill_switch(config_path: str, halted: bool) -> int:
    config = load_config(config_path)
    broker = AlpacaPaperBroker.from_environment(config.paper_trading, config.risk)
    broker.set_halted(halted, "CLI manual halt" if halted else "CLI resume")
    print("Paper-trading kill switch %s." % ("activated" if halted else "cleared"))
    return 0


def _save_run_context(output_dir, config_path, config, market_data) -> None:
    destination = Path(output_dir)
    quality = data_quality_report(market_data)
    with (destination / "data_quality.json").open("w", encoding="utf-8") as handle:
        json.dump(quality, handle, indent=2, ensure_ascii=False, allow_nan=False)
    manifest = {
        "config_path": str(Path(config_path).resolve()),
        "config": asdict(config),
        "python": sys.version.split()[0],
        "platform": platform.platform(),
        "market_data_rows": len(market_data),
        "market_data_start": pd.Timestamp(market_data["timestamp"].min()).isoformat(),
        "market_data_end": pd.Timestamp(market_data["timestamp"].max()).isoformat(),
        "market_data_sha256": hashlib.sha256(
            pd.util.hash_pandas_object(market_data, index=True).values.tobytes()
        ).hexdigest(),
    }
    with (destination / "run_manifest.json").open("w", encoding="utf-8") as handle:
        json.dump(manifest, handle, indent=2, ensure_ascii=False, allow_nan=False)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Run a reproducible quantitative backtest")
    parser.add_argument("--config", default="configs/demo.yaml", help="YAML configuration path")
    parser.add_argument("--output", default="reports/demo", help="Report output directory")
    parser.add_argument(
        "--research", action="store_true", help="Run train/holdout parameter research and stress tests"
    )
    parser.add_argument(
        "--benchmark", action="store_true", help="Compare robust strategy baselines and regimes"
    )
    paper_group = parser.add_mutually_exclusive_group()
    paper_group.add_argument("--paper-status", action="store_true", help="Read Alpaca paper account, clock and positions")
    paper_group.add_argument("--paper-plan", action="store_true", help="Create an Alpaca-priced daily order plan (dry run)")
    paper_group.add_argument("--paper-halt", action="store_true", help="Activate local paper-trading kill switch")
    paper_group.add_argument("--paper-resume", action="store_true", help="Clear local paper-trading kill switch")
    parser.add_argument("--confirm-paper-orders", action="store_true", help="Explicitly submit --paper-plan to Alpaca paper")
    add_dashboard_arguments(parser)
    return parser


def main(argv: Optional[Sequence[str]] = None) -> int:
    args = build_parser().parse_args(argv)
    if args.confirm_paper_orders and not args.paper_plan:
        raise ValueError("--confirm-paper-orders requires --paper-plan")
    if args.dashboard:
        return serve_dashboard(
            args.dashboard_report or args.output,
            args.config,
            args.dashboard_host,
            args.dashboard_port,
        )
    if args.paper_status:
        return run_paper_status(args.config)
    if args.paper_plan:
        return run_paper_plan(args.config, args.confirm_paper_orders)
    if args.paper_halt:
        return run_paper_kill_switch(args.config, True)
    if args.paper_resume:
        return run_paper_kill_switch(args.config, False)
    if args.research:
        return run_research(args.config, args.output)
    if args.benchmark:
        return run_benchmark(args.config, args.output)
    return run(args.config, args.output)


if __name__ == "__main__":
    raise SystemExit(main())
