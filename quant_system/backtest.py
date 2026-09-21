"""Daily-bar event-driven backtest engine."""

import json
from collections import defaultdict
from dataclasses import dataclass
from pathlib import Path
from typing import Any, DefaultDict, Dict, List, Optional, Tuple

import numpy as np
import pandas as pd

from .config import SystemConfig
from .data import validate_bars
from .performance import calculate_metrics
from .risk import RiskManager
from .strategies.base import Strategy


@dataclass
class BacktestResult:
    equity_curve: pd.DataFrame
    trades: pd.DataFrame
    positions: pd.DataFrame
    metrics: Dict[str, Any]

    def save(self, output_dir: str) -> None:
        destination = Path(output_dir)
        destination.mkdir(parents=True, exist_ok=True)
        self.equity_curve.to_csv(destination / "equity_curve.csv", index_label="timestamp")
        self.trades.to_csv(destination / "trades.csv", index=False)
        self.positions.to_csv(destination / "positions.csv", index=False)
        monthly = self.equity_curve["equity"].resample(pd.offsets.MonthEnd()).last().pct_change().dropna()
        monthly.rename("return").to_csv(destination / "monthly_returns.csv", index_label="timestamp")
        with (destination / "metrics.json").open("w", encoding="utf-8") as handle:
            json.dump(self.metrics, handle, indent=2, ensure_ascii=False, allow_nan=False)
        with (destination / "tearsheet.md").open("w", encoding="utf-8") as handle:
            handle.write(self._tearsheet())

    def _tearsheet(self) -> str:
        pct = lambda key: "%.2f%%" % (100.0 * float(self.metrics[key]))
        return "\n".join(
            [
                "# 回测报告",
                "",
                "| 指标 | 结果 |",
                "|---|---:|",
                "| 总收益 | %s |" % pct("total_return"),
                "| 基准收益 | %s |" % pct("benchmark_return"),
                "| 基准 CAGR | %s |" % pct("benchmark_cagr"),
                "| 超额收益 | %s |" % pct("excess_return"),
                "| CAGR | %s |" % pct("cagr"),
                "| 年化波动率 | %s |" % pct("annual_volatility"),
                "| 最大回撤 | %s |" % pct("max_drawdown"),
                "| Sharpe | %.3f |" % self.metrics["sharpe_ratio"],
                "| 基准 Sharpe | %.3f |" % self.metrics["benchmark_sharpe_ratio"],
                "| 基准最大回撤 | %s |" % pct("benchmark_max_drawdown"),
                "| Sortino | %.3f |" % self.metrics["sortino_ratio"],
                "| Calmar | %.3f |" % self.metrics["calmar_ratio"],
                "| 交易笔数 | %d |" % self.metrics["trade_count"],
                "| 佣金 | %.2f |" % self.metrics["total_commission"],
                "| 观测最大单仓 | %.2f%% |"
                % (100 * self.metrics.get("max_observed_position_weight", 0.0)),
                "| 观测最大总敞口 | %.3f |"
                % self.metrics.get("max_observed_gross_leverage", 0.0),
                "",
                "> 历史回测不代表未来收益；必须结合样本外、压力测试和模拟盘结果判断。",
                "",
            ]
        )


class Backtester:
    """Execute close-generated target weights at the next available open."""

    def __init__(self, config: SystemConfig, strategy: Strategy) -> None:
        self.config = config
        self.strategy = strategy
        self.risk = RiskManager(config.risk)

    def run(self, market_data: pd.DataFrame) -> BacktestResult:
        data = validate_bars(market_data)
        cash = float(self.config.engine.initial_cash)
        positions: DefaultDict[str, float] = defaultdict(float)
        last_prices: Dict[str, float] = {}
        pending_targets: Optional[Dict[str, float]] = None
        trades: List[Dict[str, Any]] = []
        records: List[Dict[str, Any]] = []
        position_records: List[Dict[str, Any]] = []
        peak_equity = cash
        current_drawdown = 0.0
        halt_remaining = 0
        equity_returns: List[float] = []
        previous_equity = cash
        first_closes: Dict[str, float] = {}

        for timestamp, rows in data.groupby("timestamp", sort=True):
            bars = {str(row["symbol"]): row for _, row in rows.iterrows()}
            if records:
                if cash > 0:
                    cash += cash * self.config.costs.annual_cash_rate / 252.0
                elif cash < 0:
                    cash -= abs(cash) * self.config.costs.annual_margin_rate / 252.0
                short_value = sum(
                    abs(quantity * last_prices[symbol])
                    for symbol, quantity in positions.items()
                    if quantity < 0 and symbol in last_prices
                )
                cash -= short_value * self.config.costs.annual_borrow_rate / 252.0
            open_prices = {symbol: float(bar["open"]) for symbol, bar in bars.items()}
            last_prices.update(open_prices)

            if pending_targets is not None:
                equity_at_open = self._mark_to_market(cash, positions, last_prices)
                lookback = self.config.risk.volatility_lookback
                fast_lookback = self.config.risk.fast_volatility_lookback
                realized_volatility = None
                if len(equity_returns) >= lookback:
                    slow_volatility = float(
                        np.std(equity_returns[-lookback:], ddof=1) * np.sqrt(252.0)
                    )
                    fast_volatility = float(
                        np.std(equity_returns[-fast_lookback:], ddof=1) * np.sqrt(252.0)
                    )
                    realized_volatility = max(slow_volatility, fast_volatility)
                if current_drawdown <= -self.config.risk.max_drawdown and halt_remaining == 0:
                    halt_remaining = self.config.risk.drawdown_cooldown_days
                if halt_remaining > 0:
                    safe_targets = self.risk.adjust_targets(
                        pending_targets, -self.config.risk.max_drawdown, realized_volatility
                    )
                    halt_remaining -= 1
                    if halt_remaining == 0:
                        peak_equity = equity_at_open
                        current_drawdown = 0.0
                else:
                    safe_targets = self.risk.adjust_targets(
                        pending_targets, current_drawdown, realized_volatility
                    )
                cash = self._rebalance(
                    timestamp=pd.Timestamp(timestamp),
                    targets=safe_targets,
                    equity=equity_at_open,
                    open_prices=open_prices,
                    bars=bars,
                    positions=positions,
                    cash=cash,
                    trades=trades,
                )

            close_prices = {symbol: float(bar["close"]) for symbol, bar in bars.items()}
            last_prices.update(close_prices)
            for symbol, price in close_prices.items():
                first_closes.setdefault(symbol, price)
            equity = self._mark_to_market(cash, positions, last_prices)
            gross_exposure = sum(abs(qty * last_prices[symbol]) for symbol, qty in positions.items())
            net_exposure = sum(qty * last_prices[symbol] for symbol, qty in positions.items())
            peak_equity = max(peak_equity, equity)
            current_drawdown = equity / peak_equity - 1.0
            daily_return = equity / previous_equity - 1.0
            equity_returns.append(float(daily_return))
            previous_equity = equity
            benchmark_equity = self.config.engine.initial_cash * float(
                np.mean([last_prices[symbol] / price for symbol, price in first_closes.items()])
            )
            records.append(
                {
                    "timestamp": pd.Timestamp(timestamp),
                    "equity": equity,
                    "cash": cash,
                    "gross_exposure": gross_exposure,
                    "net_exposure": net_exposure,
                    "drawdown": current_drawdown,
                    "benchmark_equity": benchmark_equity,
                    "risk_halt": bool(halt_remaining > 0),
                }
            )
            for symbol, quantity in sorted(positions.items()):
                if quantity:
                    position_records.append(
                        {
                            "timestamp": pd.Timestamp(timestamp),
                            "symbol": symbol,
                            "quantity": quantity,
                            "close": last_prices[symbol],
                            "market_value": quantity * last_prices[symbol],
                            "weight": quantity * last_prices[symbol] / equity,
                        }
                    )

            pending_targets = self.strategy.on_bar(pd.Timestamp(timestamp), bars)

        equity_curve = pd.DataFrame(records).set_index("timestamp")
        trade_columns = [
            "timestamp",
            "symbol",
            "side",
            "quantity",
            "price",
            "notional",
            "commission",
            "reference_price",
            "impact_cost",
            "participation_rate",
            "fill_ratio",
        ]
        trade_frame = pd.DataFrame(trades, columns=trade_columns)
        position_frame = pd.DataFrame(
            position_records,
            columns=["timestamp", "symbol", "quantity", "close", "market_value", "weight"],
        )
        metrics = calculate_metrics(
            equity_curve, trade_frame, self.config.costs.annual_cash_rate
        )
        metrics.update(
            {
                "target_max_position_weight": self.config.risk.max_position_weight,
                "max_observed_position_weight": float(position_frame["weight"].abs().max())
                if not position_frame.empty
                else 0.0,
                "target_max_gross_leverage": self.config.risk.max_gross_leverage,
                "max_observed_gross_leverage": float(
                    (equity_curve["gross_exposure"] / equity_curve["equity"]).max()
                ),
            }
        )
        return BacktestResult(
            equity_curve=equity_curve,
            trades=trade_frame,
            positions=position_frame,
            metrics=metrics,
        )

    @staticmethod
    def _mark_to_market(
        cash: float, positions: Dict[str, float], prices: Dict[str, float]
    ) -> float:
        missing = [symbol for symbol, qty in positions.items() if qty and symbol not in prices]
        if missing:
            raise ValueError("No price available for held symbols: %s" % sorted(missing))
        return float(cash + sum(qty * prices[symbol] for symbol, qty in positions.items()))

    def _rebalance(
        self,
        timestamp: pd.Timestamp,
        targets: Dict[str, float],
        equity: float,
        open_prices: Dict[str, float],
        bars: Dict[str, pd.Series],
        positions: DefaultDict[str, float],
        cash: float,
        trades: List[Dict[str, Any]],
    ) -> float:
        symbols = set(targets) | {symbol for symbol, qty in positions.items() if qty != 0}
        orders: List[Tuple[str, float]] = []
        for symbol in symbols:
            if symbol not in open_prices:
                continue
            desired_quantity = equity * targets.get(symbol, 0.0) / open_prices[symbol]
            if not self.config.engine.allow_fractional:
                desired_quantity = float(np.trunc(desired_quantity))
            delta = desired_quantity - positions[symbol]
            current_weight = positions[symbol] * open_prices[symbol] / equity
            if abs(targets.get(symbol, 0.0) - current_weight) >= self.config.engine.rebalance_threshold:
                orders.append((symbol, delta))

        # Sell orders precede buys, releasing cash before it is reused.
        orders.sort(key=lambda item: (item[1] > 0, item[0]))
        slippage = self.config.costs.slippage_bps / 10_000.0
        spread = self.config.costs.spread_bps / 20_000.0
        turnover_budget = equity * self.config.risk.max_daily_turnover
        for symbol, requested_quantity in orders:
            reference_price = open_prices[symbol]
            volume_cap = float(bars[symbol]["volume"]) * self.config.risk.max_volume_participation
            quantity = np.sign(requested_quantity) * min(abs(requested_quantity), volume_cap)
            remaining_notional = max(0.0, turnover_budget)
            quantity = np.sign(quantity) * min(abs(quantity), remaining_notional / reference_price)
            if quantity == 0:
                continue
            participation = abs(quantity) / max(float(bars[symbol]["volume"]), 1.0)
            daily_range = max(
                0.0, (float(bars[symbol]["high"]) - float(bars[symbol]["low"])) / reference_price
            )
            impact = self.config.costs.market_impact * np.sqrt(participation) * daily_range
            direction = 1.0 if quantity > 0 else -1.0
            execution_price = reference_price * (1.0 + direction * (slippage + spread + impact))
            notional = quantity * execution_price
            commission = max(
                self.config.costs.minimum_commission,
                abs(notional) * self.config.costs.commission_rate,
            )
            if quantity < 0:
                commission += abs(notional) * self.config.costs.sell_tax_rate
            if quantity > 0 and not self.config.risk.allow_short:
                reserved_cash = equity * self.config.engine.cash_buffer
                affordable = max(0.0, cash - reserved_cash - commission) / execution_price
                if affordable < quantity:
                    quantity = affordable
                    notional = quantity * execution_price
                    commission = max(
                        self.config.costs.minimum_commission,
                        abs(notional) * self.config.costs.commission_rate,
                    )
                if quantity <= 1e-12:
                    continue
            cash -= notional + commission
            positions[symbol] += quantity
            if abs(positions[symbol]) < 1e-12:
                positions[symbol] = 0.0
            trades.append(
                {
                    "timestamp": timestamp,
                    "symbol": symbol,
                    "side": "BUY" if quantity > 0 else "SELL",
                    "quantity": abs(float(quantity)),
                    "price": float(execution_price),
                    "notional": abs(float(notional)),
                    "commission": float(commission),
                    "reference_price": float(reference_price),
                    "impact_cost": float(abs(quantity) * abs(execution_price - reference_price)),
                    "participation_rate": float(participation),
                    "fill_ratio": float(abs(quantity / requested_quantity)),
                }
            )
            turnover_budget -= abs(notional)
        return float(cash)
